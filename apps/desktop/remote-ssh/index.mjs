import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { ConnectionManager, OpenSsh } from './host/connection/index.mjs'
import { createCredentialStore } from './host/connection/credential-store.mjs'
import { createRemoteDeployment } from './host/remote/index.mjs'
import { registerSshRoutes } from './host/routes.mjs'
import { ParallelHostBroker } from './host/parallel/broker.mjs'

export const name = 'remote-host-ssh'
export const inject = ['connection']

/** Register the SSH broker; no remote process starts until a host is connected. */
export function apply(ctx, config = {}) {
  const configuredHome = process.env.DSH_HOME
  const home = !configuredHome?.trim() ? join(homedir(), '.dsh')
    : /^~(?:[/\\]|$)/.test(configuredHome) ? join(homedir(), configuredHome.slice(2)) : configuredHome
  const stateDir = resolve(config.stateDir ?? join(home, 'remote-host-ssh'))
  const ssh = new OpenSsh(config.ssh || {})
  const runtime = createRemoteDeployment({
    execSsh: (host, options) => ssh.runScript(host.alias, options.input, {
      signal: options.signal,
      onStderr: options.onStderr,
      timeout: options.timeoutMs,
      identityFile: host.identityFile,
      authentication: options.authentication,
    }),
  })
  const manager = new ConnectionManager({ stateDir, ssh, deploy: runtime.deploy, probe: runtime.probe,
    credentialStore: createCredentialStore(config.loadCredentialBindings),
  })
  registerSshRoutes(ctx, manager, new ParallelHostBroker(manager))
}
