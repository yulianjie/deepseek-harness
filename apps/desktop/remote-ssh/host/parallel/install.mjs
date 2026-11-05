import { apply as applyParallelUi } from '../../ui/parallel-ui.js'
import { createProjectPane } from '../../ui/project-pane.js'
import { installRemoteHostSettings } from '../../ui/host-settings.js'
import { createParallelClient } from './client.mjs'
import { brokerMuxPath, createParallelContract } from './contract.mjs'

// Use the shell's trusted classic startup path for dsh-app:// documents.
// The local factories are self-contained and receive no Host data.
const browserProvider = `globalThis.__DSH_SSH_PARALLEL__ = Object.freeze({
  ...(${createParallelClient})((${createParallelContract})()),
  apply: (${applyParallelUi}),
  createProjectPane: (${createProjectPane}),
  installRemoteHostSettings: (${installRemoteHostSettings}),
})`

/** Mount the broker alongside the official local HTTP and mux carriers. */
export function installParallelCarrier(ctx, broker) {
  ctx.on('connection/request', (req, res, next) => broker.request(req, res, next, ctx.connection))
  ctx.inject(['webServer'], webCtx => {
    const { webServer, connection } = webCtx
    if (!/^(?:127\.\d+\.\d+\.\d+|::1)$/.test(webServer.host) ||
      typeof webServer.registerUpgrade !== 'function' || typeof connection.admit !== 'function' || !connection.browserPeer) return
    webCtx.on('webserver/index-inject', (rows, peer) => {
      if (peer !== connection.browserPeer) return
      if (/<\/script/i.test(browserProvider)) throw new Error('Invalid parallel SSH boot script')
      rows.push({ kind: 'script', placement: 'head', text: browserProvider })
    })
    webCtx.effect(() => {
      const unregister = webServer.registerUpgrade({
        path: brokerMuxPath,
        handler: (req, socket, head) => broker.upgrade(req, socket, head, connection),
      })
      broker.enable()
      return () => {
        broker.disable()
        unregister()
      }
    })
  })
}
