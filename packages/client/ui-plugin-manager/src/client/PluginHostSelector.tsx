/** Target menu for the Plugins panel. */
import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconLinkOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PluginHostState, PluginHostView, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginManagerPage.module.css'

/** The shell's selection is available in both the local and projected pages. */
export interface PluginHostFace {
  readonly projectedHost: boolean
  readonly selectPluginHost: PluginHostView['select']
  readonly hooks: { readonly pluginHosts: HostObservable<PluginHostState> }
}

/** The localized Host menu and its selected target. */
type PluginHostControl = PropsLocale<'pluginManager'> & {
  readonly hosts: PluginHostState
  readonly tab: string
  readonly select: PluginHostFace['selectPluginHost']
}

/**
 * Render the target menu in an Installed or Discover toolbar.
 * @param props - localized copy, available targets, and the tab to keep on switch.
 * @returns the menu with the current Host as its anchor label.
 */
export function PluginHostSelector(props: PluginHostControl): ReactNode {
  const { t, hosts, tab, select } = props
  const [open, setOpen] = useState(false)
  const current = hosts.selected
  const items: readonly MenuEntry[] = [
    { type: 'label', id: 'plugin-host-heading', text: t('pluginHostHeading') },
    { id: '', label: t('localPluginHost') },
    ...hosts.connected,
  ]
  const currentLabel = current?.label ?? t('localPluginHost')
  return (
    <Menu open={open} onClose={() => { setOpen(false) }} portal autoFocus align="end"
      selectedId={current?.id ?? ''} items={items} onSelect={(id) => { setOpen(false); select(id, tab) }}
      anchor={(
        <Button variant="outline" size="sm" className={css.hostButton} aria-haspopup="menu" aria-expanded={open}
          aria-label={t('pluginHostLabel', { host: currentLabel })} onClick={() => { setOpen(!open) }}
          icon={<IconLinkOutlineRegular size={14} />}>
          <span className={css.hostName}>{currentLabel}</span>
          <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
        </Button>
      )} />
  )
}

/**
 * Render the menu in the Discover slot beside its search field.
 * @param props - the slot's localized Host selection face.
 * @returns the Host menu when the SSH shell enables it.
 */
export function DiscoverPluginHostSelector(props: PropsRuntime<'plugins.discover.host'> &
  PropsLocale<'pluginManager'> & InjectFace<PluginHostFace>): ReactNode {
  const hosts = props.usePluginHosts(snapshot => snapshot)
  return hosts.enabled ? <PluginHostSelector t={props.t} hosts={hosts} tab="discover" select={props.selectPluginHost} /> : null
}
