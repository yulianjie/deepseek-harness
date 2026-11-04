const byId = id => document.getElementById(id)
const api = '/api/dsh-remote-ssh'
const fields = {
  root: byId('root-path'),
  entries: byId('entries'),
  empty: byId('tree-empty'),
  breadcrumbs: byId('breadcrumbs'),
  content: byId('content'),
  notice: byId('notice'),
  save: byId('save-file'),
  reload: byId('reload-file'),
  dialog: byId('create-dialog'),
  name: byId('new-name'),
}
const state = { busy: false, home: '', root: '', directory: '', entries: [], file: null, creating: null }
const remoteButtons = [...document.querySelectorAll('[data-remote]')]

class RemoteError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function request(path, { query, method = 'GET', data } = {}) {
  const search = query ? '?' + new URLSearchParams(query) : ''
  const response = await fetch(api + path + search, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const payload = await response.json().catch(() => null)
  if (response.status === 401 || (response.status === 403 && !payload?.error)) {
    throw new RemoteError(response.status, '远程会话认证已失效，请从本地远程连接页重新打开。')
  }
  if (!response.ok || !payload) {
    throw new RemoteError(response.status, payload?.error || '远程实例未返回有效结果。')
  }
  return payload
}

function notice(message, isError = false) {
  fields.notice.textContent = message
  fields.notice.hidden = !message
  fields.notice.dataset.error = String(isError)
}

function isDirty() {
  return state.file && fields.content.value !== state.file.baseline
}

function mayDiscard() {
  return !isDirty() || window.confirm('当前文件有未保存的修改。要放弃这些修改吗？')
}

function updateControls() {
  for (const button of remoteButtons) {
    button.disabled = state.busy || !state.home
  }
  byId('home').disabled ||= !state.home
  for (const id of ['refresh', 'new-file', 'new-directory', 'git-status', 'git-diff']) {
    byId(id).disabled ||= !state.root
  }
  fields.save.disabled ||= !state.file || (!isDirty() && state.file.version !== null)
  fields.reload.disabled ||= !state.file || (state.file.version === null && byId('conflict').hidden)
  fields.content.readOnly = state.busy
  for (const button of document.querySelectorAll('.entry[data-action], #breadcrumbs button')) {
    button.disabled = state.busy
  }
  byId('editor-status').textContent = !state.file ? ''
    : state.file.version === null ? '新文件 · 尚未写入'
    : isDirty() ? '有未保存的修改' : '与远程版本一致'
}

async function operate(action) {
  if (state.busy) return
  state.busy = true
  updateControls()
  notice('')
  try {
    await action()
  } catch (error) {
    notice(error.message || '远程操作失败。', true)
  } finally {
    state.busy = false
    updateControls()
  }
}

function selectView(view) {
  byId('editor-view').hidden = view !== 'editor'
  byId('git-view').hidden = view !== 'git'
  byId('edit-tab').setAttribute('aria-pressed', String(view === 'editor'))
  byId('git-tab').setAttribute('aria-pressed', String(view === 'git'))
}

function makeButton(label, onClick) {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  element.addEventListener('click', onClick)
  return element
}

function childPath(parent, name) {
  return parent ? parent + '/' + name : name
}

function renderDirectory() {
  const parts = state.directory ? state.directory.split('/') : []
  const breadcrumbs = [makeButton('项目根目录', () => operate(() => openDirectory('')))]
  for (const [index, part] of parts.entries()) {
    const path = parts.slice(0, index + 1).join('/')
    const separator = document.createElement('span')
    separator.setAttribute('aria-hidden', 'true')
    separator.textContent = '›'
    breadcrumbs.push(separator, makeButton(part, () => operate(() => openDirectory(path))))
  }
  fields.breadcrumbs.replaceChildren(...breadcrumbs)
  fields.empty.textContent = '当前目录为空。'
  fields.empty.hidden = state.entries.length > 0
  const list = document.createDocumentFragment()
  const kinds = { directory: '目录', file: '文件', symlink: '符号链接', other: '其他' }
  for (const { name, kind } of state.entries) {
    const path = childPath(state.directory, name)
    const item = document.createElement('li')
    const button = makeButton('', () => {
      if (kind === 'directory') void operate(() => openDirectory(path))
      if (kind === 'file' && mayDiscard()) void operate(() => openFile(path))
    })
    button.className = 'entry'
    if (kind === 'file' || kind === 'directory') button.dataset.action = kind
    else button.disabled = true
    if (state.file?.path === path) button.setAttribute('aria-current', 'true')
    const icon = document.createElement('span')
    icon.className = 'entry-icon'
    icon.textContent = kind === 'directory' ? '▸' : kind === 'symlink' ? '↗' : '▪'
    icon.setAttribute('aria-hidden', 'true')
    const title = document.createElement('span')
    title.textContent = name
    const type = document.createElement('span')
    type.className = 'entry-kind'
    type.textContent = kinds[kind] || '其他'
    button.append(icon, title, type)
    item.append(button)
    list.append(item)
  }
  fields.entries.replaceChildren(list)
  updateControls()
}

async function openDirectory(path, root = state.root) {
  const directory = await request('/directories', { query: { root, path } })
  state.root = root
  state.directory = directory.path
  state.entries = directory.entries
  renderDirectory()
}

async function openRoot(root) {
  if (!root.startsWith('/')) {
    notice('请输入 Linux 远程主机上的绝对路径。', true)
    return
  }
  if (!mayDiscard()) return
  await operate(async () => {
    await openDirectory('', root)
    fields.root.value = root
    byId('git-path').value = ''
    byId('git-output').textContent = '选择“状态”或“差异”以查询远程仓库。'
    showFile(null)
  })
}

function showFile(file) {
  byId('editor').hidden = !file
  byId('editor-empty').hidden = Boolean(file)
  byId('conflict').hidden = true
  byId('editor-path').textContent = file?.path ?? ''
  fields.content.value = file?.content ?? ''
  state.file = file && {
    path: file.path,
    version: file.version,
    baseline: fields.content.value,
    lineEnding: file.content.includes('\r\n') && !file.content.replaceAll('\r\n', '').includes('\n') ? '\r\n' : '\n',
  }
  if (state.root) renderDirectory()
  updateControls()
}

async function openFile(path) {
  const file = await request('/files', { query: { root: state.root, path } })
  showFile(file)
  selectView('editor')
}

async function saveFile() {
  const file = state.file
  if (!file || fields.save.disabled) return
  await operate(async () => {
    const value = fields.content.value
    const content = file.lineEnding === '\r\n' ? value.replaceAll('\n', '\r\n') : value
    try {
      const saved = await request('/files', {
        method: 'PUT',
        data: { root: state.root, path: file.path, content, expectedVersion: file.version },
      })
      state.file = { ...file, baseline: value, version: saved.version }
      byId('conflict').hidden = true
      notice('已保存到远程主机。')
    } catch (error) {
      if (error.status !== 409) throw error
      byId('conflict').hidden = false
      notice('远程文件存在版本冲突。', true)
      return
    }
    if (file.version === null) {
      try {
        await openDirectory(state.directory)
      } catch {
        notice('已保存到远程主机。目录列表未能刷新，可手动刷新。', true)
      }
    }
  })
}

function showCreate(kind) {
  if (!state.root || state.busy) return
  state.creating = kind
  byId('create-title').textContent = kind === 'file' ? '新建远程文件' : '新建远程文件夹'
  fields.name.value = ''
  fields.name.setCustomValidity('')
  fields.dialog.showModal()
  fields.name.focus()
}

byId('root-form').addEventListener('submit', event => {
  event.preventDefault()
  if (state.home) void openRoot(fields.root.value)
})
byId('home').addEventListener('click', () => openRoot(state.home))
byId('refresh').addEventListener('click', () => operate(() => openDirectory(state.directory)))
byId('new-file').addEventListener('click', () => showCreate('file'))
byId('new-directory').addEventListener('click', () => showCreate('directory'))
byId('edit-tab').addEventListener('click', () => selectView('editor'))
byId('git-tab').addEventListener('click', () => selectView('git'))
byId('cancel-create').addEventListener('click', () => fields.dialog.close())
fields.name.addEventListener('input', () => fields.name.setCustomValidity(''))
byId('create-form').addEventListener('submit', event => {
  event.preventDefault()
  const name = fields.name.value
  if (!name.trim() || name === '.' || name === '..' || /[/\\\p{Cc}]/u.test(name)) {
    fields.name.setCustomValidity('请输入一个有效名称，不包含路径分隔符。')
    fields.name.reportValidity()
    return
  }
  const path = childPath(state.directory, name)
  if (state.entries.some(entry => entry.name === name)) {
    fields.name.setCustomValidity('当前目录下已有同名条目。')
    fields.name.reportValidity()
    return
  }
  fields.dialog.close()
  if (state.creating === 'file') {
    if (!mayDiscard()) return
    showFile({ path, content: '', version: null })
    selectView('editor')
    fields.content.focus()
  } else {
    void operate(async () => {
      await request('/directories', { method: 'POST', data: { root: state.root, path } })
      try {
        await openDirectory(state.directory)
        notice('已在远程主机创建文件夹。')
      } catch {
        notice('已创建文件夹。目录列表未能刷新，可手动刷新。', true)
      }
    })
  }
})

fields.content.addEventListener('input', updateControls)
fields.save.addEventListener('click', saveFile)
fields.reload.addEventListener('click', () => {
  if (state.file && mayDiscard()) void operate(() => openFile(state.file.path))
})
byId('git-form').addEventListener('submit', event => {
  event.preventDefault()
  if (!state.root) return
  const kind = event.submitter?.value || 'status'
  const path = byId('git-path').value
  const staged = kind === 'diff' && byId('git-staged').checked
  const output = byId('git-output')
  void operate(async () => {
    output.textContent = '正在读取远程 Git…'
    try {
      const { text } = await request('/git', { query: { root: state.root, kind, path, staged: String(staged) } })
      output.textContent = text || (kind === 'diff' ? '此范围没有差异。' : '工作区干净。')
    } catch (error) {
      output.textContent = '未能读取远程 Git。'
      throw error
    }
  })
})
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !byId('editor').hidden && !byId('editor-view').hidden) {
    event.preventDefault()
    void saveFile()
  }
})
window.addEventListener('beforeunload', event => {
  if (isDirty()) {
    event.preventDefault()
    event.returnValue = true
  }
})

updateControls()
void operate(async () => {
  const instance = await request('/instance')
  state.home = instance.home
  fields.root.value = instance.home
  byId('host-state').textContent = '远程实例已连接'
  byId('host-state').dataset.state = 'ready'
  const details = byId('host-details')
  details.textContent = [instance.hostname || instance.hostId, 'dsh ' + instance.version].join(' · ')
  details.title = [instance.hostId, instance.instanceId].filter(Boolean).join(' · ')
  await openDirectory('', state.home)
}).then(() => {
  if (!state.home) {
    byId('host-state').textContent = '远程实例不可用'
    byId('host-state').dataset.state = 'error'
  }
})
