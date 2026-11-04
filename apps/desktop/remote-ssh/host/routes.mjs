import { installParallelCarrier } from './parallel/install.mjs'
import { isHostIdentity } from './parallel/contract.mjs'

const prefix = '/api/remote-ssh'
const responseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}
const maxBodyBytes = 4096

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function safeText(value, limit = 480) {
  return typeof value === 'string'
    ? value.replace(/\p{Cc}/gu, ' ').replace(/([?&](?:token|ticket)=)[^&\s]+/giu, '$1[redacted]').slice(0, limit)
    : undefined
}

function displayStatus(status = {}) {
  return {
    state: status.state ?? 'disconnected',
    stage: safeText(status.stage),
    hostId: safeText(status.hostId, 128),
    instanceId: safeText(status.instanceId, 128),
    version: safeText(status.version, 32),
    error: status.error && {
      code: safeText(status.error.code, 64),
      message: safeText(status.error.message),
    },
  }
}

function displayHost({ id, alias, label, instance }, manager) {
  return { id, alias, label, instance, status: displayStatus(manager.status(id)) }
}

async function jsonObject(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, '请求需要使用 JSON。')
  }
  if (Number(request.headers.get('content-length')) > maxBodyBytes) {
    throw new RequestError(413, '请求内容过长。')
  }
  if (!request.body) throw new RequestError(400, '请求内容无效。')
  const reader = request.body.getReader()
  const buffer = new Uint8Array(maxBodyBytes)
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.byteLength > maxBodyBytes) {
        throw new RequestError(413, '请求内容过长。')
      }
      buffer.set(value, size)
      size += value.byteLength
    }
  } finally {
    // The DSH carrier closes an unread streaming request after writing the response.
    reader.releaseLock()
  }
  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
  } catch {
    // Return the same client error for malformed text and non-object JSON.
  }
  throw new RequestError(400, '请求内容无效。')
}

function hostId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new RequestError(400, '主机 ID 无效。')
  }
  return value
}

function hostConfig({ id, alias, label, instance }) {
  if (typeof alias !== 'string' || alias.length > 255 || !alias.trim()) {
    throw new RequestError(400, '请填写有效的 SSH 别名。')
  }
  if (label !== undefined && (typeof label !== 'string' || label.length > 100)) {
    throw new RequestError(400, '主机名称最多 100 个字符。')
  }
  if (instance !== undefined && (typeof instance !== 'string' || instance.length > 64)) {
    throw new RequestError(400, '实例名称最多 64 个字符。')
  }
  return { id: id === undefined ? undefined : hostId(id), alias, label, instance }
}

/**
 * Register management endpoints on the Desktop's authenticated browser Peer.
 * The broker checks admission before the shared API dispatches these routes.
 */
export function registerSshRoutes(ctx, manager, broker) {
  const register = (path, method, action) => ctx.connection.fetch.register({
    path: prefix + path,
    methods: [method],
    requestBody: method === 'POST' ? 'streaming' : 'buffered',
    async fetch(request) {
      try {
        const body = method === 'POST' ? await jsonObject(request) : undefined
        const result = await action(body, request.signal)
        return Response.json(result, { headers: responseHeaders })
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 400
        return Response.json({
          error: safeText(error?.message) || '连接操作失败。',
          code: safeText(error?.code, 64),
        }, { status, headers: responseHeaders })
      }
    },
  })

  register('/hosts', 'GET', async () => ({
    hosts: (await manager.listHosts()).map(host => displayHost(host, manager)),
  }))
  register('/discover', 'GET', async () => ({
    aliases: (await manager.discover()).map(({ alias }) => alias),
  }))
  register('/hosts/save', 'POST', async body => ({
    host: displayHost(await manager.save(hostConfig(body)), manager),
  }))
  register('/hosts/remove', 'POST', async ({ id }) => {
    await manager.remove(hostId(id))
    return { ok: true }
  })
  installParallelCarrier(ctx, broker)
  register('/parallel/open', 'POST', ({ id, expected }, signal) => {
    if (expected !== undefined && (!isHostIdentity(expected) || Object.keys(expected).length !== 2)) {
      throw new RequestError(400, 'Harness 实例身份无效。')
    }
    return broker.open(hostId(id), expected, signal)
  })
  register('/parallel/close', 'POST', async ({ capability }) => {
    await broker.close(capability)
    return { ok: true }
  })
  ctx.effect(() => () => broker.dispose())
}
