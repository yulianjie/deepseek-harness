import type { Context } from '@deepseek-ai/cordis'
import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client'

interface DesktopSshProvider {
  apply(ctx: Context, options: DesktopSshProvider & {
    readonly react: unknown
    readonly primitives: unknown
    readonly transport: ClientTransportHooks
    readonly baseUrl: string
  }): void
}

interface DesktopSshWindow {
  readonly location?: Pick<Location, 'protocol' | 'hostname'>
  readonly document?: Pick<Document, 'baseURI'>
  readonly dshDesktop?: { readonly protocolVersion?: number }
  readonly __DSH_SSH_PARALLEL__?: DesktopSshProvider
  readonly __DSH_TRANSPORT__?: ClientTransportHooks
}

/**
 * Install the bundled Desktop SSH provider in the local shell's plugin tree.
 * Only the authenticated local Desktop boot injection supplies this provider.
 * @param ctx - shell Context after the local manifest has activated.
 * @param staticModules - the same singleton React and primitive modules as the shell.
 * @param win - the shell window and its trusted startup injections.
 */
export async function installDesktopSsh(
  ctx: Context, staticModules: Readonly<Record<string, unknown>>, win: DesktopSshWindow,
): Promise<void> {
  if (win.location?.protocol !== 'dsh-app:' || win.location.hostname !== 'app' ||
    win.dshDesktop?.protocolVersion !== 1) return
  const provider = win.__DSH_SSH_PARALLEL__
  if (provider === undefined) return
  const transport = win.__DSH_TRANSPORT__
  const baseUrl = win.document?.baseURI
  if (transport === undefined || baseUrl === undefined) throw new Error('desktop SSH: local transport is unavailable')
  await ctx.plugin({
    name: 'remote-host-ssh',
    inject: ['hostRuntimeFactory', 'slots', 'layout'],
    apply(scope) {
      provider.apply(scope, {
        ...provider,
        react: staticModules.react,
        primitives: staticModules['@deepseek-ai/dsh-client-ui-primitives'],
        transport,
        baseUrl,
      })
    },
  })
}
