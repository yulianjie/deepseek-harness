import { createHash } from 'node:crypto'
import http from 'node:http'
import { ConnectionError } from '../connection/ssh.mjs'
import { DSH_VERSION as version, REMOTE_API_PREFIX as companionPrefix } from '../remote/index.mjs'

export const muxPath = '/api/remote.mux'

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const localHost = '127.0.0.1'
const upstreamHeaders = ['accept', 'content-type', 'content-length', 'range', 'if-range']
const downstreamHeaders = [
  'content-type', 'content-encoding', 'content-length', 'content-disposition',
  'content-range', 'accept-ranges', 'content-security-policy', 'x-content-type-options',
]
const websocketHeaders = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']
const readPaths = new Set([
  '/api/file', '/api/session.export', '/api/changes.summary', '/api/changes.diff', '/api/present.host',
])
const rawPosts = new Set(['/api/session/uploadFileBinary'])
const companionMethods = new Map([
  [`${companionPrefix}/files`, ['GET', 'PUT']],
  [`${companionPrefix}/directories`, ['GET', 'POST']],
  [`${companionPrefix}/git`, ['GET']],
])

export function nativeError(code, message, status = 409) {
  return Object.assign(new ConnectionError(code, message), { status })
}

export function offline() {
  return nativeError('NATIVE_REMOTE_OFFLINE', '远程 Harness 已断开。请重新连接或返回本地。', 503)
}

function pick(headers, keys) {
  return Object.fromEntries(keys.filter(key => typeof headers[key] === 'string').map(key => [key, headers[key]]))
}

function makeRequest(upstream, path, options = {}) {
  const { headers, ...rest } = options
  return http.request({
    host: localHost, port: upstream.port, path, agent: false, ...rest,
    headers: { host: upstream.authority, ...(upstream.cookie && { cookie: upstream.cookie }), ...headers },
  })
}

function probe(upstream, path, signal, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    const request = makeRequest(upstream, path, { method: 'GET', signal })
    request.once('error', reject)
    request.once('response', async response => {
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of response) {
          bytes += chunk.byteLength
          if (bytes > maxBytes) throw new Error('Host response too large')
          chunks.push(chunk)
        }
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })
      } catch (error) {
        reject(error)
      }
    })
    request.end()
  })
}

/** Attach an idle mux so rc.5 can release an unclaimed Peer on close. */
function claimNativePeer(upstream, lifetime, handshakeSignal) {
  return new Promise((resolve, reject) => {
    lifetime.throwIfAborted()
    handshakeSignal.throwIfAborted()
    const socket = new WebSocket(`ws://${upstream.authority}${muxPath}`, { headers: { cookie: upstream.cookie } })
    const stop = () => {
      socket.close()
      reject(offline())
    }
    lifetime.addEventListener('abort', stop, { once: true })
    handshakeSignal.addEventListener('abort', stop, { once: true })
    socket.addEventListener('error', stop, { once: true })
    socket.addEventListener('close', () => {
      lifetime.removeEventListener('abort', stop)
      handshakeSignal.removeEventListener('abort', stop)
      reject(offline())
    }, { once: true })
    socket.addEventListener('open', () => {
      handshakeSignal.removeEventListener('abort', stop)
      resolve()
    }, { once: true })
  })
}

/** Best-effort release for an answer Peer whose renderer never attached. */
export async function releaseNative(upstream, lifetime) {
  if (!upstream?.cookie) return
  const release = new AbortController()
  const signal = AbortSignal.any([lifetime, release.signal])
  try {
    await claimNativePeer(upstream, signal, AbortSignal.any([signal, AbortSignal.timeout(1500)]))
  } catch {
    // A closing tunnel or a claimed/closed Peer needs no further release.
  } finally {
    release.abort()
  }
}

/** Authenticate over the SSH forward as a separate API Peer and verify the boot identity. */
export async function authorizeNative(target, lifetime) {
  const { port, token, hostId, instanceId, bootId } = target
  if (target.version !== version || ![hostId, instanceId, bootId].every(id => uuid.test(id)) ||
    !Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw nativeError('NATIVE_INCOMPATIBLE', '远程 Harness 版本或实例身份不兼容。')
  }
  const upstream = { port, authority: `${localHost}:${port}` }
  const signal = AbortSignal.any([target.signal, lifetime, AbortSignal.timeout(12_000)])
  const query = new URLSearchParams({ token, interactions: 'answer' })
  const cookieName = `dsh-auth-${createHash('sha256').update(upstream.authority).digest('base64url')}`
  try {
    const login = await probe(upstream, `/connect?${query}`, signal)
    const cookie = (login.headers['set-cookie'] ?? []).map(value => value.split(';', 1)[0])
      .find(value => value.startsWith(`${cookieName}=`))
    if (login.status !== 302 || login.headers.location !== './api/remote.mux' || !cookie) {
      throw nativeError('NATIVE_REMOTE_AUTH', '远程 Harness 拒绝了原生连接。')
    }
    upstream.cookie = cookie
    const result = await probe(upstream, companionPrefix + '/instance', signal)
    const identity = result.status === 200 ? JSON.parse(result.body) : undefined
    if (identity?.protocolVersion !== 1 || identity.hostId !== hostId || identity.instanceId !== instanceId ||
      identity.bootId !== bootId || identity.version !== version) {
      throw nativeError('NATIVE_IDENTITY_MISMATCH', 'SSH 转发返回了不同的 Harness 实例。')
    }
    signal.throwIfAborted()
    return upstream
  } catch (error) {
    if (upstream.cookie) void releaseNative(upstream, target.signal)
    if (error instanceof ConnectionError) throw error
    throw offline()
  }
}

export function requestPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return
  try {
    const target = new URL(url, 'http://127.0.0.1')
    if (!target.hash && !target.pathname.includes('%')) return target
  } catch {
    // Invalid targets never reach the upstream.
  }
}

export function isCompanionPath(pathname) {
  return pathname === companionPrefix || pathname?.startsWith(companionPrefix + '/')
}

function isJsonRequest(req) {
  return req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

export function canForward(req, { pathname }) {
  if (!pathname.startsWith('/api/')) return false
  if (isCompanionPath(pathname)) {
    return companionMethods.get(pathname)?.includes(req.method) === true &&
      (req.method === 'GET' || isJsonRequest(req))
  }
  if (req.method === 'GET' || req.method === 'HEAD') return readPaths.has(pathname)
  return req.method === 'POST' && (rawPosts.has(pathname) || isJsonRequest(req))
}

export function sendNativeError(res, error) {
  if (res.destroyed) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  const { status = 503, code, message } = error
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', connection: 'close',
  })
  res.end(JSON.stringify({ error: message, code }))
}

/** Backpressured, single-attempt HTTP relay. Neither Host cookies nor redirects cross into the renderer. */
export function forwardHttp(req, res, path, upstream, signal, onLost) {
  return new Promise(resolve => {
    const outgoing = makeRequest(upstream, path.pathname + path.search, {
      method: req.method, headers: pick(req.headers, upstreamHeaders), signal,
    })
    let clientGone = false
    const stopSending = () => {
      clientGone = true
      req.unpipe(outgoing)
      outgoing.destroy()
    }
    const closed = () => {
      stopSending()
      req.off('aborted', stopSending)
      req.off('error', stopSending)
      resolve()
    }
    res.once('close', closed)
    req.once('aborted', stopSending)
    req.once('error', stopSending)
    outgoing.once('error', () => {
      if (clientGone || res.destroyed) return
      if (!signal.aborted) onLost()
      sendNativeError(res, offline())
    })
    outgoing.once('response', response => {
      if (response.statusCode === 401) {
        response.destroy()
        onLost()
        sendNativeError(res, offline())
        return
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy()
        sendNativeError(res, nativeError('NATIVE_REDIRECT_BLOCKED', '原生连接拒绝了远程重定向。', 502))
        return
      }
      const headers = pick(response.headers, downstreamHeaders)
      headers['content-security-policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
      if (response.headers.connection === 'close' && !req.readableEnded) headers.connection = 'close'
      res.writeHead(response.statusCode, {
        ...headers, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      })
      response.once('error', () => res.destroy())
      response.pipe(res)
    })
    req.pipe(outgoing)
  })
}

export function rejectUpgrade(socket, status) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
}

/** Relay the existing Gateway mux byte for byte under the same API Peer as HTTP. */
export function forwardMux(req, socket, head, upstream, signal, onReady, onLost) {
  if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
    !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] ?? '') || req.headers['sec-websocket-version'] !== '13') {
    rejectUpgrade(socket, 400)
    return false
  }
  socket.pause()
  const headers = pick(req.headers, websocketHeaders)
  const outgoing = makeRequest(upstream, muxPath, {
    method: 'GET', headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket' }, signal,
  })
  let remoteSocket
  const abort = () => {
    outgoing.destroy()
    remoteSocket?.destroy()
    socket.destroy()
  }
  const fail = () => {
    rejectUpgrade(socket, 502)
    onLost()
  }
  signal.addEventListener('abort', abort, { once: true })
  socket.once('close', () => {
    signal.removeEventListener('abort', abort)
    outgoing.destroy()
    remoteSocket?.destroy()
    if (!signal.aborted) onLost()
  })
  outgoing.setTimeout(10_000, () => outgoing.destroy())
  outgoing.once('error', fail)
  outgoing.once('response', response => {
    response.destroy()
    fail()
  })
  outgoing.once('upgrade', (response, remote, initial) => {
    remoteSocket = remote
    const accept = createHash('sha1').update(headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    if (signal.aborted || socket.destroyed || response.statusCode !== 101 ||
      response.headers['sec-websocket-accept'] !== accept || !onReady()) {
      remote.destroy()
      fail()
      return
    }
    remote.setTimeout(0)
    remote.once('error', () => socket.destroy())
    remote.once('close', () => socket.destroy())
    const accepted = pick(response.headers, ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'])
    const lines = Object.entries(accepted).map(([key, value]) => `${key}: ${value}`)
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket', ...lines, '', ''].join('\r\n'))
    if (initial.length) socket.write(initial)
    if (head.length) remote.write(head)
    socket.pipe(remote)
    remote.pipe(socket)
  })
  outgoing.end()
  return true
}
