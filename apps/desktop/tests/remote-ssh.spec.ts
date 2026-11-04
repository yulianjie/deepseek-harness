import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

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

it('keeps legacy SSH profiles and stores only authentication metadata', async () => {
  const entry = new URL('../remote-ssh/host/connection/index.mjs', import.meta.url).href
  const { ConnectionManager, OpenSsh, buildSshArgs } = await import(/* @vite-ignore */ entry)
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-profile-'))
  const manager = new ConnectionManager({ stateDir: root, deploy: vi.fn() })
  onTestFinished(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = randomUUID()
  const profile = join(root, 'hosts', `${id}.json`)
  const legacy = { id, alias: 'fixture', label: 'Fixture', instance: 'default' }
  await mkdir(join(root, 'hosts'))
  await writeFile(profile, JSON.stringify(legacy))
  expect(await manager.listHosts()).toEqual([{ ...legacy, authMode: 'config' }])

  await expect(manager.save({ id, alias: 'fixture', authMode: 'key', identityFile: 'relative' }))
    .rejects.toMatchObject({ code: 'INVALID_IDENTITY_FILE' })
  const identityFile = join(root, 'private key 中文')
  const host = await manager.save({ id, alias: 'fixture', authMode: 'key', identityFile })
  expect(host).toEqual({ ...legacy, authMode: 'key', identityFile })
  const keyArgs = buildSshArgs(host.alias, { identityFile: host.identityFile })
  expect(keyArgs.slice(keyArgs.indexOf('-i'), keyArgs.indexOf('-i') + 2)).toEqual(['-i', identityFile])
  expect(keyArgs).toContain('BatchMode=yes')
  await expect(new OpenSsh().resolve('fixture', { identityFile: root })).rejects.toMatchObject({ code: 'INVALID_IDENTITY_FILE' })

  const password = 'ephemeral password only'
  await manager.save({ id, alias: 'fixture', authMode: 'password', password })
  const saved = await readFile(profile, 'utf8')
  expect(saved).not.toContain(password)
  expect(JSON.parse(saved)).toEqual({ ...legacy, authMode: 'password' })
  const passwordArgs = buildSshArgs('fixture', { passwordAuth: true })
  expect(passwordArgs).toEqual(expect.arrayContaining([
    'StrictHostKeyChecking=yes', 'BatchMode=no', 'PreferredAuthentications=password',
    'KbdInteractiveAuthentication=no', 'PubkeyAuthentication=no', 'NumberOfPasswordPrompts=1',
  ]))
})

it('uses an SSH password for deployment and tunnel setup and asks again after disconnect', async () => {
  const entry = new URL('../remote-ssh/host/connection/index.mjs', import.meta.url).href
  const { ConnectionManager } = await import(/* @vite-ignore */ entry)
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-connect-'))
  const deployment = { hostId: randomUUID(), instanceId: randomUUID(), version: '0.2.1', remotePort: 3020, token: 'X'.repeat(43) }
  const closed = Promise.withResolvers<undefined>()
  const close = vi.fn(() => { closed.resolve(undefined); return closed.promise })
  const password = 'test % & ! " 测试 '
  const resolve = vi.fn(async () => ({ settings: {} }))
  const openTunnel = vi.fn(async (_alias: string, _port: number, { authentication }: { authentication: { password: string } }) => {
    expect(authentication.password).toBe(password)
    return { port: 5030, closed: closed.promise, close }
  })
  const deploy = vi.fn(async (_host: object, _progress: object, _signal: AbortSignal, authentication: { password: string }) => {
    expect(authentication.password).toBe(password)
    return deployment
  })
  const manager = new ConnectionManager({ stateDir: root, ssh: { resolve, openTunnel }, deploy })
  onTestFinished(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }) })
  const host = await manager.save({ alias: 'fixture', authMode: 'password' })
  await expect(manager.connectNative(host.id)).rejects.toMatchObject({ code: 'SSH_PASSWORD_REQUIRED' })
  await expect(manager.connectNative(host.id, { password: 'invalid\npassword' })).rejects.toMatchObject({ code: 'INVALID_PASSWORD' })
  expect(resolve).not.toHaveBeenCalled()

  expect(await manager.connectNative(host.id, { password })).toMatchObject({ hostId: deployment.hostId, port: 5030 })
  expect(resolve).toHaveBeenCalledWith('fixture', { signal: expect.any(AbortSignal), identityFile: undefined })
  expect(deploy.mock.calls[0]?.[3].password).toBeUndefined()
  expect(JSON.stringify(manager.status(host.id))).not.toContain(password)
  await manager.disconnect(host.id)
  expect(close).toHaveBeenCalled()
  await expect(manager.connectNative(host.id)).rejects.toMatchObject({ code: 'SSH_PASSWORD_REQUIRED' })
})

it('gives the askpass response only once to the matching local process', async () => {
  const entry = new URL('../remote-ssh/host/connection/askpass.mjs', import.meta.url).href
  const { startAskpass } = await import(/* @vite-ignore */ entry)
  const password = ' shell &^!% " ☃ '
  const askpass = await startAskpass(password)
  onTestFinished(() => askpass.close())
  askpass.allow(process.pid)
  const { DSH_SSH_ASKPASS_PORT: port, DSH_SSH_ASKPASS_NONCE: nonce } = askpass.env
  expect(JSON.stringify(askpass.env)).not.toContain(password)
  const response = async (data: string) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) }, () => socket.write(data))
    const chunks: Buffer[] = []
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('error', () => socket.destroy())
    await new Promise<void>(resolve => socket.once('close', resolve))
    return Buffer.concat(chunks).toString('utf8')
  }
  expect(await response(`${nonce}:${process.pid + 1}\n`)).toBe('')
  expect(await response(`${'a'.repeat(64)}:${process.pid}\n`)).toBe('')
  expect(await response(`${nonce}:${process.pid}\n`)).toBe(password)
  expect(await response(`${nonce}:${process.pid}\n`)).toBe('')
})
