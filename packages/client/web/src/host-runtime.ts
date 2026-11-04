/** Ownership of one Host's client services and native pane within an existing shell. */
import { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ClientHostPageAccess, ConnectionInstallOptions } from '@deepseek-ai/dsh-client-connection/client'
import { createMemoryHostStorage, type HostStorage, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RootSessionSelection } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, type ReactNode } from 'react'

// Keep the Session adapter's scope and retention augmentations in the emitted declarations.
export type {} from '@deepseek-ai/dsh-client-ui-session/client'

/** Stable client-side identity of a Host instance, independent of connection generations. */
export type HostKey = Branded<'ClientHostKey'>

/** Trusted local composition and transport for one Host runtime. */
export interface HostRuntimeOptions {
  readonly hostKey: HostKey
  readonly connection: ConnectionInstallOptions
  /** Runtime-owned persistence. Omission keeps state in memory for this runtime. */
  readonly storage?: HostStorage
  readonly foreground?: ObservableSnapshot<boolean>
  readonly pageAccess?: ClientHostPageAccess
  /** Connection installer from the local client's trusted module roster. */
  readonly installConnection: (ctx: Context, options: ConnectionInstallOptions) => void
  /** Activate local domain and pane plugins before returning. */
  readonly compose: (ctx: Context) => void | Promise<void>
}

/** One Host's independently disposable Context and rendering entry. */
export interface HostRuntime {
  readonly hostKey: HostKey
  readonly ctx: Context
  /**
   * Render this Host's pane inside the shell's React tree.
   * @param session - retained reference from this Host's Session Controller. Pass undefined explicitly
   * for an empty selection, or omit it to follow the Host's current Session.
   * @returns the native pane, with an identity unique to this runtime.
   */
  renderPane(session?: RootSessionSelection['session']): ReactNode
  /** Release the Host's client plugins, streams, and effects after removing its pane from the shell. */
  dispose(): Promise<void>
}

/**
 * Install one Host's client tree with its own services, event bus, and renderer registry.
 * Startup failure disposes the partial tree. The caller owns the runtime and its pane references.
 * @param options - Host identity, physical connection, and locally trusted plugin composition.
 * @returns the assembled runtime without mounting a React root or navigating the page.
 */
export async function createHostRuntime(options: HostRuntimeOptions): Promise<HostRuntime> {
  const ctx = new Context()
  const { hostKey, storage, foreground, pageAccess, installConnection, connection, compose } = options
  try {
    ctx.provide('hostStorage', storage ?? createMemoryHostStorage())
    if (foreground !== undefined) ctx.provide('hostForeground', foreground)
    if (pageAccess !== undefined) {
      ctx.provide('hostPageAccess', pageAccess)
      ctx.provide('fileUploadTransport', pageAccess)
    }
    installConnection(ctx, connection)
    await compose(ctx)
    const slots = ctx.get('slots')
    if (slots === undefined || slots.entries('root').length === 0) {
      throw new Error('host runtime: composition did not install its pane root')
    }

    let disposal: Promise<void> | undefined
    const HostPane = ({ selection }: { selection: RootSessionSelection | undefined }): ReactNode =>
      slots.renderSlot('root', {}, selection)
    return {
      hostKey,
      ctx,
      renderPane(...sessions) {
        if (disposal !== undefined) throw new Error('host runtime: cannot render after disposal')
        const selection = sessions.length === 0 ? undefined : { session: sessions[0] }
        return createElement(HostPane, { selection })
      },
      dispose() {
        disposal ??= Promise.resolve().then(() => ctx.fiber.dispose())
        return disposal
      },
    }
  } catch (startupError) {
    try {
      await ctx.fiber.dispose()
    } catch (disposalError) {
      throw new AggregateError([startupError, disposalError], 'host runtime: startup and cleanup failed')
    }
    throw startupError
  }
}
