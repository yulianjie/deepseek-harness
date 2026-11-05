import { randomBytes } from 'node:crypto'
import {
  authorizeNative, canForward, forwardHttp, forwardMux, nativeError, rejectUpgrade,
  releaseNative, requestPath, sendNativeError,
} from '../transport/index.mjs'
import {
  brokerMuxPath, capabilityHeader, capabilityQuery, hostKey, isCapability, isHostIdentity,
  isRemoteApi, sshApiPrefix,
} from './contract.mjs'

const attachTimeoutMs = 45_000
const unavailable = () => nativeError('PARALLEL_UNAVAILABLE', '此 Host 的原生连接暂不可用。', 503)
const stale = () => nativeError('PARALLEL_CAPABILITY_STALE', '此 Host 连接已失效，请重新连接。')
const browserRequired = () => nativeError('PARALLEL_BROWSER_REQUIRED', '此操作需要已验证的本地窗口。', 403)

function admittedBrowser(connection, req) {
  return connection.browserPeer !== undefined && connection.admit(req).peer === connection.browserPeer
}

function queryCapabilities(url) {
  const queryStart = url?.indexOf('?') ?? -1
  return queryStart < 0 ? [] : new URLSearchParams(url.slice(queryStart + 1)).getAll(capabilityQuery)
}

function targetsManagement(url) {
  try {
    // Use the same URL normalization as the Host's HTTP bridge, including
    // forms we deliberately refuse to forward through an SSH capability.
    return new URL(url ?? '/', 'http://dsh.internal').pathname.startsWith(sshApiPrefix)
  } catch {
    return false
  }
}

async function waitForAttachment(response, channel) {
  if (response.destroyed) return false
  const closed = Promise.withResolvers()
  const cancel = () => closed.resolve(false)
  response.once('close', cancel)
  try {
    return await Promise.race([channel.attached.promise, closed.promise])
  } finally {
    response.off('close', cancel)
  }
}

/** A registry of independent answer Peers on the trusted local carrier. */
export class ParallelHostBroker {
  #manager
  #availability
  #disposed = false
  #channels = new Map()
  #identities = new Map()
  #capabilities = new Map()
  #retired = new Map()
  #closing = new Set()
  #releases = new Set()

  constructor(manager) {
    this.#manager = manager
  }

  enable() {
    if (!this.#disposed) this.#availability ??= new AbortController()
  }

  disable() {
    this.#availability?.abort()
    this.#availability = undefined
  }

  async open(id, expected, signal, { password } = {}) {
    const availability = this.#availability?.signal
    if (!availability || availability.aborted) throw unavailable()
    signal?.throwIfAborted()
    if (this.#channels.has(id) || this.#closing.has(id)) {
      throw nativeError('PARALLEL_CHANNEL_EXISTS', '此 SSH 连接已有原生渠道。')
    }
    const channel = { id, controller: new AbortController(), attached: Promise.withResolvers() }
    // A retired capability may disconnect its idle tunnel only until the next open starts.
    this.#retired.delete(id)
    this.#channels.set(id, channel)
    const setup = signal ? AbortSignal.any([availability, signal]) : availability
    let closing
    const cancel = () => {
      closing ??= this.#disconnect(id, channel).catch(() => {})
    }
    setup.addEventListener('abort', cancel, { once: true })
    try {
      const connection = this.#manager.connectNative(id, { password, expected })
      password = undefined
      const target = await connection
      setup.removeEventListener('abort', cancel)
      setup.throwIfAborted()
      channel.target = target
      if (!isHostIdentity(target) || (expected !== undefined && hostKey(expected) !== hostKey(target))) {
        cancel()
        throw nativeError('PARALLEL_IDENTITY_MISMATCH', 'SSH 配置指向了不同的 Harness 实例。')
      }
      channel.key = hostKey(target)
      if (this.#identities.has(channel.key)) {
        cancel()
        throw nativeError('PARALLEL_HOST_EXISTS', '此 Harness 实例已通过另一个 SSH 配置连接。')
      }
      this.#identities.set(channel.key, channel)
      channel.lifetime = AbortSignal.any([channel.controller.signal, availability, target.signal])
      const authorization = AbortSignal.any([channel.lifetime, setup])
      channel.upstream = await authorizeNative(target, authorization)
      authorization.throwIfAborted()
      channel.capability = randomBytes(32).toString('base64url')
      this.#capabilities.set(channel.capability, channel)
      channel.lifetime.addEventListener('abort', () => this.#retire(channel), { once: true })
      channel.attachTimer = setTimeout(() => this.#retire(channel), attachTimeoutMs)
      channel.attachTimer.unref()
      const { hostId, instanceId, bootId, version, label } = target
      return { id, hostId, instanceId, bootId, version, label, capability: channel.capability }
    } catch (error) {
      await this.#retire(channel)
      throw error
    } finally {
      setup.removeEventListener('abort', cancel)
      if (closing) await closing
    }
  }

  async close(capability) {
    if (!isCapability(capability)) throw stale()
    const channel = this.#capabilities.get(capability)
    if (channel) return this.#disconnect(channel.id, channel)
    for (const [id, retired] of this.#retired) {
      if (retired === capability && !this.#channels.has(id) && !this.#closing.has(id)) return this.#disconnect(id)
    }
  }

  async #disconnect(id, channel) {
    this.#closing.add(id)
    try {
      if (channel) await this.#retire(channel)
      await this.#manager.disconnect(id)
    } finally {
      this.#retired.delete(id)
      this.#closing.delete(id)
    }
  }

  #retire(channel) {
    if (this.#channels.get(channel.id) !== channel) return
    this.#channels.delete(channel.id)
    if (this.#identities.get(channel.key) === channel) this.#identities.delete(channel.key)
    if (channel.capability) {
      this.#capabilities.delete(channel.capability)
      this.#retired.set(channel.id, channel.capability)
    }
    clearTimeout(channel.attachTimer)
    channel.attached.resolve(false)
    channel.controller.abort()
    if (!channel.muxReady && channel.upstream) {
      const release = releaseNative(channel.upstream, channel.target.signal)
      this.#releases.add(release)
      void release.then(() => this.#releases.delete(release))
      return release
    }
  }

  #channel(capability) {
    const channel = isCapability(capability) && this.#capabilities.get(capability)
    if (!channel || channel.lifetime.aborted) throw stale()
    return channel
  }

  async request(req, res, next, connection) {
    const path = requestPath(req.url)
    const header = req.headers[capabilityHeader]
    const values = queryCapabilities(req.url)
    const management = path === undefined ? targetsManagement(req.url) : path.pathname.startsWith(sshApiPrefix)
    if (!management && header === undefined && values.length === 0) return next()
    try {
      if (!admittedBrowser(connection, req)) throw browserRequired()
      if (management && path && header === undefined && values.length === 0) return next()
      if (!path || !isRemoteApi(path.pathname) || values.length > 1 ||
        (values.length === 1 && (header !== undefined || !['GET', 'HEAD'].includes(req.method)))) throw stale()
      const channel = this.#channel(header ?? values[0])
      if (!canForward(req, path)) {
        throw nativeError('PARALLEL_ROUTE_UNAVAILABLE', '此 Host 渠道不支持该请求。', 404)
      }
      if (!channel.muxReady && !await waitForAttachment(res, channel)) throw unavailable()
      if (res.destroyed || channel.lifetime.aborted) throw unavailable()
      if (values.length === 1) path.searchParams.delete(capabilityQuery)
      await forwardHttp(req, res, path, channel.upstream, channel.lifetime, () => this.#retire(channel))
    } catch (error) {
      if (!Number.isInteger(error?.status)) throw error
      sendNativeError(res, error)
    }
  }

  upgrade(req, socket, head, connection) {
    if (!admittedBrowser(connection, req)) return rejectUpgrade(socket, 403)
    const path = requestPath(req.url)
    const values = path?.searchParams.getAll(capabilityQuery)
    if (path?.pathname !== brokerMuxPath || path.searchParams.size !== 1 || values?.length !== 1 ||
      req.headers[capabilityHeader] !== undefined) return rejectUpgrade(socket, 409)
    let channel
    try {
      channel = this.#channel(values[0])
    } catch (error) {
      return rejectUpgrade(socket, error.status)
    }
    if (channel.muxClaimed) return rejectUpgrade(socket, 409)
    channel.muxClaimed = forwardMux(req, socket, head, channel.upstream, channel.lifetime, () => {
      if (channel.lifetime.aborted) return false
      clearTimeout(channel.attachTimer)
      channel.muxReady = true
      channel.attached.resolve(true)
      return true
    }, () => this.#retire(channel))
  }

  async dispose() {
    this.#disposed = true
    this.disable()
    await Promise.all(this.#releases)
    await this.#manager.dispose()
    this.#retired.clear()
  }
}
