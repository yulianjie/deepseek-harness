// @vitest-environment jsdom
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { BundleInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createMemoryHostStorage, createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createHostRuntime, getStaticModules, type HostKey } from '@deepseek-ai/dsh-client-web'
import { bootClient } from '@deepseek-ai/dsh-client-web/src/boot-client.ts'
import { installDesktopSsh } from '@deepseek-ai/dsh-client-web/src/desktop-ssh.ts'
import { provideHostRuntimeFactory } from '@deepseek-ai/dsh-client-web/src/host-runtime-factory.ts'
import { mountClient } from '@deepseek-ai/dsh-client-web/src/mount.ts'
import { allowAllAccessPlugin } from '@deepseek-ai/dsh-client-test-runtime/src/access.ts'
import { webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { createInProcessModules, loadPluginModules } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/modules.ts'
import { remoteNamespacesOf, remoteProxiesPlugin } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-proxies.ts'
import { graphFromRoster } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/roster.ts'
import * as layout from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { createAssembledRemote, type AssembledRemote } from './assembled-remote.ts'

const sharedId = SessionId('fx-gamma')
const connectionPackage = '@deepseek-ai/dsh-client-connection'
const layoutPackage = '@deepseek-ai/dsh-client-ui-layout'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
  const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')
  const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
  onTestFinished(() => {
    vi.unstubAllGlobals()
    if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
    else Object.defineProperty(document, 'fonts', fonts)
    if (rangeRect === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    else Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect)
  })
})

afterEach(() => { cleanup() })

async function openFixtureHost(name: string) {
  const { mock } = createAssembledRemote({ positionalRequests: true })
  mock.stream('$events', (_args, stream) => {
    stream.push({ type: 'ready', clientId: name, host: { home: '/home/fixture' } })
  })
  const storage = createMemoryHostStorage()
  storage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: sharedId }))
  const runtime = await createHostRuntime({
    hostKey: brandString<HostKey>(name),
    installConnection,
    connection: { interactions: 'answer', transport: { rpc: mock.rpc } },
    storage,
    async compose(ctx) {
      const roster = webApp.without([
        '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-client-hmr',
      ])
      const modules = await loadPluginModules({
        roster,
        provide: {
          [connectionPackage]: { apply() {} },
          [layoutPackage]: { ...layout, apply: (scope) => { layout.apply(scope, { presentation: 'pane' }) } },
        },
      })
      ctx.plugin(remoteProxiesPlugin(remoteNamespacesOf(modules.values(), mock), mock) as Plugin)
      ctx.plugin(allowAllAccessPlugin)
      const system = createInProcessModules(graphFromRoster(roster.rows), modules)
      await bootClient({ ctx, modules: system, manifest: system.manifest })
    },
  })
  onTestFinished(() => runtime.dispose())
  const connection = runtime.ctx.get('connection') as ConnectionHandle
  await waitFor(() => { expect(connection.state.getSnapshot()).toBe('connected') })
  const reference = runtime.ctx.sessions.retain(sharedId, { source: 'mainView' })
  onTestFinished(() => { reference.release() })
  await reference.ready
  return { runtime, reference, mock, connection }
}

/** Paste through the real Lexical surface. jsdom does not implement editable beforeinput. */
function composerIn(shell: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const input = shell.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
    if (input === null) throw new Error('Composer is unavailable')
    return input
  })
}

async function pasteDraft(shell: HTMLElement, text: string): Promise<void> {
  const composer = await composerIn(shell)
  fireEvent.paste(composer, { clipboardData: { items: [], getData: () => text } })
  await waitFor(() => { expect(composer.textContent).toBe(text) })
}

function pushModelText(mock: AssembledRemote['mock'], index: number, text: string): void {
  const attemptId = 'shared-attempt'
  if (index === 0) {
    expect(mock.streams.push('session/follow', {
      type: 'event', event: { type: 'step/start', seq: 2, time: Date.now(), data: { turn: 0, step: 1 } },
    })).toBe(1)
    expect(mock.streams.push('session/follow', {
      type: 'assistant-stream', frame: { type: 'start', attemptId, revision: 1, startedAfterSeq: 2, turn: 0, step: 1 },
    })).toBe(1)
  }
  expect(mock.streams.push('session/follow', {
    type: 'assistant-stream', frame: {
      type: 'chunk', attemptId, index, revision: index + 2, time: Date.now(), chunk: { type: 'text-delta', index: 0, text },
    },
  })).toBe(1)
}

function pane(node: ReactNode): ReactNode {
  return createElement('main', { 'data-testid': 'parallel-shell' }, node)
}

it('switches two native conversation panes with the same Session identity while both event streams stay attached', async () => {
  const local = await openFixtureHost('fixture:local')
  const remote = await openFixtureHost('fixture:remote')
  const view = render(pane(local.runtime.renderPane(local.reference)))
  const shell = view.getByTestId('parallel-shell')
  const url = location.href
  expect(local.reference.sessionId).toBe(remote.reference.sessionId)
  expect(local.reference.binding).not.toBe(remote.reference.binding)

  await pasteDraft(shell, 'local-only draft')
  view.rerender(pane(remote.runtime.renderPane(remote.reference)))
  await pasteDraft(shell, 'remote-only draft')
  expect(view.getByTestId('parallel-shell')).toBe(shell)

  const eventId = 'shared-approval'
  const request = (toolName: string) => ({
    type: 'waterfall', event: 'approval/request', eventId, agentId: sharedId,
    request: { toolName },
  })
  await act(async () => {
    expect(local.mock.streams.push('$events', request('local fixture'))).toBe(1)
    expect(remote.mock.streams.push('$events', request('remote fixture'))).toBe(1)
  })
  expect(await view.findByText('Tool remote fixture requests privileged execution')).toBeTruthy()
  expect(view.queryByText('Tool local fixture requests privileged execution')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Allow once' }))
  await waitFor(() => {
    expect(remote.mock.log.calls('$events/result')).toHaveLength(1)
    expect(remote.mock.log.calls('$events/result')[0]?.args).toMatchObject([
      { eventId, outcome: { kind: 'result', value: 'allowed-once' } },
    ])
  })
  expect(local.mock.log.calls('$events/result')).toHaveLength(0)
  await waitFor(() => { expect(shell.querySelector('[data-composer-input]')?.textContent).toBe('remote-only draft') })

  view.rerender(pane(local.runtime.renderPane(local.reference)))
  expect(await view.findByText('Tool local fixture requests privileged execution')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Reject' }))
  await waitFor(() => {
    expect(local.mock.log.calls('$events/result')).toHaveLength(1)
    expect(local.mock.log.calls('$events/result')[0]?.args).toMatchObject([
      { eventId, outcome: { kind: 'result', value: 'rejected' } },
    ])
    expect(shell.querySelector('[data-composer-input]')?.textContent).toBe('local-only draft')
  })

  for (const host of [local, remote]) {
    expect(host.mock.log.streams('$events')).toEqual([expect.objectContaining({ state: 'open' })])
    expect(host.mock.log.streams('session/follow').filter(stream => stream.state === 'open')).toHaveLength(1)
  }
  fireEvent.keyDown(await composerIn(shell), { key: 'Enter' })
  await waitFor(() => { expect(local.mock.log.calls('session/prompt')).toHaveLength(1) })
  expect(remote.mock.log.calls('session/prompt')).toHaveLength(0)
  view.rerender(pane(remote.runtime.renderPane(remote.reference)))
  fireEvent.keyDown(await composerIn(shell), { key: 'Enter' })
  await waitFor(() => { expect(remote.mock.log.calls('session/prompt')).toHaveLength(1) })
  await act(async () => {
    pushModelText(local.mock, 0, 'local assistant chunk')
    pushModelText(remote.mock, 0, 'remote assistant chunk')
  })
  expect(await view.findByText('remote assistant chunk')).toBeTruthy()
  expect(view.queryByText('local assistant chunk')).toBeNull()
  view.rerender(pane(local.runtime.renderPane(local.reference)))
  expect(await view.findByText('local assistant chunk')).toBeTruthy()
  expect(view.queryByText('remote assistant chunk')).toBeNull()

  const localGeneration = local.connection.generation.getSnapshot()
  expect(localGeneration).toBeDefined()
  remote.reference.release()
  await act(async () => { await remote.runtime.dispose() })
  expect(remote.mock.log.streams('$events').some(stream => stream.state === 'open')).toBe(false)
  expect(local.connection.generation.getSnapshot()).toBe(localGeneration)
  expect(local.mock.log.streams('$events')).toEqual([expect.objectContaining({ state: 'open' })])
  await act(async () => { pushModelText(local.mock, 1, ' after remote disconnect') })
  expect(await view.findByText('local assistant chunk after remote disconnect')).toBeTruthy()
  expect(view.getByTestId('parallel-shell')).toBe(shell)
  expect(location.href).toBe(url)
  view.unmount()
}, 60_000)

it('opens the native conversation with the factory’s curated local client modules', async () => {
  const modules = createInProcessModules(graphFromRoster(webApp.rows), await loadPluginModules({ roster: webApp }))
  const shell = new Context()
  onTestFinished(() => shell.fiber.dispose())
  const conversationVisible = createSnapshotStore(true)
  shell.provide('shellConversationVisibility', conversationVisible)
  provideHostRuntimeFactory(shell, modules)
  const factory = shell.hostRuntimeFactory
  const { mock } = createAssembledRemote()
  vi.stubGlobal('__DSH_REMOTE_ACCESS__', { type: 'baseline', owner: true })
  mock.stream('remoteAccess/follow', () => {})
  const storage = createMemoryHostStorage()
  storage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: sharedId }))
  const hostKey = brandString<HostKey>('fixture:curated')
  const runtime = await factory.create({
    hostKey,
    connection: { transport: { rpc: mock.rpc } },
    pageAccess: {
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
      resourceUrl: input => String(input),
    },
    storage,
  })
  factory.showPane(hostKey)

  const connection = runtime.ctx.get('connection') as ConnectionHandle
  expect(connection.isLoopback).toBe(false)
  const promptAccess = runtime.ctx.remoteAccess.source('session', sharedId, 'session/prompt')
  expect(promptAccess.getSnapshot()).toBe(false)
  await waitFor(() => { expect(connection.state.getSnapshot()).toBe('connected') })
  await waitFor(() => {
    expect(mock.log.streams('remoteAccess/follow')).toEqual([expect.objectContaining({ state: 'open' })])
  })
  expect(mock.streams.push('remoteAccess/follow', { type: 'baseline', owner: true })).toBe(1)
  await waitFor(() => { expect(promptAccess.getSnapshot()).toBe(true) })
  const view = render(pane(runtime.renderPane()))
  const element = view.getByTestId('parallel-shell')
  await waitFor(() => {
    expect(runtime.ctx.uiSession.adapter.current.getSnapshot().key).toBe(sharedId)
    expect(mock.log.streams('session/follow')).toEqual([expect.objectContaining({ state: 'open' })])
  })
  expect(await composerIn(element)).toBeTruthy()
  expect(runtime.ctx.get('sidebarRight')).toBeDefined()
  expect(runtime.ctx.get('modules')).toBeUndefined()

  await act(async () => {
    conversationVisible.set(false)
    for (const running of [true, false]) {
      expect(mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [sharedId, running] })).toBe(1)
    }
  })
  const sessionStatus = () => runtime.ctx.uiSession.sessionStatus.getSnapshot().get(sharedId)
  expect(factory.selectedHost.getSnapshot()).toBe(hostKey)
  await waitFor(() => { expect(sessionStatus()?.completionUnread).toBe(true) })
  act(() => { conversationVisible.set(true) })
  await waitFor(() => { expect(sessionStatus()?.completionUnread).toBe(false) })

  view.unmount()
  await runtime.dispose()
  expect(factory.selectedHost.getSnapshot()).toBeUndefined()
  expect(mock.log.streams('$events').some(stream => stream.state === 'open')).toBe(false)
}, 60_000)

it('searches and manages plugins on the selected Host and keeps a disconnected selection', async () => {
  vi.stubGlobal('__DSH_REMOTE_ACCESS__', { type: 'baseline', owner: true })
  const bundle = (name: string): BundleInfo => ({
    name, version: '1.0.0', official: false, availability: 'profile', installed: true,
    optional: false, enabled: true, removable: true, updatable: false, rows: [], overrides: [],
  })
  const fixture = (bundles: BundleInfo[]) => {
    const { mock } = createAssembledRemote()
    mock.unary('pluginInventory/list', ok({ entries: [], managementAvailable: true }))
    mock.unary('pluginManager/listBundles', () => ok(bundles.slice()))
    mock.unary('pluginManager/listPlugins', ok([]))
    mock.unary('pluginManager/readBundleDetail', ok({ status: 'none' }))
    mock.unary('pluginManager/listVersions', ({ name }: { name: string }) => {
      const installed = bundles.find(item => item.name === name)?.version
      if (installed === undefined) throw new Error('Missing installed version for ' + name)
      return ok({
        status: 'listed', installed, registry: null, attempts: [{ registry: null }], omitted: 0,
        versions: installed === '1.0.0' ? [{ version: '2.0.0', tags: ['latest'], prerelease: false, bundle: true }] : [],
      })
    })
    mock.unary('pluginManager/updateBundle', ({ name, version }: { name: string; version: string }) => {
      const index = bundles.findIndex(item => item.name === name)
      const previous = bundles[index]
      if (previous === undefined) throw new Error('Missing bundle ' + name)
      bundles[index] = { ...previous, version }
      return ok({
        from: previous.version, to: version, step: 'install',
        result: { changed: true, stage: 'install', application: 'applied', target: name, bundle: name },
      })
    })
    mock.unary('pluginManager/registries', ok({ registry: null, fallbackRegistries: [], resolved: null }))
    mock.unary('pluginManager/inspect', ({ spec }: { spec: string }) =>
      ok({ status: 'accepted', kind: 'registry', name: spec, version: '1.0.0', bundle: true, registry: null }))
    mock.unary('pluginManager/installBundle', ({ spec }: { spec: string }) => {
      bundles.push(bundle(spec))
      return ok({ changed: true, stage: 'install', application: 'applied', target: spec, bundle: spec })
    })
    mock.unary('pluginManager/removeBundle', ({ name }: { name: string }) => {
      const index = bundles.findIndex(item => item.name === name)
      if (index < 0) throw new Error(`Missing bundle ${name}`)
      bundles.splice(index, 1)
      return ok({ changed: true, stage: 'remove', application: 'applied', target: name })
    })
    return mock
  }
  const local = fixture([bundle('local-fixture-plugin')])
  const remoteIcon = 'http://127.0.0.1:8080/icon.svg'
  const remote = fixture([{
    ...bundle('remote-fixture-plugin'), updatable: true,
    meta: { icon: remoteIcon },
  }, bundle('remote-extra-plugin')])
  const roster = webApp.without(['@deepseek-ai/dsh-client-hmr'])
  const localConnection = {
    installConnection,
    apply(scope: Context) {
      installConnection(scope, { interactions: 'answer', transport: { rpc: local.rpc } })
    },
  }
  const modules = createInProcessModules(graphFromRoster(roster.rows), await loadPluginModules({
    roster,
    provide: { [connectionPackage]: localConnection },
  }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('hostStorage', createMemoryHostStorage())
  provideHostRuntimeFactory(ctx, modules)
  await bootClient({ ctx, modules, manifest: modules.manifest })
  const factory = ctx.hostRuntimeFactory
  factory.enablePluginHostSelection()
  const hostKey = brandString<HostKey>('fixture:plugin-host')
  const runtime = await factory.create({
    hostKey, label: 'SSH Plugin Host',
    connection: { transport: { rpc: remote.rpc } },
    pageAccess: { fetch: () => Promise.resolve(new Response(null, { status: 404 })), resourceUrl: input => String(input) },
  })
  const view = render(pane(ctx.slots.renderSlot('root', {})))
  fireEvent.click(await view.findByRole('button', { name: 'Plugins' }))
  expect(await view.findByRole('button', { name: 'View local-fixture-plugin' })).toBeTruthy()
  const localBundleReads = local.log.calls('pluginManager/listBundles').length
  expect(localBundleReads).toBeGreaterThan(0)
  expect(remote.log.calls('pluginManager/listBundles')).toHaveLength(0)
  fireEvent.click(view.getByRole('button', { name: 'Host: Local' }))
  fireEvent.click(await view.findByRole('menuitem', { name: 'SSH Plugin Host' }))
  expect(await view.findByRole('button', { name: 'View remote-fixture-plugin' })).toBeTruthy()
  expect(view.queryByRole('button', { name: 'View local-fixture-plugin' })).toBeNull()
  expect(view.container.querySelector(`img[src="${remoteIcon}"]`)).toBeNull()
  expect(factory.selectedHost.getSnapshot()).toBeUndefined()
  fireEvent.change(view.getByRole('searchbox', { name: 'Search plugins' }), { target: { value: 'fixture' } })
  expect(view.queryByRole('button', { name: 'View remote-extra-plugin' })).toBeNull()

  fireEvent.click(view.getByRole('button', { name: 'View remote-fixture-plugin' }))
  fireEvent.click(await view.findByRole('button', { name: 'Update to 2.0.0' }))
  const update = within(await view.findByRole('dialog', { name: 'Update remote-fixture-plugin' }))
  expect(remote.log.calls('pluginManager/listVersions')).toMatchObject([{ args: [{ name: 'remote-fixture-plugin' }] }])
  expect(remote.log.calls('pluginManager/readBundleDetail')).toMatchObject([{ args: [{ name: 'remote-fixture-plugin' }] }])
  expect(remote.log.calls('pluginManager/updateBundle')).toHaveLength(0)
  fireEvent.click(update.getByRole('button', { name: 'Update' }))
  expect(await update.findByText('Updated to 2.0.0')).toBeTruthy()
  expect(remote.log.calls('pluginManager/updateBundle')).toMatchObject([{
    args: [{ name: 'remote-fixture-plugin', version: '2.0.0', options: { registry: null, requestId: expect.any(String) } }],
  }])
  expect(remote.log.calls('pluginManager/installBundle')).toHaveLength(0)
  expect(remote.log.calls('pluginManager/removeBundle')).toHaveLength(0)
  fireEvent.click(update.getByRole('button', { name: 'Done' }))
  const uninstall = await view.findByRole('button', { name: 'Uninstall remote-fixture-plugin' })
  await waitFor(() => { expect(uninstall).toHaveProperty('disabled', false) })
  fireEvent.click(uninstall)
  const confirmation = await view.findByRole('dialog', { name: 'Uninstall "remote-fixture-plugin"?' })
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Uninstall' }))
  await waitFor(() => {
    expect(remote.log.calls('pluginManager/removeBundle')).toMatchObject([{ args: [{ name: 'remote-fixture-plugin' }] }])
  })
  expect(await view.findByText('No plugins match your search.')).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: 'Add plugin' }))
  const install = within(await view.findByRole('dialog', { name: 'Add plugin' }))
  expect(install.getByText(/They run on SSH Plugin Host with your permissions/)).toBeTruthy()
  fireEvent.change(install.getByLabelText('Package name or address'), { target: { value: 'remote-added-plugin' } })
  fireEvent.click(install.getByRole('button', { name: 'Install' }))
  await waitFor(() => {
    expect(remote.log.calls('pluginManager/inspect')).toMatchObject([{ args: [{ spec: 'remote-added-plugin' }] }])
    expect(remote.log.calls('pluginManager/installBundle')).toMatchObject([{ args: [{ spec: 'remote-added-plugin' }] }])
  })
  expect(local.log.calls('pluginManager/listBundles')).toHaveLength(localBundleReads)
  expect(local.log.calls('pluginManager/readBundleDetail')).toHaveLength(0)
  expect(local.log.calls('pluginManager/listVersions')).toHaveLength(0)
  expect(local.log.calls('pluginManager/updateBundle')).toHaveLength(0)
  expect(local.log.calls('pluginManager/inspect')).toHaveLength(0)
  expect(local.log.calls('pluginManager/installBundle')).toHaveLength(0)
  expect(local.log.calls('pluginManager/removeBundle')).toHaveLength(0)

  await act(async () => { await runtime.dispose() })
  expect(await view.findByText('SSH Plugin Host is disconnected. Reconnect it or select another Host.')).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Add plugin' })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Host: SSH Plugin Host' }))
  expect(view.queryByRole('menuitem', { name: 'SSH Plugin Host' })).toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'Local' }))
  expect(await view.findByRole('button', { name: 'View local-fixture-plugin' })).toBeTruthy()
}, 60_000)

async function loadBundledSshProvider() {
  const entry = pathToFileURL(resolve('apps/desktop/remote-ssh/index.mjs')).href
  const { apply } = await import(/* @vite-ignore */ entry)
  const injections: { kind: string; text: string }[] = []
  const host = {
    effect: (register: () => unknown) => { register() },
    on(event: string, callback: (rows: typeof injections, peer: object) => void) {
      if (event === 'webserver/index-inject') callback(injections, host.connection.browserPeer)
    },
    inject(_services: string[], install: (scope: object) => void): void { install(host) },
    connection: { admit() {}, browserPeer: {}, fetch: { register() {} } },
    webServer: { host: '127.0.0.1', registerUpgrade: () => () => {} },
  }
  // Capture the actual bundled index injection, with no SSH process or remote JavaScript.
  apply(host)
  expect(injections).toHaveLength(1)
  type ProviderWindow = Pick<Parameters<typeof installDesktopSsh>[2], '__DSH_SSH_PARALLEL__'>
  const target: ProviderWindow & Pick<typeof globalThis, 'localStorage'> = { localStorage }
  Function('globalThis', injections[0]!.text)(target)
  const provider = target.__DSH_SSH_PARALLEL__
  if (provider === undefined) throw new Error('Desktop SSH provider is unavailable')
  return provider
}

function sshFixture(clientId: string) {
  const { mock } = createAssembledRemote()
  mock.stream('$events', (_args, stream) => {
    stream.push({ type: 'ready', clientId, host: { home: '/home/fixture' } })
  })
  return mock
}

async function bootSshShell() {
  const mock = sshFixture('fixture-local-ssh')
  vi.stubGlobal('__DSH_REMOTE_ACCESS__', { type: 'baseline', owner: true })
  const roster = webApp.without(['@deepseek-ai/dsh-client-hmr'])
  const localConnection = {
    installConnection,
    apply(scope: Context): void {
      installConnection(scope, { interactions: 'answer', transport: { rpc: mock.rpc } })
    },
  }
  const modules = createInProcessModules(graphFromRoster(roster.rows), await loadPluginModules({
    roster, provide: { [connectionPackage]: localConnection },
  }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('hostStorage', createMemoryHostStorage())
  provideHostRuntimeFactory(ctx, modules)
  await bootClient({ ctx, modules, manifest: modules.manifest })
  return ctx
}

it('mounts the bundled SSH manager only in the local Desktop shell', async () => {
  const provider = await loadBundledSshProvider()
  const ctx = await bootSshShell()
  const hostRecord = { id: 'fixture', label: 'Fixture SSH host', alias: 'fixture', instance: 'default' }
  const restoreKey = `dsh.remote-ssh.restore.${hostRecord.id}`
  onTestFinished(() => { localStorage.removeItem(restoreKey) })
  let saved: typeof hostRecord & { authMode?: string; identityFile?: string } = hostRecord
  const saves: unknown[] = []
  const opens: unknown[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input))
    switch (pathname) {
      case '/api/remote-ssh/hosts':
        return Response.json({ hosts: [saved] })
      case '/api/remote-ssh/parallel/restore-probe':
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ id: hostRecord.id })
        return Response.json({ expected: null })
      case '/api/remote-ssh/hosts/save':
        expect(init?.method).toBe('POST')
        saved = JSON.parse(String(init?.body))
        saves.push(saved)
        return Response.json({ host: saved })
      case '/api/remote-ssh/parallel/open':
        expect(init?.method).toBe('POST')
        opens.push(JSON.parse(String(init?.body)))
        return Response.json({ code: 'SSH_AUTH_FAILED', error: 'SSH 登录失败。' }, { status: 403 })
      default:
        throw new Error(`Unexpected SSH request ${pathname}`)
    }
  })
  const win = {
    __DSH_SSH_PARALLEL__: provider, dshDesktop: { protocolVersion: 1 }, document: { baseURI: 'dsh-app://app/' },
    __DSH_TRANSPORT__: { fetch, streamBaseUrl: 'http://127.0.0.1:8400/' },
  }
  const staticModules = getStaticModules()
  await installDesktopSsh(ctx, staticModules, { ...win, location: { protocol: 'https:', hostname: 'app' } })
  expect(ctx.slots.entries('main').every(row => row.options.key !== 'remote-host-ssh')).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
  await installDesktopSsh(ctx, staticModules, { ...win, location: { protocol: 'dsh-app:', hostname: 'app' } })
  const container = document.body.appendChild(document.createElement('div'))
  onTestFinished(() => { container.remove() })
  await act(async () => { await mountClient(ctx, container) })
  const shell = within(container)
  const launcher = await shell.findByRole('button', { name: '远程连接' })
  const nav = launcher.closest('nav')
  if (nav === null) throw new Error('The Remote SSH launcher is outside the sidebar panel list')
  const panelButtons = within(nav).getAllByRole('button')
  const plugins = within(nav).getByRole('button', { name: /^(Plugins|插件)$/ })
  expect(panelButtons[panelButtons.indexOf(plugins) + 1]).toBe(launcher)
  await waitFor(() => {
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/remote-ssh/hosts', '/api/remote-ssh/parallel/restore-probe',
    ])
    expect(localStorage.getItem(restoreKey)).toBe('null')
  })
  expect(opens).toHaveLength(0)
  fireEvent.click(launcher)
  const manager = await shell.findByRole('region', { name: '远程连接' })
  const panel = within(manager)
  expect(await panel.findByText('Fixture SSH host')).toBeTruthy()
  expect(launcher.getAttribute('aria-current')).toBe('page')
  expect(fetch).toHaveBeenCalledTimes(3)

  fireEvent.click(panel.getByRole('button', { name: '编辑' }))
  expect(panel.getByRole('radio', { name: 'OpenSSH 配置' })).toHaveProperty('checked', true)
  fireEvent.click(panel.getByRole('radio', { name: '私钥文件' }))
  const path = '~/.ssh/fixture private key'
  fireEvent.change(panel.getByLabelText('本机私钥路径'), { target: { value: path } })
  fireEvent.click(panel.getByRole('button', { name: '保存主机' }))
  await waitFor(() => { expect(saves).toEqual([{ ...hostRecord, authMode: 'key', identityFile: path }]) })
  await waitFor(() => { expect(panel.getByRole('button', { name: '编辑' })).toHaveProperty('disabled', false) })

  fireEvent.click(panel.getByRole('button', { name: '编辑' }))
  expect(panel.getByLabelText('本机私钥路径')).toHaveProperty('value', path)
  fireEvent.click(panel.getByRole('radio', { name: '密码' }))
  expect(panel.queryByLabelText('本机私钥路径')).toBeNull()
  fireEvent.click(panel.getByRole('button', { name: '保存主机' }))
  const input = await panel.findByLabelText('SSH 登录密码')
  expect(saves[1]).toEqual({ ...hostRecord, authMode: 'password' })
  expect(input).toHaveProperty('type', 'password')
  expect(input).toHaveProperty('value', '')
  const password = '  fixture password  '
  fireEvent.change(input, { target: { value: password } })
  fireEvent.click(panel.getByRole('button', { name: '连接' }))
  expect(input).toHaveProperty('value', '')
  expect((await panel.findByRole('alert')).textContent).toBe('SSH 登录失败。')
  expect(opens).toEqual([{ id: hostRecord.id, password }])
}, 60_000)

it('restores remembered and discovered SSH projects in the sidebar without changing the foreground Host', async () => {
  const provider = await loadBundledSshProvider()
  const ctx = await bootSshShell()
  const hostId = '11111111-1111-1111-1111-111111111111'
  const rememberedIdentity = { hostId, instanceId: '22222222-2222-2222-2222-222222222222' }
  const discoveredIdentity = { hostId, instanceId: '33333333-3333-3333-3333-333333333333' }
  const passwordIdentity = { hostId, instanceId: '44444444-4444-4444-4444-444444444444' }
  const hosts = [
    { id: 'remembered', label: 'Remembered SSH Host', authMode: 'config' },
    { id: 'discovered', label: 'Discovered SSH Host', authMode: 'key' },
    { id: 'legacy-empty', label: 'Legacy empty SSH Host', authMode: 'config' },
    { id: 'saved-empty', label: 'Saved empty SSH Host', authMode: 'config' },
    { id: 'password', label: 'Password SSH Host', authMode: 'password' },
  ].map(host => ({ ...host, alias: host.id, instance: 'default' }))
  const restoreKey = (id: string) => `dsh.remote-ssh.restore.${id}`
  localStorage.setItem(restoreKey('remembered'), JSON.stringify(rememberedIdentity))
  localStorage.setItem(restoreKey('saved-empty'), 'null')
  localStorage.setItem(restoreKey('password'), JSON.stringify(passwordIdentity))
  onTestFinished(() => { for (const { id } of hosts) localStorage.removeItem(restoreKey(id)) })

  const probes: string[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input))
    if (pathname === '/api/remote-ssh/hosts') return Response.json({ hosts })
    if (pathname !== '/api/remote-ssh/parallel/restore-probe') throw new Error(`Unexpected SSH request ${pathname}`)
    expect(init?.method).toBe('POST')
    const { id } = JSON.parse(String(init?.body)) as { id: string }
    probes.push(id)
    return Response.json({ expected: id === 'discovered' ? discoveredIdentity : null })
  })
  const discovered = sshFixture('fixture-discovered-ssh')
  const remembered = sshFixture('fixture-remembered-ssh')
  const openParallelHost = vi.fn(async (request: { id: string; expected?: typeof rememberedIdentity; password?: string }) => {
    const { id } = request
    if (id !== 'remembered' && id !== 'discovered') throw new Error(`Unexpected SSH channel ${id}`)
    const identity = id === 'remembered' ? rememberedIdentity : discoveredIdentity
    const mock = id === 'remembered' ? remembered : discovered
    return {
      ...identity, hostKey: `ssh:${identity.hostId}:${identity.instanceId}`, label: id, version: '0.2.1',
      leaseAvailable: createSnapshotStore(true),
      transport: { rpc: mock.rpc, fetch: () => Promise.resolve(new Response(null, { status: 404 })) },
      resourceUrl: (input: string) => input,
      async close() {},
    }
  })
  const fixtureProvider = { ...provider, openParallelHost }
  await installDesktopSsh(ctx, getStaticModules(), {
    __DSH_SSH_PARALLEL__: fixtureProvider,
    dshDesktop: { protocolVersion: 1 }, document: { baseURI: 'dsh-app://app/' },
    location: { protocol: 'dsh-app:', hostname: 'app' }, __DSH_TRANSPORT__: { fetch },
  })
  const view = render(pane(ctx.slots.renderSlot('root', {})))
  const project = (label: string, id = 'fx-ws-fixture') => view.container.querySelector(
    `[data-workspace-host="${label}"] [data-row-key="workspace:${id}"]`,
  )
  await waitFor(() => {
    expect(project('Remembered SSH Host')).toBeTruthy()
    expect(project('Discovered SSH Host')).toBeTruthy()
  })
  expect(probes.sort()).toEqual(['discovered', 'legacy-empty'])
  expect(openParallelHost.mock.calls.map(([{ id, expected, password }]) => ({ id, expected, password }))).toEqual([
    { id: 'remembered', expected: rememberedIdentity, password: undefined },
    { id: 'discovered', expected: discoveredIdentity, password: undefined },
  ])
  expect(localStorage.getItem(restoreKey('discovered'))).toBe(JSON.stringify(discoveredIdentity))
  expect(localStorage.getItem(restoreKey('legacy-empty'))).toBe('null')
  expect(ctx.hostRuntimeFactory.selectedHost.getSnapshot()).toBeUndefined()

  fireEvent.click(view.getByRole('button', { name: '远程连接' }))
  const manager = within(await view.findByRole('region', { name: '远程连接' }))
  expect(manager.getByLabelText('SSH 登录密码')).toHaveProperty('value', '')
  expect(manager.getByText('输入 SSH 登录密码以恢复此主机上的工作区。')).toBeTruthy()
  await waitFor(() => {
    expect(manager.queryAllByRole('alert').map(alert => alert.textContent)).toEqual([])
    expect(manager.getAllByText('已连接')).toHaveLength(2)
  })
  expect(openParallelHost).toHaveBeenCalledTimes(2)
  fireEvent.click(manager.getByRole('button', { name: '返回会话' }))

  await act(async () => {
    expect(discovered.streams.push('workspace/follow', { type: 'remove', workspaceId: 'fx-ws-fixture' })).toBe(1)
  })
  expect(project('Discovered SSH Host')).toBeNull()
  expect(localStorage.getItem(restoreKey('discovered'))).toBe(JSON.stringify(discoveredIdentity))
  await act(async () => {
    expect(discovered.streams.push('workspace/follow', { type: 'remove', workspaceId: 'fx-ws-home' })).toBe(1)
  })
  await waitFor(() => {
    expect(project('Discovered SSH Host', 'fx-ws-home')).toBeNull()
    expect(localStorage.getItem(restoreKey('discovered'))).toBe('null')
  })
  expect(project('Remembered SSH Host')).toBeTruthy()
}, 60_000)

it('routes unified rows, background interactions and New Session commands to the owning Host', async () => {
  const platform = Object.getOwnPropertyDescriptor(navigator, 'platform')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
  onTestFinished(() => {
    if (platform === undefined) Reflect.deleteProperty(navigator, 'platform')
    else Object.defineProperty(navigator, 'platform', platform)
  })
  vi.stubGlobal('__DSH_REMOTE_ACCESS__', { type: 'baseline', owner: true })
  const fixture = (name: string) => {
    const { mock } = createAssembledRemote()
    mock.stream('$events', (_args, stream) => {
      stream.push({ type: 'ready', clientId: name, host: { home: '/home/fixture' } })
    })
    const storage = createMemoryHostStorage()
    storage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: sharedId }))
    return { mock, storage }
  }
  const local = fixture('fixture-local-sidebar')
  const connection = {
    installConnection,
    apply: (scope: Context): void => {
      installConnection(scope, { interactions: 'answer', transport: { rpc: local.mock.rpc } })
    },
  }
  const roster = webApp.without(['@deepseek-ai/dsh-client-hmr'])
  const modules = createInProcessModules(graphFromRoster(roster.rows), await loadPluginModules({
    roster, provide: { [connectionPackage]: connection },
  }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('hostStorage', local.storage)
  provideHostRuntimeFactory(ctx, modules)
  await bootClient({ ctx, modules, manifest: modules.manifest })
  const factory = ctx.hostRuntimeFactory
  const open = async (name: string, label: string) => {
    const world = fixture(name)
    const runtime = await factory.create({
      hostKey: brandString<HostKey>(name), label, storage: world.storage,
      connection: { transport: { rpc: world.mock.rpc } },
      pageAccess: { fetch: () => Promise.resolve(new Response(null, { status: 404 })), resourceUrl: input => String(input) },
    })
    return { ...world, runtime }
  }
  const alpha = await open('fixture:alpha', 'SSH Alpha')
  const beta = await open('fixture:beta', 'SSH Beta')
  const view = render(pane(ctx.slots.renderSlot('root', {})))
  const root = view.getByTestId('parallel-shell')
  const workspaceId = 'fx-ws-fixture'
  function row(host: string | undefined, key: string): HTMLElement {
    const found = [...root.querySelectorAll<HTMLElement>(`[data-row-key="${key}"]`)]
      .find(candidate => candidate.closest<HTMLElement>('[data-workspace-host]')?.dataset.workspaceHost === host)
    if (found === undefined) throw new Error(`The requested row is absent: ${String(host)} ${key}`)
    return found
  }
  const sessionKey = `session:${sharedId}`
  for (const host of [undefined, 'SSH Alpha', 'SSH Beta']) {
    const group = await waitFor(() => row(host, `workspace:${workspaceId}`))
    if (group.getAttribute('aria-expanded') === 'false') fireEvent.click(group)
    await waitFor(() => row(host, sessionKey))
  }
  expect(view.getAllByRole('tree')).toHaveLength(1)
  expect(row(undefined, sessionKey).getAttribute('aria-selected')).toBe('true')
  const eventId = 'fixture-shared-interaction'
  await act(async () => {
    expect(alpha.mock.streams.push('$events', {
      type: 'waterfall', event: 'approval/request', eventId, agentId: sharedId,
      request: { toolName: 'alpha-only command' },
    })).toBe(1)
    expect(beta.mock.streams.push('$events', {
      type: 'waterfall', event: 'user-questions/request', eventId, agentId: sharedId,
      request: { questions: [{ id: 'fixture-choice', question: 'Select the Beta response', options: [{ label: 'Beta only' }] }] },
    })).toBe(1)
  })
  const status = (host: typeof alpha) => host.runtime.ctx.uiSession.sessionStatus.getSnapshot().get(sharedId)
  await waitFor(() => {
    expect(status(alpha)?.pendingInteraction?.kind).toBe('approval')
    expect(status(beta)?.pendingInteraction?.kind).toBe('question')
    expect(row('SSH Alpha', sessionKey).textContent).toContain('Waiting for approval')
    expect(row('SSH Beta', sessionKey).textContent).toContain('Waiting for answer')
  })
  fireEvent.keyDown(await composerIn(root), { key: 'Enter' })
  expect(alpha.mock.log.calls('$events/result')).toHaveLength(0)
  expect(beta.mock.log.calls('$events/result')).toHaveLength(0)
  expect(view.queryByText('Select the Beta response')).toBeNull()

  fireEvent.click(row('SSH Beta', sessionKey))
  expect(await view.findByText('Select the Beta response')).toBeTruthy()
  expect(factory.selectedHost.getSnapshot()).toBe(beta.runtime.hostKey)
  expect(row('SSH Beta', sessionKey).getAttribute('aria-selected')).toBe('true')
  expect(row('SSH Alpha', sessionKey).getAttribute('aria-selected')).toBe('false')
  expect(row(undefined, sessionKey).getAttribute('aria-selected')).toBe('false')
  fireEvent.click(view.getByText('Beta only', { exact: true }))
  fireEvent.click(view.getByRole('button', { name: /submit|send/i }))
  await waitFor(() => {
    const answers = beta.mock.log.calls('$events/result')
    expect(answers).toHaveLength(1)
    expect(answers[0]?.args).toMatchObject([{
      eventId, outcome: { kind: 'result', value: { answers: [{ id: 'fixture-choice', selected: ['Beta only'] }] } },
    }])
  })
  expect(alpha.mock.log.calls('$events/result')).toHaveLength(0)

  const count = (mock: AssembledRemote['mock']): number => mock.log.calls('session/create').length
  const counts = () => [count(local.mock), count(alpha.mock), count(beta.mock)] as const
  const [localBefore, alphaBefore, betaBefore] = counts()
  fireEvent.keyDown(document.body, { code: 'KeyN', key: 'n', ctrlKey: true, altKey: true })
  await waitFor(() => { expect(counts()).toEqual([localBefore, alphaBefore, betaBefore + 1]) })
  fireEvent.click(row('SSH Alpha', sessionKey))
  expect(await view.findByText('Tool alpha-only command requests privileged execution')).toBeTruthy()
  expect(factory.selectedHost.getSnapshot()).toBe(alpha.runtime.hostKey)
  fireEvent.click(view.getByRole('button', { name: 'Reject' }))
  await waitFor(() => { expect(alpha.mock.log.calls('$events/result')).toHaveLength(1) })
  expect(beta.mock.log.calls('$events/result')).toHaveLength(1)
  const newSession = view.getAllByRole('button', { name: 'New session' })
    .find(button => button.textContent?.includes('New Session'))
  if (newSession === undefined) throw new Error('The sidebar New Session action is absent')
  fireEvent.click(newSession)
  await waitFor(() => { expect(counts()).toEqual([localBefore, alphaBefore + 1, betaBefore + 1]) })
  const alphaSession = await waitFor(() => {
    const id = alpha.runtime.ctx.uiSession.adapter.current.getSnapshot().key
    if (id === undefined || id === sharedId) throw new Error('The new Alpha Session is not selected')
    return id
  })
  await pasteDraft(root, 'Alpha draft after reconnect')
  const alphaConnection = alpha.runtime.ctx.get('connection') as ConnectionHandle
  const localConnection = ctx.get('connection') as ConnectionHandle
  const beforeReconnect = alphaConnection.generation.getSnapshot()
  const localGeneration = localConnection.generation.getSnapshot()
  fireEvent.click(row(undefined, sessionKey))
  await waitFor(() => { expect(factory.selectedHost.getSnapshot()).toBeUndefined() })
  act(() => { alphaConnection.reconnect() })
  await waitFor(() => {
    expect(alphaConnection.state.getSnapshot()).toBe('connected')
    expect(alphaConnection.generation.getSnapshot()).toBeDefined()
    expect(alphaConnection.generation.getSnapshot()).not.toBe(beforeReconnect)
  })
  expect(localConnection.generation.getSnapshot()).toBe(localGeneration)
  expect(beta.mock.log.streams('$events')).toEqual([expect.objectContaining({ state: 'open' })])
  fireEvent.click(await waitFor(() => row('SSH Alpha', `session:${alphaSession}`)))
  await waitFor(() => { expect(root.querySelector('[data-composer-input]')?.textContent).toBe('Alpha draft after reconnect') })
  fireEvent.keyDown(document.body, { code: 'KeyB', key: 'b', ctrlKey: true, altKey: true })
  expect(await view.findByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  expect(factory.selectedHost.getSnapshot()).toBe(alpha.runtime.hostKey)
  expect(view.getByTestId('parallel-shell')).toBe(root)
  view.unmount()
}, 60_000)
