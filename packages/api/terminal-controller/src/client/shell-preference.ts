/** Browser-local shell preference; Host discovery decides whether the saved path is usable. */
import { resolveHostStorage, type HostStorage } from '@deepseek-ai/dsh-client-store'

const KEY = 'dsh.terminal.shell'

/**
 * Read the browser preference.
 * @param hostStorage - Host runtime storage, or absence for ordinary browser storage.
 * @returns the last selected shell path, or null when storage is unavailable.
 */
export function preferredShell(hostStorage?: HostStorage): string | null {
  try { return resolveHostStorage(hostStorage)?.getItem(KEY) ?? null }
  catch (_storageUnavailable) { return null }
}

/**
 * Remember the selected shell without making storage a startup dependency.
 * @param path - verified executable path offered by the Host.
 * @param hostStorage - Host runtime storage, or absence for ordinary browser storage.
 */
export function rememberShell(path: string, hostStorage?: HostStorage): void {
  try { resolveHostStorage(hostStorage)?.setItem(KEY, path) }
  catch (_storageUnavailable) { /* Private browsing or quota failure leaves this launch usable. */ }
}
