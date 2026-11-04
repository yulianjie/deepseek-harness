/** Host management. Keep this function self-contained for the trusted local boot script. */

export function apply(ctx, {
  react, primitives, openParallelHost, listParallelHosts, configureParallelHost,
  createProjectPane, installRemoteHostSettings, transport, baseUrl,
}) {
  const panelId = 'remote-host-ssh'
  const footer = 'sidebar.footer.action'
  const factory = ctx.get('hostRuntimeFactory')
  if (!factory) throw new Error('当前 Desktop 不支持并行 SSH 会话。')
  const { createElement: h, useMemo, useState, useSyncExternalStore } = react
  const { Button, Input, IconLinkOutlineRegular, StateDot } = primitives
  const { slots, layout } = ctx
  const lifetime = new AbortController()
  const entries = new Map()
  const operations = new Map()
  const notices = new Map()
  const listeners = new Set()
  const style = {
    panel: { padding: '24px', overflow: 'auto', minHeight: 0, width: '100%', boxSizing: 'border-box' },
    content: { maxWidth: 720, margin: '0 auto', display: 'grid', gap: 16 },
    actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    row: { display: 'grid', gap: 8, padding: '12px', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12 },
    secondary: { color: 'var(--dsw-alias-label-secondary)', margin: 0 },
  }
  const idle = { getSnapshot: () => undefined, subscribe: () => () => {} }
  const emptyHost = { alias: '', label: '', instance: 'default' }
  const display = {
    connected: ['已连接', 'done'],
    connecting: ['正在连接', 'ongoing'],
    reconnecting: ['正在重连', 'ongoing'],
    disconnecting: ['正在断开', 'ongoing'],
    offline: ['连接已断开', 'warning'],
    disconnected: ['未连接', 'idle'],
  }
  const local = { transport, baseUrl, signal: lifetime.signal }
  let state = { hosts: [], loading: false, error: '' }
  let refreshing

  function update(patch) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const readState = () => state

  function useStore(source) {
    const access = useMemo(() => ({
      subscribe: listener => source.subscribe(listener),
      getSnapshot: () => source.getSnapshot(),
    }), [source])
    return useSyncExternalStore(access.subscribe, access.getSnapshot)
  }

  function refresh() {
    if (lifetime.signal.aborted) return
    if (refreshing) return refreshing
    update({ loading: true, error: '' })
    refreshing = listParallelHosts(local).then(hosts => {
      if (!lifetime.signal.aborted) update({ hosts })
    }).catch(error => {
      if (!lifetime.signal.aborted) update({ error: error.message })
    }).finally(() => {
      refreshing = undefined
      if (!lifetime.signal.aborted) update({ loading: false })
    })
    return refreshing
  }

  function run(id, phase, task) {
    if (lifetime.signal.aborted || operations.has(id)) return
    notices.delete(id)
    const current = Promise.resolve().then(() => {
      lifetime.signal.throwIfAborted()
      return task()
    }).catch(error => {
      if (!lifetime.signal.aborted) notices.set(id, { error: true, message: error.message })
    }).finally(() => {
      operations.delete(id)
      if (!lifetime.signal.aborted) update()
    })
    operations.set(id, { phase, current })
    update()
    return current
  }

  async function close(entry) {
    try {
      await entry.channel.close()
    } finally {
      await entry.runtime?.dispose()
    }
  }

  function connect(host) {
    if (entries.has(host.id)) return
    run(host.id, 'connecting', async () => {
      const status = host.status
      const expected = status?.hostId && status?.instanceId
        ? { hostId: status.hostId, instanceId: status.instanceId }
        : undefined
      const channel = await openParallelHost({ ...local, id: host.id, expected })
      const entry = { channel }
      try {
        entry.runtime = await factory.create({
          hostKey: channel.hostKey,
          label: host.label || host.alias,
          connection: { transport: channel.transport },
          pageAccess: { fetch: channel.transport.fetch, resourceUrl: channel.resourceUrl },
        })
        lifetime.signal.throwIfAborted()
        const scope = entry.runtime.ctx
        entry.connection = scope.get('connection')
        const projectPane = createProjectPane({
          react, Button, fetch: channel.transport.fetch, confirm: message => globalThis.confirm(message),
        })
        await Promise.all([
          projectPane.install(scope),
          installRemoteHostSettings(scope, { react, primitives, label: channel.label }),
        ])
        lifetime.signal.throwIfAborted()
        const tabs = scope.get('sidebarRightTabs')
        const bodies = scope.get('slots')?.entries('sidebar.right.pane.tab')
        for (const kind of ['remote-ssh-project', 'remote-ssh-settings']) {
          const tab = tabs?.get(kind)
          if (!tab || !bodies?.some(body => body.options.key === tab.id)) {
            throw new Error('远端 Host 的原生面板未能完成加载。')
          }
        }
        entries.set(host.id, entry)
      } catch (error) {
        await close(entry)
        throw error
      }
    })
  }

  function reconnect(host) {
    const entry = entries.get(host.id)
    if (!entry) return connect(host)
    run(host.id, 'reconnecting', async () => {
      // Abort the old event consumers before publishing a new answer Peer.
      entry.connection.reconnect()
      const { bootChanged } = await entry.channel.reconnect({ signal: lifetime.signal })
      lifetime.signal.throwIfAborted()
      // Its normal retry loop claims the new lease. A second forced reset
      // could close the replacement if the loop already opened its socket.
      if (bootChanged) notices.set(host.id, { message: '远端 Harness 已重启，先前的终端进程和待提交附件可能需要重新打开。' })
    })
  }

  function disconnect(host) {
    const entry = entries.get(host.id)
    if (!entry) return
    run(host.id, 'disconnecting', async () => {
      if (factory.selectedHost.getSnapshot() === entry.runtime.hostKey) factory.showLocal()
      try {
        await close(entry)
      } finally {
        entries.delete(host.id)
      }
    })
  }

  function HostRow({ host, editing, removing, edit, confirmRemove, remove, busy }) {
    const entry = entries.get(host.id)
    const available = useStore(entry?.channel.leaseAvailable ?? idle)
    const connection = useStore(entry?.connection.state ?? idle)
    const selected = useStore(factory.selectedHost)
    const phase = operations.get(host.id)?.phase
    const status = phase ?? (entry ? available
      ? connection === 'connected' ? 'connected' : 'connecting'
      : 'offline' : 'disconnected')
    const [label, dot] = display[status]
    const notice = notices.get(host.id)
    return h('li', { style: style.row },
      h('div', { style: style.actions }, h('strong', null, host.label || host.alias),
        h(StateDot, { state: dot }), h('span', null, label),
        entry?.runtime.hostKey === selected && entry && h('span', { style: style.secondary }, '当前会话 Host')),
      h('p', { style: style.secondary }, [host.alias, host.instance, entry?.channel.version].filter(Boolean).join(' · ')),
      notice && h('p', { role: notice.error ? 'alert' : 'status' }, notice.message),
      h('div', { style: style.actions },
        !entry && h(Button, { variant: 'primary', size: 'sm', disabled: Boolean(phase) || editing || removing, onClick: () => connect(host) }, '连接'),
        entry && !available && h(Button, { variant: 'primary', size: 'sm', disabled: Boolean(phase), onClick: () => reconnect(host) }, '重新连接'),
        entry && h(Button, { variant: 'outline', size: 'sm', disabled: Boolean(phase), onClick: () => disconnect(host) }, '断开连接'),
        !entry && h(Button, { size: 'sm', disabled: busy || Boolean(phase), onClick: edit }, '编辑'),
        !entry && h(Button, { size: 'sm', disabled: busy || Boolean(phase),
          onClick: removing ? remove : confirmRemove,
        }, removing ? '确认移除' : '移除'),
        removing && h(Button, { size: 'sm', disabled: busy, onClick: confirmRemove }, '取消移除')))
  }

  function HostPanel() {
    const { hosts, loading, error } = useSyncExternalStore(subscribe, readState)
    const [draft, setDraft] = useState(null)
    const [aliases, setAliases] = useState(null)
    const [removeId, setRemoveId] = useState()
    const [busy, setBusy] = useState(false)
    const [failure, setFailure] = useState('')
    async function configure(action, data, done) {
      setBusy(true)
      setFailure('')
      try {
        const result = await configureParallelHost({ ...local, action, data })
        if (lifetime.signal.aborted) return
        done(result)
        if (action !== 'discover') {
          await refreshing
          await refresh()
        }
      } catch (reason) {
        if (!lifetime.signal.aborted) setFailure(reason.message)
      } finally {
        if (!lifetime.signal.aborted) setBusy(false)
      }
    }
    const field = (name, label, options) => h('label', { key: name, style: { display: 'grid', gap: 4 } }, label,
      h(Input, { ...options, disabled: busy, value: draft[name],
        onChange: event => setDraft({ ...draft, [name]: event.target.value }),
      }))
    return h('section', { style: style.panel, 'aria-label': '远程连接', 'data-dsh-ssh-parallel-manager': true },
      h('div', { style: style.content },
        h('header', { style: style.actions },
          h('h2', { style: { margin: 0, marginRight: 'auto' } }, '远程连接'),
          h(Button, { variant: 'ghost', onClick: () => layout.selectPanel(null) }, '返回会话')),
        h('div', { style: style.actions },
          h(Button, { variant: 'outline', disabled: busy, onClick: () => setDraft(emptyHost) }, '添加主机'),
          h(Button, { disabled: busy, onClick: () => configure('discover', undefined, setAliases) }, '发现 SSH 别名'),
          h(Button, { disabled: loading, onClick: refresh }, '刷新')),
        aliases && h('div', { style: style.actions }, aliases.length
          ? aliases.map(alias => h(Button, { key: alias, size: 'sm', variant: 'outline', disabled: busy,
            onClick: () => setDraft({ ...emptyHost, alias }),
          }, alias)) : '没有发现 SSH 别名。'),
        draft && h('form', { style: style.row, onSubmit(event) {
          event.preventDefault()
          void configure('save', { ...draft, alias: draft.alias.trim(), label: draft.label.trim() || undefined, instance: draft.instance.trim() },
            () => setDraft(null))
        } },
        field('alias', 'SSH 别名或地址', { required: true, maxLength: 255 }),
        field('label', '显示名称', { maxLength: 100 }),
        field('instance', '远程实例', { required: true, maxLength: 64 }),
        h('div', { style: style.actions },
          h(Button, { variant: 'primary', type: 'submit', disabled: busy }, '保存主机'),
          h(Button, { disabled: busy, onClick: () => setDraft(null) }, '取消'))),
        (failure || error) && h('p', { role: 'alert' }, failure || error),
        loading && h('p', { role: 'status' }, '正在读取 SSH 主机…'),
        hosts.length ? h('ul', { 'aria-label': 'SSH 主机', style: { padding: 0, margin: 0, listStyle: 'none', display: 'grid', gap: 8 } },
          ...hosts.map(host => h(HostRow, { key: host.id, host, busy, editing: draft?.id === host.id,
            removing: removeId === host.id,
            edit: () => setDraft({ id: host.id, alias: host.alias, label: host.label || '', instance: host.instance || 'default' }),
            confirmRemove: () => setRemoveId(removeId === host.id ? undefined : host.id),
            remove: () => configure('remove', { id: host.id }, () => setRemoveId(undefined)),
          }))) : !loading && !error && h('p', { style: style.secondary }, '尚未配置 SSH 主机。')))
  }

  function ManagementButton({ wide }) {
    return h(Button, {
      'aria-label': '远程连接', title: '远程连接', variant: 'ghost', size: 'sm',
      icon: h(IconLinkOutlineRegular, { size: 16 }),
      onClick: () => { layout.selectPanel(panelId); void refresh() },
    }, wide ? '远程连接' : undefined)
  }

  ctx.effect(() => () => {
    lifetime.abort()
    listeners.clear()
    return Promise.allSettled([...operations.values()].map(({ current }) => current)).then(async () => {
      const closing = [...entries.values()]
      entries.clear()
      await Promise.allSettled(closing.map(close))
    })
  }, 'remote-ssh: parallel host management')
  slots.inject('main', () => slots.register({ name: 'main', key: panelId }, HostPanel))
  slots.inject(footer, () => slots.register({ name: footer, id: 'dsh-remote-host-ssh.parallel', order: 10 }, ManagementButton))
}
