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
    ['/api/remote-ssh/hosts/forget-password', 'POST'],
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

it('carries an authenticated upgrade offer without credentials and requires explicit boot confirmation', async () => {
  const entry = new URL('../remote-ssh/host/remote/index.mjs', import.meta.url).href
  const { DSH_VERSION, buildRemoteScript, createRemoteDeployment } = await import(/* @vite-ignore */ entry)
  const expected = { hostId: randomUUID(), instanceId: randomUUID() }
  const bootId = randomUUID()
  const upgrade = { ...expected, bootId, version: '0.2.1-rc.5' }
  const secret = 'secret-ssh-fixture'
  const execSsh = vi.fn(async (_host: object, _options: { input: string }) => ({
    stdout: 'DSH_REMOTE_SSH_RESULT ' + JSON.stringify({
      code: 'REMOTE_UPGRADE_REQUIRED', error: secret, upgrade: { ...upgrade, token: secret },
    }),
  }))
  const remote = createRemoteDeployment({ execSsh })
  const host = { instance: 'default' }
  const signal = new AbortController().signal
  await expect(remote.deploy(host, undefined, signal, undefined, expected)).rejects.toMatchObject({
    code: 'REMOTE_UPGRADE_REQUIRED', message: expect.not.stringContaining(secret), upgrade,
  })
  expect(execSsh.mock.calls[0]?.[1].input).toContain(`"version":"${DSH_VERSION}"`)
  expect(execSsh.mock.calls[0]?.[1].input).not.toContain('"upgradeFrom":')
  await expect(buildRemoteScript('deploy', 'default', undefined, bootId)).rejects.toThrow('instance and boot identity')
  expect(await buildRemoteScript('deploy', 'default', expected, bootId)).toContain(`"upgradeFrom":"${bootId}"`)
})

it('skips legacy discovery for unsaved passwords and drains active probes on shutdown', async () => {
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

async function rememberedPasswordFixture() {
  const entry = new URL('../remote-ssh/host/connection/index.mjs', import.meta.url).href
  const { ConnectionError, ConnectionManager } = await import(/* @vite-ignore */ entry)
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-remember-'))
  const managers: InstanceType<typeof ConnectionManager>[] = []
  onTestFinished(async () => {
    await Promise.all(managers.map(manager => manager.dispose()))
    await rm(root, { recursive: true, force: true })
  })
  const records = new Map<string, string>()
  const credentialStore = {
    get: vi.fn(async (id: string) => records.get(id)),
    set: vi.fn(async (id: string, value: string) => { records.set(id, value) }),
    delete: vi.fn(async (id: string) => { records.delete(id) }),
  }
  const expected = { hostId: randomUUID(), instanceId: randomUUID() }
  const deployment = { ...expected, version: '0.2.1', remotePort: 3020, token: 'X'.repeat(43) }
  const config = { hostname: 'fixture.example', user: 'remote', port: 2222, settings: {} }
  type Authentication = { password?: string }
  const resolve = vi.fn(async () => ({ ...config }))
  const deploy = vi.fn(async (_host: object, _progress: object, _signal: AbortSignal,
    { password }: Authentication, _expected?: typeof expected) => {
    if (password !== 'actual 密码 %!') throw new ConnectionError('SSH_AUTH_FAILED', 'Authentication failed')
    return deployment
  })
  const openTunnel = vi.fn(async (_alias: string, _port: number, { authentication }: { authentication: Authentication }) => {
    expect(authentication.password).toBe('actual 密码 %!')
    const closed = Promise.withResolvers<undefined>()
    return { port: 5030, closed: closed.promise, close: () => { closed.resolve(undefined); return closed.promise } }
  })
  const probe = vi.fn(async (_host: object, _signal: AbortSignal, { password }: Authentication) => {
    expect(password).toBe('actual 密码 %!')
    return expected
  })
  function start() {
    const manager = new ConnectionManager({ stateDir: root, ssh: { resolve, openTunnel }, deploy, probe, credentialStore })
    managers.push(manager)
    return manager
  }
  return { root, start, expected, config, deploy, probe, records, credentialStore, ConnectionError }
}

it('reuses an explicitly saved password after restart for the legacy probe and the identified workspace', async () => {
  const fixture = await rememberedPasswordFixture()
  const manager = fixture.start()
  const host = { id: randomUUID(), alias: 'fixture', label: 'Fixture', instance: 'default', authMode: 'password' }
  const profile = join(fixture.root, 'hosts', `${host.id}.json`)
  await mkdir(join(fixture.root, 'hosts'))
  await writeFile(profile, JSON.stringify(host))
  expect(await manager.listHosts()).toEqual([host])
  expect(await manager.passwordState(host)).toBe('none')
  await expect(manager.probeRestore(host.id)).rejects.toMatchObject({ code: 'SSH_PASSWORD_REQUIRED' })
  await expect(manager.connectNative(host.id, { password: 'wrong', rememberPassword: true }))
    .rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' })
  expect(fixture.credentialStore.set).not.toHaveBeenCalled()
  await manager.connectNative(host.id, { password: 'actual 密码 %!', rememberPassword: true })
  expect(await readFile(profile, 'utf8')).toBe(JSON.stringify(host))
  expect(await manager.passwordState(host)).toBe('saved')

  const routes = new URL('../remote-ssh/host/routes.mjs', import.meta.url).href
  const { registerSshRoutes } = await import(/* @vite-ignore */ routes)
  const endpoints = new Map<string, (request: Request) => Promise<Response>>()
  registerSshRoutes({
    connection: { fetch: { register: (route: { path: string; fetch(request: Request): Promise<Response> }) => {
      endpoints.set(route.path, route.fetch)
    } } },
    on: vi.fn(), inject: vi.fn(), effect: vi.fn(),
  }, manager, {})
  const hostsPath = '/api/remote-ssh/hosts'
  const response = await endpoints.get(hostsPath)?.(new Request('http://127.0.0.1' + hostsPath))
  expect(await response?.json()).toEqual({ hosts: [{ ...host, passwordState: 'saved', status: {
    state: 'connected', ...fixture.expected, version: '0.2.1',
  } }] })
  await manager.dispose()

  const restarted = fixture.start()
  fixture.deploy.mockClear()
  expect(await restarted.passwordState(host)).toBe('saved')
  expect(await restarted.probeRestore(host.id)).toEqual(fixture.expected)
  expect(fixture.probe).toHaveBeenCalledOnce()
  expect(fixture.deploy).not.toHaveBeenCalled()
  expect(await restarted.connectNative(host.id, { expected: fixture.expected })).toMatchObject(fixture.expected)
  expect(fixture.deploy.mock.calls[0]?.[4]).toEqual(fixture.expected)
  expect(fixture.deploy.mock.calls[0]?.[3].password).toBeUndefined()
  await restarted.forgetPassword(host.id)
  expect(restarted.status(host.id).state).toBe('connected')
  expect(await restarted.passwordState(host)).toBe('none')
  await restarted.disconnect(host.id)
  await expect(restarted.connectNative(host.id)).rejects.toMatchObject({ code: 'SSH_PASSWORD_REQUIRED' })
})

it('retains saved credentials on network errors and discards them on rejection or an SSH target change', async () => {
  const fixture = await rememberedPasswordFixture()
  const manager = fixture.start()
  const host = await manager.save({ alias: 'fixture', authMode: 'password' })
  const remember = { password: 'actual 密码 %!', rememberPassword: true }
  await manager.connectNative(host.id, remember)
  await manager.disconnect(host.id)

  fixture.deploy.mockRejectedValueOnce(new fixture.ConnectionError('SSH_NETWORK_ERROR', 'Network unavailable'))
  await expect(manager.connectNative(host.id)).rejects.toMatchObject({ code: 'SSH_NETWORK_ERROR' })
  expect(await manager.passwordState(host)).toBe('saved')
  fixture.probe.mockRejectedValueOnce(new fixture.ConnectionError('SSH_AUTH_FAILED', 'Password changed'))
  await expect(manager.probeRestore(host.id)).rejects.toMatchObject({ code: 'SSH_SAVED_PASSWORD_REJECTED' })
  expect(await manager.passwordState(host)).toBe('none')
  await expect(manager.connectNative(host.id)).rejects.toMatchObject({ code: 'SSH_PASSWORD_REQUIRED' })

  await manager.connectNative(host.id, remember)
  await manager.disconnect(host.id)
  fixture.deploy.mockClear()
  fixture.config.port = 2223
  await expect(manager.connectNative(host.id)).rejects.toMatchObject({ code: 'SSH_PASSWORD_TARGET_CHANGED' })
  expect(fixture.deploy).not.toHaveBeenCalled()
  expect(await manager.passwordState(host)).toBe('none')
})

it('clears credentials when a profile changes connection settings or is removed', async () => {
  const fixture = await rememberedPasswordFixture()
  const manager = fixture.start()
  const host = await manager.save({ alias: 'fixture', authMode: 'password' })
  const remember = { password: 'actual 密码 %!', rememberPassword: true }
  await manager.connectNative(host.id, remember)
  await manager.save({ ...host, label: 'Renamed' })
  expect(await manager.passwordState(host)).toBe('saved')

  const isolated = await manager.save({ ...host, instance: 'separate' })
  expect(await manager.passwordState(isolated)).toBe('none')
  expect(manager.status(host.id).state).toBe('disconnected')
  await manager.connectNative(host.id, remember)
  await manager.save({ ...isolated, authMode: 'config' })
  expect(fixture.records.has(host.id)).toBe(false)

  await manager.save(isolated)
  fixture.credentialStore.set.mockRejectedValueOnce(new Error(remember.password))
  expect(await manager.connectNative(host.id, remember)).toMatchObject({ passwordWarning: 'SSH_PASSWORD_STORE_FAILED' })
  expect(manager.status(host.id).state).toBe('connected')
  expect(await manager.passwordState(isolated)).toBe('none')
  await manager.disconnect(host.id)
  await manager.connectNative(host.id, remember)
  fixture.credentialStore.delete.mockRejectedValueOnce(new Error(remember.password))
  await expect(manager.remove(host.id)).rejects.toMatchObject({ code: 'SSH_PASSWORD_STORE_FAILED' })
  expect(await manager.listHosts()).toEqual([isolated])
  expect(await manager.passwordState(isolated)).toBe('saved')
  await manager.remove(host.id)
  expect(fixture.records.has(host.id)).toBe(false)
  expect(await manager.listHosts()).toEqual([])
})

it('restores known projects with saved passwords and probes only profiles with an unknown project history', async () => {
  const ui = new URL('../remote-ssh/ui/parallel-ui.js', import.meta.url).href
  const contract = new URL('../remote-ssh/host/parallel/contract.mjs', import.meta.url).href
  const { apply } = await import(/* @vite-ignore */ ui)
  const { isHostIdentity } = await import(/* @vite-ignore */ contract)
  const known = { hostId: randomUUID(), instanceId: randomUUID() }
  const legacy = { hostId: randomUUID(), instanceId: randomUUID() }
  const key = (id: string) => `dsh.remote-ssh.restore.${id}`
  const saved = new Map([[key('known'), JSON.stringify(known)], [key('empty'), 'null'], [key('manual'), JSON.stringify(known)]])
  vi.stubGlobal('localStorage', {
    getItem: (id: string) => saved.get(id) ?? null,
    setItem: (id: string, value: string) => saved.set(id, value),
  })
  const cleanup: Array<() => Promise<void> | void> = []
  onTestFinished(async () => {
    await Promise.all(cleanup.map(dispose => dispose()))
    vi.unstubAllGlobals()
  })

  const close = vi.fn()
  const subscribe = () => () => {}
  const listParallelHosts = vi.fn(async () => ['known', 'legacy', 'empty', 'manual'].map(id => ({
    id, label: id, authMode: 'password', passwordState: id === 'manual' ? 'none' : 'saved',
  })))
  const configureParallelHost = vi.fn(async () => ({ expected: legacy }))
  const openParallelHost = vi.fn(async ({ id, expected }: { id: string; expected: typeof known }) => ({
    ...expected, hostKey: id, transport: {}, close,
  }))
  const runtime = vi.fn(async ({ hostKey }: { hostKey: string }) => ({
    hostKey, dispose: vi.fn(), ctx: { get: (name: string) => ({
      connection: {},
      sidebarRightTabs: { get: (id: string) => ({ id }) },
      slots: { entries: () => ['remote-ssh-project', 'remote-ssh-settings'].map(key => ({ options: { key } })) },
      workspaces: { list: { subscribe, getSnapshot: () => ({ phase: 'ready', state: 'idle', items: [{}] }) } },
    })[name] },
  }))
  apply({
    get: () => ({ create: runtime }),
    effect: (install: () => () => Promise<void> | void) => { cleanup.push(install()) },
    slots: { inject: vi.fn() }, layout: { panelInfo: { subscribe, getSnapshot: () => ({}) } },
  }, {
    react: {}, primitives: {}, isHostIdentity, listParallelHosts, configureParallelHost, openParallelHost,
    createProjectPane: () => ({ install: vi.fn() }), installRemoteHostSettings: vi.fn(),
  })
  await vi.waitFor(() => expect(saved.get(key('legacy'))).toBe(JSON.stringify(legacy)))
  expect(configureParallelHost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'restore-probe', data: { id: 'legacy' } }))
  expect(openParallelHost).toHaveBeenCalledTimes(2)
  expect(openParallelHost).toHaveBeenCalledWith(expect.objectContaining({ id: 'known', expected: known, password: undefined }))
  expect(openParallelHost).toHaveBeenCalledWith(expect.objectContaining({ id: 'legacy', expected: legacy, password: undefined }))
  expect(runtime).toHaveBeenCalledTimes(2)
  expect(saved.get(key('empty'))).toBe('null')
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
