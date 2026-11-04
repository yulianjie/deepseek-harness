/** Browser command service, with one keyboard adapter per plugin lifetime. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ShortcutRegistry, type CommandResolver } from './registry.ts'
import { detectEnvironment, installKeyboard } from './dom.ts'
import { bindingIssue, initialShortcutConfig, normalizeBinding, overlappingBindings, presentBinding } from '../protocol.ts'
import type { DesktopKeyboardApi, DesktopShortcutsApi, ShortcutSaveResult } from '../protocol.ts'
import { desktopShortcutStorage, webShortcutStorage } from './storage.ts'
import type { Shortcuts } from './types.ts'
import type { ShortcutFixedInput } from './types.ts'
import { installNativeKeyboard } from './native.ts'
import { Config } from '../config.ts'

export type { ShortcutCatalogEntry, ShortcutCommand, ShortcutContext, ShortcutGesture, Shortcuts } from './types.ts'
export type { ShortcutFixedInput, ShortcutFixedCommand, ShortcutFixedCatalogEntry } from './types.ts'
export type { ShortcutBinding, ShortcutCommandId, ShortcutPlatform, ShortcutRuntime } from '../protocol.ts'

/** Host panes expose the keycap catalog to their components without owning window keyboard input. */
export interface ShortcutsOptions {
  readonly presentation?: 'pane'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Window-local application commands and effective keycap catalog. */
    shortcuts: Shortcuts
    /** Additional Host currently owning the shell's conversation input. */
    hostShortcutTarget?: import('@deepseek-ai/dsh-client-store').ObservableSnapshot<{
      readonly hostKey: string
      readonly shortcuts: Shortcuts
    } | undefined>
    /** Shell preferences and native window actions used by a pane. */
    hostWindowShortcuts?: Shortcuts
  }
}

function matchesConversationHost(target: Element | null, hostKey: string | undefined): boolean {
  if (target === null) return true
  if (!target.isConnected) return false
  const pane = target.closest<HTMLElement>('[data-shortcut-host]')
  if (pane !== null) return pane.dataset.shortcutHost === hostKey
  return hostKey === undefined || target.closest('[data-conversation-session]') === null
}

/** Cordis keyboard provider; Desktop startup requires its native keyboard bridge. */
export default class ShortcutsService extends Service implements Shortcuts {
  static inject = ['locale']
  readonly runtime: Shortcuts['runtime']
  readonly platform: Shortcuts['platform']
  readonly catalog: Shortcuts['catalog']
  readonly config: Shortcuts['config']
  readonly fixedCatalog: Shortcuts['fixedCatalog']
  readonly stopSequenceMs: number
  private readonly fixedListeners = new Map<(input: ShortcutFixedInput) => void, 'host' | undefined>()
  private readonly target: Context['hostShortcutTarget']
  private readonly shellShortcuts: Shortcuts | undefined
  private readonly adapter: DesktopShortcutsApi | undefined
  private readonly keyboard: DesktopKeyboardApi | undefined
  private readonly pane: boolean
  private active = true
  private connected = false
  private readonly registry: ShortcutRegistry

  constructor(ctx: Context, options?: ShortcutsOptions) {
    const pane = options?.presentation === 'pane'
    const environment = detectEnvironment(document, navigator)
    const keyboard = !pane && environment.runtime === 'desktop'
      ? (window as Window & { dshDesktop?: { keyboard?: DesktopKeyboardApi } }).dshDesktop?.keyboard : undefined
    if (!pane && environment.runtime === 'desktop' && keyboard === undefined) throw new Error('Desktop keyboard bridge unavailable')
    super(ctx, 'shortcuts')
    this.pane = pane
    this.target = ctx.get('hostShortcutTarget')
    this.shellShortcuts = ctx.get('hostWindowShortcuts')
    const route: CommandResolver | undefined = this.target === undefined ? undefined : (command, context) => {
      const host = this.target?.getSnapshot()
      if (!command.hostScoped) return command.resolve(context)
      if (!matchesConversationHost(context.target, host?.hostKey)) return { status: 'pass' }
      return host === undefined ? command.resolve(context)
        : host.shortcuts.resolveHostCommand?.(command.id, context) ?? { status: 'pass' }
    }
    this.keyboard = keyboard
    this.runtime = environment.runtime
    this.platform = environment.platform
    const config = Config((globalThis as { __DSH_SHORTCUTS_CONFIG__?: unknown }).__DSH_SHORTCUTS_CONFIG__ ?? {})
    this.stopSequenceMs = config.stopSequenceMs
    this.registry = new ShortcutRegistry(this.runtime, this.platform, pane ? undefined : initialShortcutConfig(), route)
    this.catalog = this.registry.catalog
    this.config = this.registry.config
    this.fixedCatalog = this.registry.fixedCatalog
    if (this.shellShortcuts !== undefined) {
      const config = this.shellShortcuts.config
      ctx.effect(() => {
        const sync = () => { this.registry.configure(config.getSnapshot()) }
        sync()
        return config.subscribe(sync)
      }, 'shortcuts: shell preferences')
    }
    if (this.target !== undefined) {
      const target = this.target
      ctx.effect(() => {
        let previous = target.getSnapshot()
        return target.subscribe(() => {
          const current = target.getSnapshot()
          if (current?.hostKey === previous?.hostKey) return
          previous?.shortcuts.receiveHostFixedInput?.({ type: 'reset' })
          this.receiveHostFixedInput({ type: 'reset' })
          previous = current
        })
      }, 'shortcuts: Host focus')
    }
    const publish = (snapshot: ReturnType<Shortcuts['config']['getSnapshot']>): void => {
      if (this.active && this.connected && snapshot.sequence >= this.config.getSnapshot().sequence) this.registry.configure(snapshot)
    }
    const web = !pane && this.runtime === 'web' ? webShortcutStorage(window, this.platform, publish) : undefined
    this.adapter = pane ? undefined : web ?? desktopShortcutStorage(window)
    if (keyboard !== undefined) ctx.effect(() => installNativeKeyboard(window, keyboard, this.registry,
      () => this.config.getSnapshot(), () => { this.fixedInput({ type: 'reset' }) }, route !== undefined), 'shortcuts: native keyboard')
    ctx.effect(() => {
      const off = this.adapter?.subscribe(publish)
      return () => { this.active = false; this.fixedListeners.clear(); off?.(); web?.dispose() }
    }, 'shortcuts: preferences')
    this.syncDefinitions()
    if (!pane) ctx.effect(() => installKeyboard(window, this.registry, (input) => { this.fixedInput(input) },
      keyboard !== undefined && (this.platform === 'macos' || this.platform === 'windows'), route !== undefined), 'shortcuts: keyboard')
    ctx.effect(() => ctx.locale.subscribe(() => { this.registry.refreshLabels() }), 'shortcuts: locale')
  }

  register(command: Parameters<Shortcuts['register']>[0]): () => void {
    const off = this.registry.register(command)
    this.syncDefinitions()
    return () => { off(); this.syncDefinitions() }
  }

  registerFixed(command: Parameters<Shortcuts['registerFixed']>[0]): () => void {
    const off = this.registry.registerFixed(command)
    this.syncDefinitions()
    return () => { off(); this.syncDefinitions() }
  }

  observeFixedInput(listener: (input: ShortcutFixedInput) => void, scope?: 'host'): () => void {
    this.fixedListeners.set(listener, scope)
    return () => { this.fixedListeners.delete(listener) }
  }

  resolveHostCommand(...args: Parameters<NonNullable<Shortcuts['resolveHostCommand']>>): ReturnType<NonNullable<Shortcuts['resolveHostCommand']>> {
    return this.registry.resolveHostCommand(...args)
  }

  receiveHostFixedInput(input: ShortcutFixedInput): void {
    this.deliverFixedInput(input, scope => scope === 'host')
  }

  private fixedInput(input: ShortcutFixedInput): void {
    const target = this.target?.getSnapshot()
    const hostInput = input.type === 'reset' || matchesConversationHost(input.context.target, target?.hostKey)
    const remaining = this.deliverFixedInput(input, scope => scope !== 'host' || target === undefined && hostInput)
    target?.shortcuts.receiveHostFixedInput?.(hostInput ? remaining : { type: 'reset' })
  }

  private deliverFixedInput(input: ShortcutFixedInput, include: (scope: 'host' | undefined) => boolean): ShortcutFixedInput {
    let consumed = false
    const remaining = (): ShortcutFixedInput => input.type === 'reset' ? input : { ...input,
      gesture: { ...input.gesture, defaultPrevented: input.gesture.defaultPrevented || consumed },
      consume: () => { consumed = true; input.consume() } }
    for (const [listener, scope] of [...this.fixedListeners]) {
      if (!include(scope) || !this.fixedListeners.has(listener)) continue
      try {
        listener(remaining())
      } catch (error) {
        console.error('Fixed shortcut handler failed', error)
      }
    }
    return remaining()
  }

  describeBinding(binding: Parameters<Shortcuts['describeBinding']>[0]): ReturnType<Shortcuts['describeBinding']> {
    const normalized = binding === null ? null : normalizeBinding(binding, this.platform)
    return { binding: normalized,
      keys: presentBinding(normalized, this.platform).keys,
      issue: normalized === null ? null : bindingIssue(normalized, this.runtime, this.platform),
      conflicts: normalized === null ? [] : [...this.catalog.getSnapshot().filter(row => row.binding !== null
        && overlappingBindings(row.binding, normalized)).map(row => row.id),
      ...this.fixedCatalog.getSnapshot().filter(row => row.bindings.some(binding => overlappingBindings(binding, normalized)))
        .map(row => row.id)] }
  }

  private syncDefinitions(): void {
    if (!this.active || this.pane) return
    if (this.adapter === undefined) { this.failRead(); return }
    void this.adapter.get(this.registry.definitions()).then((snapshot) => {
      this.connected = true
      if (this.active && snapshot.sequence >= this.config.getSnapshot().sequence) this.registry.configure(snapshot)
    }, () => { this.failRead() })
  }

  private failRead(): void {
    if (this.active) this.registry.configure({ ...this.config.getSnapshot(), status: 'unreadable', error: 'read' })
  }

  /**
   * Persist one reviewed operation while retaining accepted bindings on failure.
   * @param args - edit and expected revision supplied by the editor.
   * @returns classified save outcome and accepted snapshot.
   */
  async edit(...args: Parameters<Shortcuts['edit']>): ReturnType<Shortcuts['edit']> {
    if (this.adapter === undefined) return { status: 'unreadable', snapshot: this.config.getSnapshot() }
    let result: ShortcutSaveResult
    try {
      result = await this.adapter.edit(...args)
    } catch (error) {
      if (this.active) console.error('Shortcut preference save failed', error)
      return { status: 'write-failed', snapshot: this.config.getSnapshot() }
    }
    if (this.active && result.snapshot.sequence >= this.config.getSnapshot().sequence) this.registry.configure(result.snapshot)
    return result
  }

  async recording(active: boolean): Promise<void> {
    if (this.adapter === undefined) throw new Error('Desktop shortcuts bridge unavailable')
    await this.adapter.recording(active)
  }

  async closeWindow(): Promise<void> {
    if (this.shellShortcuts !== undefined) return this.shellShortcuts.closeWindow()
    if (this.keyboard === undefined) throw new Error('Desktop keyboard bridge unavailable')
    await this.keyboard.closeWindow(this.config.getSnapshot().revision)
  }
}
