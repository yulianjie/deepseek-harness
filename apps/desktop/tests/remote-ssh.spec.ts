import { once } from 'node:events'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished } from 'vitest'

it('limits SSH host management to the authenticated browser Peer', async () => {
  const entry = new URL('../remote-ssh/host/parallel/broker.mjs', import.meta.url).href
  const { ParallelHostBroker } = await import(/* @vite-ignore */ entry)
  const broker = new ParallelHostBroker({})
  const browserPeer = {}
  const independentOwnerPeer = {}
  const server = createServer((incoming, response) => {
    void broker.request(incoming, response, () => {
      // The connection HTTP bridge dispatches the normalized pathname.
      const { pathname } = new URL(incoming.url ?? '/', 'http://dsh.internal')
      response.end(pathname)
    }, {
      browserPeer,
      admit: () => ({ peer: incoming.headers.cookie === 'fixture=browser' ? browserPeer : independentOwnerPeer }),
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(() => { server.closeAllConnections(); server.close() })
  const { port } = server.address() as AddressInfo
  const status = (path: string, method: string, cookie: string): Promise<number | undefined> =>
    new Promise((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port, path, method, headers: { cookie } }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      outgoing.once('error', reject)
      outgoing.end()
    })

  for (const [path, method] of [
    ['/api/remote-ssh/hosts', 'GET'], ['/api/remote-ssh/discover', 'GET'],
    ['/api/remote-ssh/hosts/save', 'POST'], ['/api/remote-ssh/hosts/remove', 'POST'],
    ['/api/remote-ssh/parallel/open', 'POST'], ['/api/remote-ssh/parallel/close', 'POST'],
    ['http://dsh.internal/api/remote-ssh/hosts', 'GET'], ['/api/elsewhere/%2e%2e/remote-ssh/hosts', 'GET'],
  ] as const) {
    expect(await status(path, method, 'fixture=api')).toBe(403)
  }
  expect(await status('/api/remote-ssh/hosts', 'GET', 'fixture=browser')).toBe(200)
  expect(await status('/api/session.export', 'GET', 'fixture=api')).toBe(200)
})
