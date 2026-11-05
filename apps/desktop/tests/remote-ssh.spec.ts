import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
    ['/api/remote-ssh/parallel/restore-probe', 'POST'], ['/api/remote-ssh/parallel/open', 'POST'],
    ['/api/remote-ssh/parallel/close', 'POST'],
    ['http://dsh.internal/api/remote-ssh/hosts', 'GET'], ['/api/elsewhere/%2e%2e/remote-ssh/hosts', 'GET'],
  ] as const) {
    expect(await status(path, method, 'fixture=api')).toBe(403)
  }
  expect(await status('/api/remote-ssh/hosts', 'GET', 'fixture=browser')).toBe(200)
  expect(await status('/api/session.export', 'GET', 'fixture=api')).toBe(200)
})

it('finds existing rc.5 remote projects without creating or modifying remote instance files', async () => {
  const entry = new URL('../remote-ssh/host/remote/restore-probe.mjs', import.meta.url).href
  const { readRestoreIdentity } = await import(/* @vite-ignore */ entry)
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-restore-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const expected = { hostId: randomUUID(), instanceId: randomUUID() }
  const projectId = randomUUID()
  expect(await readRestoreIdentity(home, 'default')).toBeNull()
  expect(await readdir(home)).toEqual([])
  const instance = join(home, '.dsh-remote-ssh', 'instances', 'default')
  const storages = join(instance, 'dsh-home', 'storages')
  await mkdir(storages, { recursive: true })
  await writeFile(join(instance, 'identity.json'), JSON.stringify(expected))
  await writeFile(join(home, '.dsh-remote-ssh', 'host-id'), expected.hostId)
  expect(await readRestoreIdentity(home, 'default')).toBeNull()
  const registry = join(storages, 'workspace.json')
  const unit = { name: 'workspace', version: 2 }
  await writeFile(registry, JSON.stringify({ unit, global: { workspaceIds: [] }, tables: { workspaces: {} } }))
  expect(await readRestoreIdentity(home, 'default')).toBeNull()
  const registryWithProject = JSON.stringify({
    unit, global: { workspaceIds: [projectId] }, tables: { workspaces: { [projectId]: { path: '/private/project' } } },
  })
  await writeFile(registry, registryWithProject)
  expect(await readRestoreIdentity(home, 'default')).toEqual(expected)
  expect(await readFile(registry, 'utf8')).toBe(registryWithProject)
  const hostIdentity = join(home, '.dsh-remote-ssh', 'host-id')
  await writeFile(hostIdentity, randomUUID())
  await expect(readRestoreIdentity(home, 'default')).rejects.toThrow('identity does not match')
  await writeFile(hostIdentity, expected.hostId)
  await writeFile(registry, JSON.stringify({ unit, global: { workspaceIds: [projectId] }, tables: { workspaces: {} } }))
  await expect(readRestoreIdentity(home, 'default')).rejects.toThrow('storage is incomplete')
})

it('rejects a stale restore identity before provisioning anything on an SSH target', async () => {
  const entry = new URL('../remote-ssh/host/remote/index.mjs', import.meta.url).href
  const { buildRemoteScript } = await import(/* @vite-ignore */ entry)
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-expected-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const expected = { hostId: randomUUID(), instanceId: randomUUID() }
  const script: string = await buildRemoteScript('deploy', 'default', expected)
  const input = script.split("<<'DSH_REMOTE_SSH_BOOTSTRAP'\n")[1]?.split('\nDSH_REMOTE_SSH_BOOTSTRAP')[0]
  expect(input).toBeDefined()
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 10_000,
  })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('"code":"PARALLEL_IDENTITY_MISMATCH"')
  expect(await readdir(home)).toEqual([])
})

it('keeps password hosts out of legacy discovery and drains active probes on shutdown', async () => {
  const entry = new URL('../remote-ssh/host/connection/index.mjs', import.meta.url).href
  const { ConnectionManager } = await import(/* @vite-ignore */ entry)
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-probe-lifecycle-'))
  const started = Promise.withResolvers<undefined>()
  const ended = Promise.withResolvers<undefined>()
  const probe = vi.fn((_host: object, signal: AbortSignal) => {
    started.resolve(undefined)
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        ended.resolve(undefined)
        reject(signal.reason)
      }, { once: true })
    })
  })
  const deploy = vi.fn()
  const manager = new ConnectionManager({ stateDir: root, probe, deploy })
  onTestFinished(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }) })
  const locked = await manager.save({ alias: 'locked', authMode: 'password' })
  await expect(manager.probeRestore(locked.id)).rejects.toMatchObject({ code: 'SSH_PASSWORD_REQUIRED' })
  expect(probe).not.toHaveBeenCalled()
  const legacy = await manager.save({ alias: 'legacy' })
  const opening = expect(manager.probeRestore(legacy.id)).rejects.toMatchObject({ code: 'SSH_CANCELLED' })
  await started.promise
  await manager.dispose()
  await ended.promise
  await opening
  expect(deploy).not.toHaveBeenCalled()
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
