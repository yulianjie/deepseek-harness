/** Host-bound file editing and Git inspection using the existing Companion endpoints. */

// This factory is serialized into the trusted Desktop boot script.
export function createProjectPane({ react, Button, fetch, confirm }) {
  if (typeof fetch !== 'function') throw new TypeError('Remote project pane requires a Host route')
  const { createElement: h, useEffect, useRef, useState, useSyncExternalStore } = react
  const projectTabId = 'dsh-remote-host-ssh.project'
  const projectTabTitle = '远程文件与 Git'
  const lifetime = new AbortController()
  const directorySlots = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']
  const absoluteDirectory = path => /^\/(?!\/)/.test(path) && !path.includes('\0')
  const button = (label, props) => h(Button, { size: 'sm', ...props }, label)
  const css = () => h('style', null, `
    .dsh-ssh-project{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
    .dsh-ssh-project *{box-sizing:border-box}
    .dsh-ssh-project h3,.dsh-ssh-project p{margin:0}
    .dsh-ssh-project h3{font-size:14px;overflow-wrap:anywhere}
    .dsh-ssh-project .dsh-ssh-summary,.dsh-ssh-project small{color:var(--dsw-alias-label-secondary)}
    .dsh-ssh-project .dsh-ssh-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
    .dsh-ssh-project .dsh-ssh-card{margin:10px 0;padding:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
    .dsh-ssh-project .dsh-ssh-list{padding:0;margin:0;list-style:none}
    .dsh-ssh-project [role=alert]{color:var(--dsw-alias-label-error);overflow-wrap:anywhere}
    .dsh-ssh-project{height:100%;overflow:auto;padding:10px;min-width:0}
    .dsh-ssh-project .dsh-ssh-list{max-height:220px;overflow:auto}
    .dsh-ssh-project .dsh-ssh-list button{width:100%;justify-content:flex-start;text-align:left;overflow-wrap:anywhere}
    .dsh-ssh-project .dsh-ssh-list button[aria-current=true]{background:var(--dsw-alias-bg-layer-2)}
    .dsh-ssh-project textarea,.dsh-ssh-project pre{margin:6px 0;width:100%;font:12px/1.5 ui-monospace,monospace;tab-size:4}
    .dsh-ssh-project textarea{min-height:160px;resize:vertical;padding:6px;color:inherit;background:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:6px}
    .dsh-ssh-project pre{overflow:auto;white-space:pre;max-height:55vh}
    .dsh-ssh-project .dsh-ssh-summary{overflow-wrap:anywhere}
    .dsh-ssh-directory{width:min(560px,90vw);max-height:80vh;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
    .dsh-ssh-directory::backdrop{background:var(--dsw-alias-bg-mask-1)}
    .dsh-ssh-directory .dsh-ssh-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
    .dsh-ssh-directory .dsh-ssh-entries{max-height:36vh;overflow:auto;display:grid;gap:4px;padding:4px 0;list-style:none}
    .dsh-ssh-directory .dsh-ssh-entries button{width:100%;justify-content:flex-start;text-align:left}
    .dsh-ssh-directory input{width:100%;padding:5px 8px;background:inherit;color:inherit;font:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:6px}
  `)

  async function projectRequest(endpoint, root, { query, data, signal }) {
    const search = query && new URLSearchParams({ ...query, root })
    const response = await fetch('api/dsh-remote-ssh/' + endpoint + (search ? '?' + search : ''), {
      cache: 'no-store', credentials: 'same-origin', signal,
      ...(data && { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, root }) }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload) {
      const error = new Error(payload?.error || '远程项目没有返回有效结果。')
      error.status = response.status
      throw error
    }
    return payload
  }

  const versionPattern = /^[0-9a-f]{64}$/
  const dirty = file => Boolean(file && file.content !== file.baseline)
  const fileName = name => typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)

  function editorFile(file, path) {
    if (file.path !== path || typeof file.content !== 'string' || !versionPattern.test(file.version ?? '')) {
      throw new Error('远程文件返回了无效的版本或内容。')
    }
    const endings = new Set(file.content.match(/\r\n|\r|\n/g))
    const baseline = file.content.replace(/\r\n?/g, '\n')
    return { path, version: file.version, baseline, content: baseline,
      newline: endings.size === 1 ? endings.values().next().value : '\n', mixed: endings.size > 1 }
  }

  function createProjectEditors() {
    const models = new Map()
    function forSession(sessionId, root) {
      const key = JSON.stringify([sessionId, root])
      if (models.has(key)) return models.get(key)
      const listeners = new Set()
      let views = 0
      let state = { directory: null, file: null, busy: null, error: '', conflict: '', view: 'files', git: null }
      const update = patch => {
        state = { ...state, ...patch }
        for (const listener of listeners) listener()
      }
      const unconfirmed = { conflict: '无法确认保存结果。草稿已保留，请重新读取远程文件核对。' }
      const prune = () => {
        if (views || state.busy) return
        if (dirty(state.file)) update({ directory: null, git: null, view: 'files' })
        else if (models.get(key) === model) models.delete(key)
      }
      async function run(kind, signal, operation) {
        if (state.busy || signal.aborted) return
        update({ busy: kind, error: '' })
        try {
          const patch = await operation()
          if (!signal.aborted) update(patch)
        } catch (reason) {
          if (!signal.aborted) {
            if (kind === 'save' && reason?.status === 409) {
              update({ conflict: '远程文件已有新版本。草稿已保留，请核对后重新读取。' })
            } else if (kind === 'save' && (!reason?.status || reason.status >= 500)) update(unconfirmed)
            else update({ error: reason?.message || '远程操作失败。' })
          }
        } finally {
          if (kind === 'save' && signal.aborted) update(unconfirmed)
          update({ busy: null })
          prune()
        }
      }
      const model = {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        retain() {
          views++
          return () => { views--; prune() }
        },
        browse(path, signal) {
          return run('read', signal, async () => {
            const directory = await projectRequest('directories', root, { query: { path }, signal })
            if (directory.path !== path || !Array.isArray(directory.entries)) throw new Error('远程目录返回了无效的路径。')
            return { directory: { ...directory, entries: directory.entries.filter(entry => fileName(entry?.name)) } }
          })
        },
        open(path, signal, reload = false) {
          if (!reload && path === state.file?.path) { update({ view: 'files' }); return }
          if (dirty(state.file) && !confirm('当前文件有未保存的修改。放弃草稿并继续？')) return
          return run('read', signal, async () => {
            const file = editorFile(await projectRequest('files', root, { query: { path }, signal }), path)
            return { file, view: 'files', conflict: '' }
          })
        },
        change(content) {
          if (!state.file || state.busy) return
          update({ file: { ...state.file, content } })
        },
        save(signal) {
          const file = state.file
          if (!dirty(file) || state.conflict) return
          if (file.mixed && !confirm('此文件使用混合换行符。保存将统一为 LF。继续？')) return
          return run('save', signal, async () => {
            const content = file.content.replaceAll('\n', file.newline)
            const saved = await projectRequest('files', root, { signal,
              data: { path: file.path, content, expectedVersion: file.version } })
            if (saved.path !== file.path || !versionPattern.test(saved.version ?? '')) {
              throw new Error('远程保存没有返回有效版本。')
            }
            return { file: { ...file, baseline: file.content, version: saved.version, mixed: false }, conflict: '' }
          })
        },
        show(view) { if (!state.busy) update({ view }) },
        git(kind, staged, signal) {
          return run('git', signal, async () => {
            const result = await projectRequest('git', root, { query: { kind, path: '', staged: String(staged) }, signal })
            if (typeof result.text !== 'string') throw new Error('远程 Git 返回了无效结果。')
            return { git: { kind, staged, text: result.text } }
          })
        },
      }
      models.set(key, model)
      return model
    }
    return {
      forSession,
      dirty: () => Array.from(models.values()).some(model => dirty(model.getSnapshot().file)),
      saving: () => Array.from(models.values()).some(model => model.getSnapshot().busy === 'save'),
    }
  }

  function ProjectBody({ sessionId, useSessions, useTabInfo, availability, keepSaving }) {
    const root = useSessions(sessions => sessions.byId[sessionId]?.cwd)
    const { tab } = useTabInfo()
    if (typeof root !== 'string' || !/^\/(?!\/)/.test(root) || root.includes('\0')) {
      return h('p', { role: 'status' }, '等待当前会话的远程工作目录…')
    }
    return h(ProjectEditor, { key: JSON.stringify([sessionId, root]), model: editors.forSession(sessionId, root), root, tab, availability, keepSaving })
  }

  function ProjectEditor({ model, root, tab, availability, keepSaving }) {
    const connected = useSyncExternalStore(availability.subscribe, availability.getSnapshot)
    const state = useSyncExternalStore(model.subscribe, model.getSnapshot)
    const viewport = useRef(null)
    const visible = tab.visible && !tab.signal.aborted && connected && !lifetime.signal.aborted
    useEffect(() => model.retain(), [model])
    useEffect(() => {
      if (!visible) return
      const controller = new AbortController()
      viewport.current = { model, signal: AbortSignal.any([tab.signal, controller.signal]) }
      return () => { controller.abort(); viewport.current = null }
    }, [model, visible, tab.signal])
    useEffect(() => {
      if (visible && !state.directory && !state.busy && !state.error) void start(signal => model.browse('', signal))
    }, [model, visible, state])

    function currentSignal() {
      const viewportState = viewport.current
      if (viewportState?.model === model && !viewportState.signal.aborted &&
        availability.getSnapshot() && !lifetime.signal.aborted) return viewportState.signal
    }

    function start(run) {
      const signal = currentSignal()
      if (signal && !model.getSnapshot().busy) return run(signal)
    }

    const { file, directory, view, git, busy, conflict, error } = state
    const disabled = !visible || Boolean(busy)
    const parents = directory?.path ? directory.path.split('/') : []
    const browse = path => start(signal => model.browse(path, signal))
    const open = (path, reload) => start(signal => model.open(path, signal, reload))
    const inspect = (kind, staged = false) => start(signal => model.git(kind, staged, signal))
    return h('section', { className: 'dsh-ssh dsh-ssh-project', 'aria-label': projectTabTitle }, css(),
      h('h3', null, projectTabTitle), h('p', { className: 'dsh-ssh-summary', title: root }, root),
      h('div', { className: 'dsh-ssh-actions' },
        button('文件', { variant: view === 'files' ? 'outline' : 'ghost', disabled,
          'aria-pressed': view === 'files', onClick: () => model.show('files') }),
        button('Git', { variant: view === 'git' ? 'outline' : 'ghost', disabled,
          'aria-pressed': view === 'git', onClick: () => model.show('git') })),
      error && h('p', { role: 'alert' }, error),
      busy && h('p', { role: 'status' }, busy === 'save' ? '正在保存到远程 Host…' : '正在读取远程项目…'),
      view === 'git' ? h('div', null, h('p', { className: 'dsh-ssh-summary' }, '当前目录所在的 Git 仓库'),
        h('div', { className: 'dsh-ssh-actions' },
          button('状态', { disabled, onClick: () => inspect('status') }),
          button('未暂存差异', { disabled, onClick: () => inspect('diff') }),
          button('已暂存差异', { disabled, onClick: () => inspect('diff', true) }),
          git && button('刷新 Git', { disabled, onClick: () => inspect(git.kind, git.staged) })),
        git && h('pre', { tabIndex: 0, 'aria-label': '远程 Git 输出' }, git.text || '没有输出。'))
        : h('div', null,
          h('div', { className: 'dsh-ssh-actions', 'aria-label': '目录导航' },
            button('项目根目录', { disabled, onClick: () => browse('') }),
            parents.map((part, index) => {
              const path = parents.slice(0, index + 1).join('/')
              return button(part, { key: path, disabled, onClick: () => browse(path) })
            }),
            button('刷新目录', { disabled, onClick: () => browse(directory?.path ?? '') })),
          directory && h('ul', { className: 'dsh-ssh-list', 'aria-label': '远程文件树' }, directory.entries.map(entry => {
            const path = directory.path ? directory.path + '/' + entry.name : entry.name
            const isDirectory = entry.kind === 'directory'
            return h('li', { key: path }, button(entry.name, { disabled: disabled || (!isDirectory && entry.kind !== 'file'),
              title: path, 'aria-current': path === file?.path || undefined,
              'aria-label': (isDirectory ? '打开目录 ' : entry.kind === 'file' ? '打开文件 ' : '无法编辑 ') + entry.name,
              onClick: () => isDirectory ? browse(path) : open(path) }))
          })),
          file && h('div', { className: 'dsh-ssh-card' },
            h('h3', null, file.path),
            dirty(file) && h('small', null, '有未保存的修改 · 草稿只保留在当前窗口'),
            conflict && h('p', { role: 'alert' }, conflict),
            h('textarea', { 'aria-label': '远程文件内容', value: file.content, rows: 10, spellCheck: false,
              readOnly: disabled, onChange: event => { if (!disabled && currentSignal()) model.change(event.target.value) } }),
            h('div', { className: 'dsh-ssh-actions' },
              button('保存', { variant: 'primary', disabled: disabled || !dirty(file) || Boolean(conflict),
                onClick: () => start(signal => model.save(keepSaving ? lifetime.signal : signal)) }),
              button('重新读取', { disabled, onClick: () => open(file.path, true) })))))
  }

  function DirectoryFlow({ availability, listDirectory, open, busy, onPicked, onCancel }) {
    const ready = useSyncExternalStore(availability.subscribe, availability.getSnapshot)
    const dialog = useRef(null)
    const [path, setPath] = useState(undefined)
    const [typed, setTyped] = useState('')
    const [listing, setListing] = useState(null)
    const [error, setError] = useState('')
    useEffect(() => {
      if (!open) { setPath(undefined); return }
      if (!ready) return
      const node = dialog.current
      node?.showModal()
      return () => node?.close()
    }, [open, ready])
    useEffect(() => {
      if (!open || !ready) return
      const controller = new AbortController()
      setListing(null)
      setError('')
      Promise.resolve().then(() => listDirectory(path, controller.signal)).then(result => {
        if (controller.signal.aborted) return
        if (typeof result?.path !== 'string' || !absoluteDirectory(result.path)) throw new Error('远程目录路径无效。')
        setListing(result)
        setTyped(result.path)
      }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
      return () => controller.abort()
    }, [open, path, ready, listDirectory])
    if (!open || !ready) return null
    const loading = !listing && !error
    const choose = next => {
      if (busy || !absoluteDirectory(next) || next === path || !availability.getSnapshot()) return
      setListing(null)
      setPath(next)
    }
    return h('dialog', { ref: dialog, className: 'dsh-ssh-directory', 'aria-label': '选择远程工作区目录',
      onCancel: event => { event.preventDefault(); if (!busy) onCancel() } }, css(),
    h('h2', null, '选择远程工作区目录'),
    h('form', { onSubmit: event => { event.preventDefault(); choose(typed.trim()) } },
      h('label', null, '远程路径', h('input', { value: typed, onChange: event => setTyped(event.target.value), disabled: !ready || busy })),
      button('前往', { type: 'submit', disabled: !ready || busy || !absoluteDirectory(typed.trim()) })),
    loading && h('p', { role: 'status' }, '正在读取目录…'),
    error && h('p', { role: 'alert' }, error),
    listing && h('div', { className: 'dsh-ssh-actions', 'aria-label': '上级目录' }, listing.crumbs.map(entry =>
      button(entry.name, { key: entry.path, disabled: busy, onClick: () => choose(entry.path) }))),
    listing && h('ul', { className: 'dsh-ssh-entries' }, listing.entries.map(entry => h('li', { key: entry.path },
      button(entry.name, { disabled: busy, onClick: () => choose(entry.path) })))),
    listing?.truncated && h('small', null, '此目录的子目录较多。可直接输入完整路径。'),
    h('div', { className: 'dsh-ssh-actions' },
      button('打开远程目录', { variant: 'primary', disabled: busy || !ready || !listing,
        onClick: () => { if (availability.getSnapshot() && listing && !busy) onPicked(listing.path) } }),
      button('取消', { disabled: busy, onClick: onCancel })))
  }

  const editors = createProjectEditors()

  return {
    dirty: editors.dirty,
    saving: editors.saving,
    install(ctx, legacyRoute) {
      const connection = legacyRoute === undefined ? ctx.get('connection')?.state : undefined
      const availability = legacyRoute === undefined
        ? {
          subscribe: listener => connection?.subscribe(listener) ?? (() => {}),
          getSnapshot: () => connection?.getSnapshot() === 'connected',
        }
        : {
          subscribe: legacyRoute.subscribe,
          getSnapshot: () => {
            const current = legacyRoute.getSnapshot()
            return legacyRoute.matching(current.route) && !current.pending
          },
        }
      ctx.effect(() => () => lifetime.abort(), 'remote-ssh: project editor lifetime')
      const listDirectory = (path, signal) => ctx.get('uiWorkspace').listDirectory(path, signal)
      for (const name of directorySlots) ctx.slots.inject(name, () => ctx.slots.register({
        name, priority: legacyRoute === undefined ? 100 : -100,
        inject: () => ({ availability, listDirectory }),
      }, DirectoryFlow))
      return ctx.inject(['slots', 'sidebarRightTabs'], scope => {
        scope.effect(() => scope.sidebarRightTabs.register({
          id: projectTabId, kind: 'remote-ssh-project', title: () => projectTabTitle,
          guide: [{ id: 'project', order: 25, title: () => projectTabTitle, description: () => '编辑当前远程会话目录中的文本文件，查看 Git 状态和差异' }],
        }))
        scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab', key: projectTabId,
        }, props => h(ProjectBody, { ...props, availability, keepSaving: legacyRoute === undefined })))
      })
    },
  }
}
