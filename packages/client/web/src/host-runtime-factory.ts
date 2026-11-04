/** Assemble a Host pane from the shell's local, built-in client plugins. */
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  HostWorkspaceProjection, PluginHostChoice, PluginHostState, PluginHostView, PropsRuntime, RootSessionSelection,
} from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react'
import { assertEntriesActive } from './boot-client.ts'
import { createHostRuntime, type HostKey, type HostRuntime, type HostRuntimeOptions } from './host-runtime.ts'

const CONNECTION = '@deepseek-ai/dsh-client-connection'
const LAYOUT = '@deepseek-ai/dsh-client-ui-layout'
const LOCALE = '@deepseek-ai/dsh-client-locale'
const SHORTCUTS = '@deepseek-ai/dsh-client-shortcuts'
const THEME = '@deepseek-ai/dsh-client-ui-theme'
const PANE_PLUGINS: readonly string[] = [LAYOUT, LOCALE, SHORTCUTS, THEME]

const REQUIRED_PLUGINS = [
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-file-upload',
  LOCALE,
  '@deepseek-ai/dsh-client-resources',
  SHORTCUTS,
  LAYOUT,
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-settings',
  THEME,
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
] as const

const OPTIONAL_PLUGINS = [
  '@deepseek-ai/dsh-api-terminal-controller',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-client-ui-plugin-market',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-deliverables',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  '@deepseek-ai/dsh-client-ui-sidebar-files',
  '@deepseek-ai/dsh-client-ui-sidebar-terminal',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-user-questions',
] as const

/** Inputs to the shell's built-in Host pane factory. */
export type HostRuntimeOpenOptions = Omit<HostRuntimeOptions, 'compose' | 'foreground' | 'installConnection'> & {
  /** Friendly server label shown on its native sidebar rows; defaults to the Host key. */
  readonly label?: string
  readonly pageAccess: NonNullable<HostRuntimeOptions['pageAccess']>
  readonly connection: HostRuntimeOptions['connection'] & {
    readonly transport: NonNullable<HostRuntimeOptions['connection']['transport']>
  }
}

/** Client boot service used by a trusted local Host transport provider. */
export interface HostRuntimeFactory {
  /** The additional Host in the shell's foreground, or absence for the local Host. */
  readonly selectedHost: ObservableSnapshot<HostKey | undefined>
  /**
   * Start one independent pane runtime. The shell releases it on shutdown.
   * @param options - verified Host key and isolated transport, page access, and viewing state.
   * @returns the Host runtime; remove its pane before explicit disposal.
   */
  create(options: HostRuntimeOpenOptions): Promise<HostRuntime>
  /**
   * Show an already-open Host in the shell, keeping other runtimes connected.
   * @param hostKey - key of the runtime previously opened by this factory.
   * @param session - live reference from that runtime. Omit it to follow the Host's current Session.
   */
  showPane(hostKey: HostKey, session?: RootSessionSelection['session']): void
  /** Return the shell to the local Host. */
  showLocal(): void
  /** Enable the Host selector in the Plugins panel after the Desktop SSH provider loads. */
  enablePluginHostSelection(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Locally assembled native Host panes. */
    hostRuntimeFactory: HostRuntimeFactory
  }
}

function hasConnectionInstaller(value: unknown): value is Pick<HostRuntimeOptions, 'installConnection'> {
  return typeof value === 'object' && value !== null && 'installConnection' in value
    && typeof value.installConnection === 'function'
}

async function openFromLocalModules(modules: ClientModuleLoader, options: HostRuntimeOpenOptions,
  foreground: ObservableSnapshot<boolean>, focus: () => void, shell: Context, pluginHostView: PluginHostView): Promise<HostRuntime> {
  const available = new Set(modules.manifest.plugins.map(row => row.id))
  const missing = [CONNECTION, ...REQUIRED_PLUGINS].filter(name => !available.has(name))
  if (missing.length > 0) throw new Error(`host runtime: missing local client plugins: ${missing.join(', ')}`)
  const connection = await modules.import(CONNECTION, '', {})
  if (!hasConnectionInstaller(connection)) throw new Error('host runtime: local Connection installer unavailable')
  const names = [
    ...REQUIRED_PLUGINS,
    ...OPTIONAL_PLUGINS.filter(name => available.has(name)),
  ].filter(name => name !== '@deepseek-ai/dsh-client-ui-sidebar-terminal' || available.has('@deepseek-ai/dsh-api-terminal-controller'))
  return createHostRuntime({
    ...options,
    foreground,
    connection: {
      ...options.connection,
      interactions: 'answer',
      transport: { ...options.connection.transport, ownsHost: options.connection.transport.ownsHost ?? false },
    },
    installConnection: connection.installConnection,
    async compose(ctx) {
      ctx.provide('focusHostWorkspace', focus)
      ctx.provide('pluginHostView', pluginHostView)
      const shellShortcuts = shell.get('shortcuts')
      if (shellShortcuts !== undefined) ctx.provide('hostWindowShortcuts', shellShortcuts)
      await ctx.plugin(Loader)
      const loader = ctx.loader
      loader.internal = modules as never
      await Promise.all(names.map(name => loader.create({
        name,
        ...(PANE_PLUGINS.includes(name) ? {
          config: { presentation: 'pane', ...(name === LAYOUT ? { workspaceProjection: true } : {}) },
        } : {}),
      })))
      await loader.await()
      assertEntriesActive(ctx, modules)
    },
  })
}

/**
 * Provide the shell-owned factory without changing the initial single-Host composition.
 * @param ctx - shell root, which owns each factory-created runtime's lifetime.
 * @param modules - trusted local module table, already owned by the shell.
 */
export function provideHostRuntimeFactory(ctx: Context, modules: ClientModuleLoader): void {
  const active = new Map<HostKey, HostRuntime | undefined>()
  const projections = createSnapshotStore<readonly HostWorkspaceProjection[]>([])
  const selection = createSnapshotStore<{ runtime: HostRuntime; target?: RootSessionSelection } | undefined>(undefined)
  const conversationVisible = createSnapshotStore(false)
  const pluginTargets = new Map<string, {
    readonly choice: PluginHostChoice
    readonly runtime: HostRuntime
    readonly connection: ConnectionHandle
  }>()
  const pluginHosts = createSnapshotStore<PluginHostState>({ enabled: false, connected: [] })
  let pluginTab = 'installed'
  const syncPluginHosts = (): void => {
    pluginHosts.set({
      ...pluginHosts.getSnapshot(),
      connected: [...pluginTargets.values()]
        .filter(({ connection }) => connection.state.getSnapshot() === 'connected')
        .map(({ choice }) => choice),
    })
  }
  const selectPluginHost: PluginHostView['select'] = (id, tab) => {
    const state = pluginHosts.getSnapshot()
    const target = state.connected.find(choice => choice.id === id)
    if (id !== '' && target === undefined) return
    if (state.selected?.id === target?.id) return
    const scope = target === undefined ? ctx : pluginTargets.get(target.id)?.runtime.ctx
    const navigation = scope?.get('hostPluginActions')
    if (navigation === undefined) return
    navigation.selectListTab(tab)
    pluginTab = tab
    pluginHosts.set({ enabled: state.enabled, connected: state.connected, ...target === undefined ? {} : { selected: target } })
  }
  const pluginHostView: PluginHostView = { projected: false, state: pluginHosts, select: selectPluginHost }
  const projectedPluginHostView: PluginHostView = { ...pluginHostView, projected: true }
  ctx.provide('pluginHostView', pluginHostView)
  const readSelection = () => selection.getSnapshot()
  const observeSelection = (listener: () => void) => selection.subscribe(listener)
  const observeVisibility = (listener: () => void) => {
    const stopSelection = observeSelection(listener)
    const stopVisibility = conversationVisible.subscribe(listener)
    return () => { stopVisibility(); stopSelection() }
  }
  const selectedHost: ObservableSnapshot<HostKey | undefined> = {
    getSnapshot: () => readSelection()?.runtime.hostKey,
    subscribe: observeSelection,
  }
  const foregroundOf = (hostKey: HostKey): ObservableSnapshot<boolean> => ({
    getSnapshot: () => selectedHost.getSnapshot() === hostKey && conversationVisible.getSnapshot(),
    subscribe: observeVisibility,
  })
  const showLocal = (): void => {
    selection.set(undefined)
    ctx.get('showShellConversation')?.()
  }
  const showPane: HostRuntimeFactory['showPane'] = (hostKey, ...sessions) => {
    const runtime = active.get(hostKey)
    if (runtime === undefined) throw new Error('host runtime: selected Host is not open')
    const session = sessions[0]
    if (session !== undefined) runtime.ctx.uiSession.bindingSource(session)
    const target = sessions.length === 0 ? undefined : { session }
    selection.set({ runtime, ...target === undefined ? {} : { target } })
    ctx.get('showShellConversation')?.()
  }
  const foregroundActions = () => conversationVisible.getSnapshot()
    ? readSelection()?.runtime.ctx.get('hostWorkspaceActions') : undefined
  ctx.provide('hostShortcutTarget', {
    getSnapshot: () => {
      const runtime = conversationVisible.getSnapshot() ? readSelection()?.runtime : undefined
      if (runtime === undefined) return undefined
      const shortcuts = runtime.ctx.get('shortcuts')
      return shortcuts === undefined ? undefined : { hostKey: runtime.hostKey, shortcuts }
    },
    subscribe: observeVisibility,
  })
  ctx.provide('focusHostWorkspace', showLocal)
  ctx.provide('hostWorkspaceSidebar', {
    projections,
    startSession() {
      const actions = foregroundActions()
      actions?.startSession()
      return actions !== undefined
    },
  })
  ctx.provide('hostForeground', { getSnapshot: () => readSelection() === undefined, subscribe: observeSelection })
  ctx.provide('hostPaneVisibility', {
    getSnapshot: () => readSelection() !== undefined && conversationVisible.getSnapshot(),
    subscribe: observeVisibility,
  })
  ctx.inject(['shellConversationVisibility'], (scope) => {
    const source = scope.get('shellConversationVisibility')
    if (source === undefined) return
    scope.effect(() => {
      const sync = (): void => { conversationVisible.set(source.getSnapshot()) }
      const unsubscribe = source.subscribe(sync)
      sync()
      return () => { unsubscribe(); conversationVisible.set(false) }
    }, 'web boot: shell conversation visibility')
  })
  function HostPaneOutlet(): ReactNode {
    const current = useSyncExternalStore(observeSelection, readSelection, readSelection)
    if (current === undefined) return null
    const { runtime, target } = current
    const pane = target === undefined ? runtime.renderPane() : runtime.renderPane(target.session)
    return createElement('div', { 'data-shortcut-host': runtime.hostKey, style: { display: 'contents' } }, pane)
  }
  function HostPluginPage({ id }: PropsRuntime<'plugins.host.page'>): ReactNode {
    const target = pluginTargets.get(id)
    if (target === undefined) return null
    const page = target.runtime.ctx.slots.renderSlot('root', { hostMainPanel: 'plugins' }, { session: undefined })
    return createElement(Fragment, { key: id }, page)
  }
  ctx.inject(['slots'], (scope) => {
    scope.slots.inject('shell.host-pane', () => scope.slots.register({ name: 'shell.host-pane' }, HostPaneOutlet))
    scope.slots.inject('plugins.host.page', () => scope.slots.register({ name: 'plugins.host.page' }, HostPluginPage))
  })
  ctx.provide('hostRuntimeFactory', {
    selectedHost,
    showPane,
    showLocal,
    enablePluginHostSelection() {
      pluginHosts.set({ ...pluginHosts.getSnapshot(), enabled: true })
    },
    async create(options) {
      const { hostKey } = options
      if (active.has(hostKey)) throw new Error('host runtime: Host already open or opening')
      active.set(hostKey, undefined)
      let runtime: HostRuntime | undefined
      try {
        const release = ctx.effect(async () => {
          const current = await openFromLocalModules(
            modules, options, foregroundOf(hostKey), () => { showPane(hostKey) }, ctx, projectedPluginHostView,
          )
          runtime = current
          active.set(hostKey, current)
          const label = options.label?.trim() || hostKey
          const navigation = current.ctx.get('hostPluginActions')
          const connection = current.ctx.get('connection') as ConnectionHandle
          let unsubscribePluginHost: (() => void) | undefined
          if (navigation !== undefined) {
            const choice = { id: hostKey, label }
            pluginTargets.set(hostKey, { choice, runtime: current, connection })
            const state = pluginHosts.getSnapshot()
            if (state.selected?.id === hostKey) {
              navigation.selectListTab(pluginTab)
              pluginHosts.set({ ...state, selected: choice })
            }
            unsubscribePluginHost = connection.state.subscribe(syncPluginHosts)
            syncPluginHosts()
          }
          projections.set([...projections.getSnapshot(), {
            key: hostKey,
            label,
            addWorkspace: () => { current.ctx.get('hostWorkspaceActions')?.addWorkspace() },
            render: owner => current.ctx.slots.renderSlot('root', { workspaceSidebar: owner }, { session: undefined }),
          }])
          return async () => {
            unsubscribePluginHost?.()
            if (pluginTargets.delete(hostKey)) syncPluginHosts()
            projections.set(projections.getSnapshot().filter(projection => projection.key !== hostKey))
            active.set(hostKey, undefined)
            if (selectedHost.getSnapshot() === hostKey) selection.set(undefined)
            try {
              await current.dispose()
            } finally {
              active.delete(hostKey)
            }
          }
        }, 'web boot: Host pane runtime')
        await release
        if (runtime === undefined || active.get(hostKey) !== runtime) throw new Error('host runtime: shell stopped during startup')
        let disposal: Promise<void> | undefined
        return { ...runtime, dispose: () => disposal ??= Promise.resolve().then(() => release()) }
      } catch (error) {
        if (runtime === undefined) active.delete(hostKey)
        throw error
      }
    },
  })
}
