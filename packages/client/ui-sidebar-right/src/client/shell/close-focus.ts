/** Focus continuity after page operations replace docked or floating pane elements. */
import { flushSync } from 'react-dom'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { visibleSidebarPane } from '../focus.ts'

/**
 * Focus the page selected by an open or split after its DOM has committed.
 * @param document - product document owning the input focus.
 * @param sessionId - Session whose page is opening.
 * @param open - synchronous operation returning its selected pane, or undefined when unchanged.
 * @param canFocus - whether this Host still owns focus, or absence for a single Host document.
 */
export function openWithPaneFocus(
  document: Document, sessionId: SessionId, open: () => PaneId | undefined, canFocus?: () => boolean,
): void {
  const restore = canFocus?.() !== false
  let paneId: PaneId | undefined
  flushSync(() => { paneId = open() })
  if (restore && canFocus?.() !== false && paneId !== undefined) {
    visibleSidebarPane(document, sessionId, paneId)?.focus({ preventScroll: true })
  }
}

/**
 * Commit a focused page's removal before focusing a surviving visible pane.
 * @param document - product document owning the input focus.
 * @param sessionId - Session whose page is closing.
 * @param paneId - pane whose page is closing; preferred if it survives.
 * @param close - synchronous cleanup and layout removal; errors preserve focus.
 * @param canFocus - whether this Host still owns focus, or absence for a single Host document.
 */
export function closeWithPaneFocus(
  document: Document, sessionId: SessionId, paneId: PaneId, close: () => void, canFocus?: () => boolean,
): void {
  const before = document.activeElement
  const owner = before?.closest<HTMLElement>('[data-sidebar-right-session]')
  const source = before?.closest<HTMLElement>('[data-dockkit-pane], [data-dockkit-float]')
  const retain = canFocus?.() !== false && owner?.dataset.sidebarRightSession === sessionId
    && (source?.dataset.dockkitPane ?? source?.dataset.dockkitFloat) === paneId
  flushSync(close)
  if (!retain || canFocus?.() === false || (document.activeElement !== document.body && document.activeElement !== before)) return
  visibleSidebarPane(document, sessionId, paneId)?.focus({ preventScroll: true })
}
