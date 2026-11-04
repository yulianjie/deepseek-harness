/** Register a small settings surface against the owning Host's native ConfigForms. */
export function installRemoteHostSettings(ctx, { react, primitives, label }) {
  const { createElement: h, useState, useSyncExternalStore } = react
  const { Button, Switch } = primitives
  const title = '远端设置'
  const kind = 'remote-ssh-settings'
  const id = 'dsh-remote-host-ssh.settings'
  const forms = ctx.get('configForms')
  const connection = ctx.get('connection')?.state
  if (!forms || !connection || !ctx.get('hostPageAccess')) return

  const submission = forms.get('ui-conversation')
  const tools = forms.get('ui-settings')
  const observe = source => ({
    subscribe: listener => source.subscribe(listener),
    getSnapshot: () => source.getSnapshot(),
  })
  const submissionState = observe(submission)
  const toolsState = observe(tools)
  const observeConnection = listener => connection.subscribe(listener)
  const connected = () => connection.getSnapshot() === 'connected'
  const writable = form => connected() && form.getSnapshot().status === 'ready' && form.getSnapshot().writable

  function Settings({ canEdit, write, modelsAvailable, renderSlot }) {
    const [pending, setPending] = useState(false)
    const [message, setMessage] = useState('')
    const [showModels, setShowModels] = useState(false)
    const isConnected = useSyncExternalStore(observeConnection, connected)
    const submit = useSyncExternalStore(submissionState.subscribe, submissionState.getSnapshot)
    const developer = useSyncExternalStore(toolsState.subscribe, toolsState.getSnapshot)
    const ready = isConnected && [submit, developer].some(state => state.status === 'ready')
    const loading = [submit, developer].some(state => state.status === 'loading')
    const models = showModels && modelsAvailable

    async function change(field, value) {
      if (pending || !canEdit(field)) return
      setPending(true)
      setMessage('')
      try {
        if (!await write(field, value)) setMessage('远端 Host 拒绝了此次设置修改。')
      } catch {
        setMessage('无法确认设置是否已保存，请核对远端 Host 的当前值。')
      } finally {
        setPending(false)
      }
    }

    return h('section', {
      'aria-label': title,
      style: { height: '100%', minWidth: 0, overflow: 'auto', padding: '12px', display: 'grid', gap: '12px', alignContent: 'start' },
    },
    h('strong', null, title),
    h('span', null, label ? `SSH · ${label}` : 'SSH Host'),
    modelsAvailable && h('div', { 'aria-label': '远端设置类别', style: { display: 'flex', gap: '6px' } },
      h(Button, { size: 'sm', 'aria-pressed': !models, onClick: () => setShowModels(false) }, '会话'),
      h(Button, { size: 'sm', 'aria-pressed': models, onClick: () => setShowModels(true) }, '模型与供应商')),
    !isConnected && h('p', { role: 'status' }, '远端 Host 暂未连接。'),
    models && isConnected && renderSlot('settings.section', { close: () => setShowModels(false) }, { only: 'models' }),
    !models && isConnected && !ready && h('p', { role: 'status' }, loading ? '正在读取远端设置…' : '此 Host 没有可显示的会话设置。'),
    !models && submit.status === 'ready' && h('label', null, '会话忙碌时按 Enter ',
      h('select', {
        'aria-label': '会话忙碌时按 Enter',
        value: submit.value?.busyEnter,
        disabled: pending || !isConnected || !submit.writable,
        onChange: event => { void change('busyEnter', event.target.value) },
      }, h('option', { value: 'queue' }, '加入队列'), h('option', { value: 'steer' }, '引导当前任务'))),
    !models && developer.status === 'ready' && h('div', null,
      h('span', null, '编程工具 '),
      h(Switch, {
        label: '编程工具', checked: developer.value?.enabled === true,
        disabled: pending || !isConnected || !developer.writable,
        onChange: value => { void change('enabled', value) },
      })),
    message && h('p', { role: 'alert' }, message))
  }

  function SettingsButton({ open }) {
    return h(Button, { size: 'sm', type: 'button', onClick: open }, title)
  }

  const fields = new Map([['busyEnter', submission], ['enabled', tools]])
  return ctx.inject(['slots', 'sidebarRightTabs', 'sidebarRight'], scope => {
    scope.effect(() => scope.sidebarRightTabs.register({
      id, kind, title: () => title,
      guide: [{ id: 'preferences', order: 26, title: () => title, description: () => '调整当前 SSH Host 的原生会话设置' }],
    }))
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: id,
      children: { 'settings.section': { kind: 'list', scope: 'root' } },
      inject: () => ({
        modelsAvailable: scope.slots.entries('settings.section').some(entry => entry.options.id === 'models'),
        canEdit: field => fields.has(field) && writable(fields.get(field)),
        async write(field, value) {
          const form = fields.get(field)
          const valid = field === 'busyEnter' ? value === 'queue' || value === 'steer' : typeof value === 'boolean'
          return valid && form !== undefined && writable(form) && await form.set(field, value)
        },
      }),
    }, Settings))
    scope.slots.inject('conversation.session.header.utilities', () => scope.slots.register({
      name: 'conversation.session.header.utilities', id,
      inject: () => ({ open: () => { scope.sidebarRight.openTab(kind) } }),
    }, SettingsButton))
  })
}
