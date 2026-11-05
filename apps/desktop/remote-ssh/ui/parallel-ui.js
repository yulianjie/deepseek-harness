/** Host management. Keep this function self-contained for the trusted local boot script. */

export function apply(ctx, {
  react, primitives, openParallelHost, listParallelHosts, configureParallelHost, isHostIdentity,
  createProjectPane, installRemoteHostSettings, transport, baseUrl,
}) {
  const panelId = 'remote-host-ssh'
  const panelList = 'sidebar.panellist'
  const panelTitle = '远程连接'
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
  const emptyHost = { alias: '', label: '', instance: 'default', authMode: 'config', identityFile: '' }
  const authLabels = { config: 'OpenSSH 配置', key: '私钥文件', password: '密码' }
  const passwordWarnings = {
    SSH_PASSWORD_STORE_FAILED: 'SSH 已连接，但密码未能保存。请检查系统凭据存储。',
    SSH_PASSWORD_FORGET_FAILED: 'SSH 已连接，但先前记住的密码未能移除。请检查系统凭据存储后重试。',
  }
  const restoreKey = 'dsh.remote-ssh.restore.'
  const display = {
    connected: ['已连接', 'done'],
    checking: ['正在检查已保存的工作区', 'ongoing'],
    connecting: ['正在连接', 'ongoing'],
    reconnecting: ['正在重连', 'ongoing'],
    disconnecting: ['正在断开', 'ongoing'],
    offline: ['连接已断开', 'warning'],
    disconnected: ['未连接', 'idle'],
  }
  const local = { transport, baseUrl, signal: lifetime.signal }
  let state = { hosts: [], loading: false, error: '', restoreWarning: '' }
  let refreshing
  let startupPending = true

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

  function warnAboutRestoreStorage() {
    if (!state.restoreWarning) update({ restoreWarning: '无法读写 SSH 工作区的启动恢复记录。可在此手动连接。' })
  }

  // An absent record permits legacy discovery. Null skips startup restore for this configuration.
  function restoreTarget(id) {
    try {
      const record = globalThis.localStorage.getItem(restoreKey + id)
      if (record === null) return undefined
      const expected = JSON.parse(record)
      if (expected !== null && !isHostIdentity(expected)) throw new Error('Invalid SSH restore identity')
      return expected
    } catch (error) {
      warnAboutRestoreStorage()
      return null
    }
  }

  function rememberRestoreTarget(id, expected) {
    try {
      if (expected === undefined) globalThis.localStorage.removeItem(restoreKey + id)
      else globalThis.localStorage.setItem(restoreKey + id, JSON.stringify(expected))
    } catch (error) {
      warnAboutRestoreStorage()
    }
  }

  function trackRestoreTarget(id, source, identity) {
    let hasProjects
    const observe = () => {
      if (lifetime.signal.aborted) return
      const { phase, state, items } = source.getSnapshot()
      if (phase !== 'ready' || state !== 'idle') return
      const next = items.length > 0
      if (next === hasProjects) return
      hasProjects = next
      rememberRestoreTarget(id, next ? identity : null)
    }
    const stop = source.subscribe(observe)
    observe()
    return stop
  }

  function restoreHosts(hosts) {
    for (const host of hosts) {
      const expected = restoreTarget(host.id)
      if (expected === null) continue
      if (host.authMode !== 'password' || host.passwordState === 'saved') {
        connect(host, { expected, probe: expected === undefined })
      } else if (expected !== undefined) {
        const prompt = '输入 SSH 登录密码以恢复此主机上的工作区。'
        const message = host.passwordState === 'unavailable' ? `系统凭据存储不可用。${prompt}` : prompt
        notices.set(host.id, { message })
      }
    }
  }

  function refresh() {
    if (lifetime.signal.aborted) return
    if (refreshing) return refreshing
    update({ loading: true, error: '' })
    refreshing = listParallelHosts(local).then(hosts => {
      if (lifetime.signal.aborted) return
      if (startupPending) {
        startupPending = false
        restoreHosts(hosts)
      }
      update({ hosts })
    }).catch(error => {
      if (!lifetime.signal.aborted) update({ error: error.message })
    }).finally(() => {
      refreshing = undefined
      if (!lifetime.signal.aborted) update({ loading: false })
    })
    return refreshing
  }

  function run(id, phase, task, refreshPasswords = false) {
    if (lifetime.signal.aborted || operations.has(id)) return
    notices.delete(id)
    const current = Promise.resolve().then(() => {
      lifetime.signal.throwIfAborted()
      return task()
    }).catch(error => {
      if (!lifetime.signal.aborted) notices.set(id, { error: true, message: error.message, upgrade: error.upgrade })
    }).finally(async () => {
      if (refreshPasswords) await refresh()
      operations.delete(id)
      if (!lifetime.signal.aborted) update()
    })
    operations.set(id, { phase, current })
    update()
    return current
  }

  async function close(entry) {
    entry.stopRestoreTracking?.()
    try {
      await entry.channel.close()
    } finally {
      await entry.runtime?.dispose()
    }
  }

  function connect(host, { expected, probe = false, password, rememberPassword, upgradeFrom } = {}) {
    if (entries.has(host.id)) return
    run(host.id, probe ? 'checking' : 'connecting', async () => {
      if (probe) {
        const result = await configureParallelHost({ ...local, action: 'restore-probe', data: { id: host.id } })
        lifetime.signal.throwIfAborted()
        expected = result.expected
        rememberRestoreTarget(host.id, expected)
        if (expected === null) return
        operations.get(host.id).phase = 'connecting'
        update()
      }
      const { status } = host
      if (expected === undefined && isHostIdentity(status)) {
        expected = { hostId: status.hostId, instanceId: status.instanceId }
      }
      const opening = openParallelHost({ ...local, id: host.id, expected, password, rememberPassword, upgradeFrom })
      password = undefined
      const channel = await opening
      const warning = passwordWarnings[channel.passwordWarning]
      if (warning) notices.set(host.id, { error: true, message: warning })
      if (rememberPassword && !warning && expected === undefined) rememberRestoreTarget(host.id)
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
        entry.stopRestoreTracking = trackRestoreTarget(host.id, scope.get('workspaces').list, {
          hostId: channel.hostId, instanceId: channel.instanceId,
        })
        entries.set(host.id, entry)
      } catch (error) {
        await close(entry)
        throw error
      }
    }, host.authMode === 'password')
  }

  function reconnect(host, { expected, password, rememberPassword, upgradeFrom } = {}) {
    const entry = entries.get(host.id)
    if (!entry) return connect(host, { expected, password, rememberPassword, upgradeFrom })
    run(host.id, 'reconnecting', async () => {
      // Abort the old event consumers before publishing a new answer Peer.
      entry.connection.reconnect()
      const opening = entry.channel.reconnect({ signal: lifetime.signal, password, rememberPassword, upgradeFrom })
      password = undefined
      const { bootChanged } = await opening
      lifetime.signal.throwIfAborted()
      // Its normal retry loop claims the new lease. A second forced reset
      // could close the replacement if the loop already opened its socket.
      const warning = passwordWarnings[entry.channel.passwordWarning]
      const bootNotice = bootChanged ? '远端 Harness 已重启，先前的终端进程和待提交附件可能需要重新打开。' : ''
      const message = [warning, bootNotice].filter(Boolean).join(' ')
      if (message) notices.set(host.id, { error: Boolean(warning), message })
    }, host.authMode === 'password')
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

  function HostRow({ host, editing, removing, edit, confirmRemove, remove, forget, busy }) {
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
    const authMode = host.authMode ?? 'config'
    const needsConnection = !entry || !available
    const blocked = Boolean(phase) || editing || removing
    const upgrade = notice?.upgrade
    const connectLabel = upgrade ? '重启并升级' : entry ? '重新连接' : '连接'
    const start = entry ? reconnect : connect
    function startConnection(options) {
      if (upgrade) {
        if (!globalThis.confirm('升级会重启此远程实例。已保存的项目和会话会保留，运行中的任务和终端可能中断。确定继续？')) return false
        const { hostId, instanceId, bootId } = upgrade
        start(host, { ...options, expected: { hostId, instanceId }, upgradeFrom: bootId })
      } else {
        start(host, options)
      }
      return true
    }
    const passwordForm = authMode === 'password' && needsConnection && !editing && !removing
    const passwordSaved = host.passwordState === 'saved'
    const passwordUnavailable = host.passwordState === 'unavailable'
    const instanceLabel = host.instance !== 'default' && `实例 ${host.instance}`
    return h('li', { style: style.row },
      h('div', { style: style.actions }, h('strong', null, host.label || host.alias),
        h(StateDot, { state: dot }), h('span', null, label),
        entry?.runtime.hostKey === selected && entry && h('span', { style: style.secondary }, '当前会话 Host')),
      h('p', { style: style.secondary }, [host.alias, instanceLabel, authLabels[authMode], entry?.channel.version].filter(Boolean).join(' · ')),
      passwordSaved && h('p', { style: style.secondary }, '密码已保存在系统凭据存储中。'),
      passwordUnavailable && h('p', { style: style.secondary }, '系统凭据存储不可用，可手动输入密码。'),
      notice && h('p', { role: notice.error ? 'alert' : 'status' }, notice.message),
      h('div', { style: style.actions },
        passwordForm && passwordSaved && h(Button, { variant: 'primary', size: 'sm', disabled: blocked || busy,
          onClick: () => startConnection({ expected: restoreTarget(host.id) ?? undefined }),
        }, upgrade ? '使用已记住的密码升级' : entry ? '使用已记住的密码重连' : '使用已记住的密码连接'),
        passwordForm && h('form', { key: host.passwordState, style: style.actions, autoComplete: 'off', onSubmit(event) {
          event.preventDefault()
          const form = event.currentTarget
          const data = new FormData(form)
          const password = data.get('ssh-password')
          const rememberPassword = data.has('remember-password') || (passwordSaved ? false : undefined)
          if (!blocked && !busy && password && startConnection({ password, rememberPassword })) form.reset()
        } },
        h(Input, { type: 'password', name: 'ssh-password', 'aria-label': 'SSH 登录密码', placeholder: 'SSH 登录密码',
          autoComplete: 'off', required: true, maxLength: 1023, disabled: blocked || busy }),
        h('label', null, h('input', { type: 'checkbox', name: 'remember-password', defaultChecked: passwordSaved,
          disabled: blocked || busy || passwordUnavailable,
        }), '记住密码'),
        h(Button, { variant: passwordSaved ? 'outline' : 'primary', size: 'sm', type: 'submit', disabled: blocked || busy }, connectLabel)),
        authMode !== 'password' && needsConnection && h(Button, {
          variant: 'primary', size: 'sm', disabled: blocked, onClick: () => startConnection(),
        }, connectLabel),
        entry && h(Button, { variant: 'outline', size: 'sm', disabled: Boolean(phase), onClick: () => disconnect(host) }, '断开连接'),
        passwordSaved && !editing && !removing && h(Button, { size: 'sm', disabled: busy || Boolean(phase), onClick: forget }, '忘记密码'),
        !entry && h(Button, { size: 'sm', disabled: busy || Boolean(phase), onClick: edit }, '编辑'),
        !entry && h(Button, { size: 'sm', disabled: busy || Boolean(phase),
          onClick: removing ? remove : confirmRemove,
        }, removing ? '确认移除' : '移除'),
        removing && h(Button, { size: 'sm', disabled: busy, onClick: confirmRemove }, '取消移除')))
  }

  function HostPanel() {
    const { hosts, loading, error, restoreWarning } = useSyncExternalStore(subscribe, readState)
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
        if (action === 'remove') {
          rememberRestoreTarget(data.id)
          notices.delete(data.id)
        }
        if (action === 'forget-password') notices.delete(data.id)
        if (action === 'save') {
          const { id, alias, instance, authMode, identityFile } = result.host
          const previous = hosts.find(host => host.id === id)
          if (!previous || previous.alias !== alias || previous.instance !== instance) rememberRestoreTarget(id, null)
          if (!previous || previous.alias !== alias || previous.instance !== instance ||
              previous.authMode !== authMode || previous.identityFile !== identityFile) notices.delete(id)
        }
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
    return h('section', { style: style.panel, 'aria-label': panelTitle, 'data-dsh-ssh-parallel-manager': true },
      h('div', { style: style.content },
        h('header', { style: style.actions },
          h('h2', { style: { margin: 0, marginRight: 'auto' } }, panelTitle),
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
          const { id, alias, label, instance, authMode, identityFile } = draft
          void configure('save', {
            id, alias: alias.trim(), label: label.trim() || undefined, instance: instance.trim() || 'default', authMode,
            identityFile: authMode === 'key' ? identityFile : undefined,
          }, () => setDraft(null))
        } },
        field('alias', 'SSH 别名或地址', { required: true, maxLength: 255 }),
        field('label', '显示名称', { maxLength: 100 }),
        h('fieldset', { style: { border: 0, padding: 0, margin: 0, minWidth: 0 }, disabled: busy },
          h('legend', null, '身份验证方式'),
          h('div', { style: style.actions }, Object.entries(authLabels).map(([value, label]) =>
            h('label', { key: value }, h('input', { type: 'radio', name: 'authMode', value,
              checked: draft.authMode === value, onChange: () => setDraft({ ...draft, authMode: value }),
            }), label)))),
        draft.authMode === 'key' && field('identityFile', '本机私钥路径', {
          required: true, maxLength: 2048, placeholder: '~/.ssh/id_ed25519',
        }),
        draft.authMode === 'password' && h('p', { style: style.secondary }, '连接时可选择将密码保存在本机的系统凭据存储中。'),
        h('details', null,
          h('summary', null, draft.instance && draft.instance !== 'default' ? `高级选项 · 远程实例 ${draft.instance}` : '高级选项'),
          field('instance', '远程实例名称', { maxLength: 64, placeholder: 'default' }),
          h('p', { style: style.secondary }, '同一 SSH 账号可使用不同实例分别保存项目和会话。留空使用默认实例，更改名称会切换到另一套项目和会话。')),
        h('div', { style: style.actions },
          h(Button, { variant: 'primary', type: 'submit', disabled: busy }, '保存主机'),
          h(Button, { disabled: busy, onClick: () => setDraft(null) }, '取消'))),
        (failure || error) && h('p', { role: 'alert' }, failure || error),
        restoreWarning && h('p', { role: 'alert' }, restoreWarning),
        loading && h('p', { role: 'status' }, '正在读取 SSH 主机…'),
        hosts.length ? h('ul', { 'aria-label': 'SSH 主机', style: { padding: 0, margin: 0, listStyle: 'none', display: 'grid', gap: 8 } },
          ...hosts.map(host => h(HostRow, { key: host.id, host, busy, editing: draft?.id === host.id,
            removing: removeId === host.id,
            edit: () => setDraft({ id: host.id, alias: host.alias, label: host.label || '', instance: host.instance || 'default',
              authMode: host.authMode ?? 'config', identityFile: host.identityFile ?? '' }),
            confirmRemove: () => setRemoveId(removeId === host.id ? undefined : host.id),
            remove: () => configure('remove', { id: host.id }, () => setRemoveId(undefined)),
            forget: () => configure('forget-password', { id: host.id }, () => {}),
          }))) : !loading && !error && h('p', { style: style.secondary }, '尚未配置 SSH 主机。')))
  }

  function ManagementIcon({ size }) {
    return h(IconLinkOutlineRegular, { size })
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
  slots.inject(panelList, () => slots.register({ name: panelList, id: panelId, order: 1, label: panelTitle }, ManagementIcon))
  ctx.effect(() => {
    const { panelInfo } = layout
    let previous
    function panelChanged() {
      const { activePanelId } = panelInfo.getSnapshot()
      if (activePanelId === previous) return
      previous = activePanelId
      if (activePanelId === panelId) void refresh()
    }
    const unsubscribe = panelInfo.subscribe(panelChanged)
    void refresh()
    panelChanged()
    return unsubscribe
  }, 'remote-ssh: restore hosts at startup and refresh when opening manager')
}
