import { createParallelContract } from './contract.mjs'

/** Build the browser helpers without closing over any Node or Host state. */
export function createParallelClient({
  brokerMuxPath, capabilityHeader, capabilityQuery, hostKey, isCapability, isHostIdentity,
  isRemoteApi, managementPrefix,
}) {
  function localEndpoint(input, base) {
    const target = new URL(input, base)
    if (target.protocol !== base.protocol || target.host !== base.host || target.username || target.password ||
      target.hash || target.pathname.includes('%') || target.searchParams.has(capabilityQuery)) {
      throw new Error('The SSH channel requires a same-origin DSH API URL.')
    }
    return target
  }

  async function post(fetch, base, path, body, signal) {
    const response = await fetch(new URL(path, base).href, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      redirect: 'error',
    })
    const result = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw Object.assign(new Error(result?.error ?? 'The SSH broker rejected the request.'), {
        code: result?.code, status: response.status,
      })
    }
    if (!result || typeof result !== 'object') throw new Error('The SSH broker returned an invalid response.')
    return result
  }

  /** Read the local configured Host projection. The broker keeps Peer credentials private. */
  async function listParallelHosts({ transport = {}, baseUrl = globalThis.document?.baseURI, signal } = {}) {
    const fetch = transport.fetch?.bind(transport) ?? globalThis.fetch.bind(globalThis)
    const response = await fetch(new URL('/api/remote-ssh/hosts', baseUrl).href, { signal, redirect: 'error' })
    if (!response.ok) throw new Error('无法读取 SSH 主机列表。')
    const result = await response.json()
    if (!Array.isArray(result?.hosts)) throw new Error('SSH 主机列表无效。')
    return result.hosts
  }

  async function configureParallelHost({ action, data, transport = {}, baseUrl = globalThis.document?.baseURI, signal }) {
    const fetch = transport.fetch?.bind(transport) ?? globalThis.fetch.bind(globalThis)
    if (action === 'discover') {
      const response = await fetch(new URL('/api/remote-ssh/discover', baseUrl).href, { signal, redirect: 'error' })
      if (!response.ok) throw new Error('无法读取本机 SSH 别名。')
      const result = await response.json()
      if (!Array.isArray(result?.aliases)) throw new Error('SSH 别名列表无效。')
      return result.aliases
    }
    if (!['save', 'remove'].includes(action)) throw new Error('不支持此 SSH 配置操作。')
    return post(fetch, baseUrl, '/api/remote-ssh/hosts/' + action, data, signal)
  }

  /** Obtain a Host transport for one broker lease. A password is used only for this open request. */
  async function openParallelHost({ id, expected, password, transport = {}, baseUrl = globalThis.document?.baseURI, signal }) {
    const base = new URL(baseUrl)
    const streamBase = new URL(transport.streamBaseUrl ?? base)
    if (!['http:', 'https:'].includes(streamBase.protocol) || streamBase.username || streamBase.password ||
      streamBase.pathname !== '/' || streamBase.search || streamBase.hash) {
      throw new Error('An authenticated local WebSocket base is required.')
    }
    const socketBase = new URL(streamBase)
    socketBase.protocol = streamBase.protocol === 'https:' ? 'wss:' : 'ws:'
    const fetch = transport.fetch?.bind(transport) ?? globalThis.fetch.bind(globalThis)
    const createWebSocket = transport.createWebSocket?.bind(transport) ?? (url => new WebSocket(url))
    if (expected !== undefined && !isHostIdentity(expected)) throw new Error('The expected SSH Host identity is invalid.')
    async function authorize(identity, signal, password) {
      const expected = identity && { hostId: identity.hostId, instanceId: identity.instanceId }
      const descriptor = await post(fetch, base, managementPrefix + 'open', { id, expected, password }, signal)
      if (descriptor.id !== id || !isCapability(descriptor.capability) || !isHostIdentity(descriptor) ||
        (expected !== undefined && hostKey(expected) !== hostKey(descriptor))) {
        throw new Error('The SSH broker returned an invalid Host binding.')
      }
      return { ...descriptor, controller: new AbortController() }
    }
    const lifetime = new AbortController()
    let lease = await authorize(expected, signal, password)
    const { hostId, instanceId, label, version } = lease
    const identity = { hostId, instanceId }
    const leaseListeners = new Set()
    const publishLease = () => { for (const listener of leaseListeners) listener() }
    const observeLease = binding => {
      binding.controller.signal.addEventListener('abort', () => {
        if (lease === binding) publishLease()
      }, { once: true })
    }
    observeLease(lease)

    function endpoint(input) {
      const target = localEndpoint(input, base)
      if (!isRemoteApi(target.pathname)) throw new Error('The SSH channel requires a Host API route.')
      return target
    }
    function release(binding) {
      binding.controller.abort()
      binding.closing ??= post(fetch, base, managementPrefix + 'close', { capability: binding.capability }).catch(error => {
        binding.closing = undefined
        throw error
      })
      return binding.closing
    }
    let recovering
    let disposal
    return Object.freeze({
      hostKey: hostKey(identity), id, hostId, instanceId, label, version,
      get bootId() { return lease.bootId },
      signal: lifetime.signal,
      leaseAvailable: Object.freeze({
        getSnapshot: () => !lease.controller.signal.aborted,
        subscribe(listener) {
          leaseListeners.add(listener)
          return () => leaseListeners.delete(listener)
        },
      }),
      transport: Object.freeze({
        streamBaseUrl: streamBase.href,
        fetch(input, init = {}) {
          const binding = lease
          binding.controller.signal.throwIfAborted()
          const target = endpoint(input)
          const headers = new Headers(init.headers)
          headers.set(capabilityHeader, binding.capability)
          const signal = init.signal ? AbortSignal.any([binding.controller.signal, init.signal]) : binding.controller.signal
          return fetch(target.href, { ...init, signal, headers, redirect: 'error' })
        },
        createWebSocket(input) {
          const binding = lease
          binding.controller.signal.throwIfAborted()
          if (binding.socket) throw new Error('The SSH lease already owns a mux socket.')
          const target = localEndpoint(input, socketBase)
          if (target.pathname !== '/api/remote.mux' || target.search) throw new Error('Unexpected DSH mux URL.')
          target.pathname = brokerMuxPath
          target.searchParams.set(capabilityQuery, binding.capability)
          const socket = createWebSocket(target.href)
          binding.socket = socket
          socket.addEventListener('close', () => binding.controller.abort(), { once: true })
          return socket
        },
      }),
      resourceUrl(input) {
        const target = endpoint(input)
        target.searchParams.set(capabilityQuery, lease.capability)
        return target.href
      },
      reconnect({ signal, password } = {}) {
        lifetime.signal.throwIfAborted()
        const setup = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
        setup.throwIfAborted()
        recovering ??= (async () => {
          const previous = lease
          await release(previous)
          setup.throwIfAborted()
          const replacement = await authorize(identity, setup, password)
          if (setup.aborted) {
            await release(replacement)
            setup.throwIfAborted()
          }
          lease = replacement
          observeLease(lease)
          publishLease()
          return { bootChanged: previous.bootId !== replacement.bootId }
        })().finally(() => { recovering = undefined })
        return recovering
      },
      close() {
        lifetime.abort()
        disposal ??= (async () => {
          await recovering?.catch(() => {})
          await release(lease)
        })().catch(error => {
          disposal = undefined
          throw error
        })
        return disposal
      },
    })
  }

  return { openParallelHost, listParallelHosts, configureParallelHost }
}

export const { openParallelHost, listParallelHosts, configureParallelHost } = createParallelClient(createParallelContract())
