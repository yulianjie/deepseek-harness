/** Unfinished close requests survive reload independently of the removed sidebar tabs. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostStorage } from '@deepseek-ai/dsh-client-store'
import type { WebTerminalId } from '../types.ts'

/** An explicit cleanup request; no process or open-tab metadata is mirrored here. */
export interface TerminalCloseRequest {
  readonly sessionId: SessionId
  readonly id: WebTerminalId
  readonly title: string
}

const PREFIX = 'dsh.terminal.close.v1.'

/** Each request has its own storage key, so other browser windows cannot overwrite its cleanup. */
export class TerminalCloseRequests {
  private readonly requests = new Map<WebTerminalId, TerminalCloseRequest>()

  /** @param hostStorage - Host runtime storage, or absence for ordinary browser storage. */
  constructor(private readonly hostStorage?: HostStorage) {
    try {
      const storage = this.storage
      if (storage === undefined) return
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (key?.startsWith(PREFIX)) this.load(storage, key)
      }
    } catch (error) { console.error('Terminal cleanup recovery failed:', error) }
  }

  /**
   * Read cleanup work still awaiting Host confirmation.
   * @returns unfinished requests owned by this browser instance.
   */
  pending(): readonly TerminalCloseRequest[] { return [...this.requests.values()] }

  /**
   * Retain cleanup across reload before removing a tab.
   * @param request - close intent to save before removing its tab.
   */
  save(request: TerminalCloseRequest): void {
    this.requests.set(request.id, request)
    try {
      this.storage?.setItem(PREFIX + request.id, JSON.stringify(request))
    } catch (error) { console.error('Terminal cleanup persistence failed:', error) }
  }

  /**
   * Forget confirmed cleanup in memory and browser storage.
   * @param id - terminal whose Host cleanup succeeded.
   */
  remove(id: WebTerminalId): void {
    this.requests.delete(id)
    try {
      this.storage?.removeItem(PREFIX + id)
    } catch (error) { console.error('Terminal cleanup persistence failed:', error) }
  }

  private get storage(): HostStorage | undefined { return this.hostStorage ?? globalThis.localStorage }

  private load(storage: HostStorage, key: string): void {
    try {
      const raw = storage.getItem(key)
      if (raw === null) return
      const parsed: unknown = JSON.parse(raw)
      if (!isRequest(parsed) || key !== PREFIX + parsed.id) throw new Error('Invalid terminal cleanup request')
      this.requests.set(parsed.id, parsed)
    } catch (error) { console.error('Terminal cleanup recovery failed:', error) }
  }
}

function isRequest(value: unknown): value is TerminalCloseRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Record<string, unknown>
  return typeof request.sessionId === 'string' && request.sessionId.length > 0
    && typeof request.id === 'string' && /^[\w-]{1,128}$/u.test(request.id)
    && typeof request.title === 'string'
}
