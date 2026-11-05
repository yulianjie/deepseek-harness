import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const instancePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

async function readText(path, limit) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const info = await file.stat()
    const { size } = info
    if (!info.isFile() || size < 1 || size > limit) throw new Error('Remote restore data has an invalid size')
    const data = Buffer.alloc(size + 1)
    const { bytesRead } = await file.read(data)
    if (bytesRead !== size) throw new Error('Remote restore data changed during the read')
    return data.toString('utf8', 0, bytesRead)
  } finally {
    await file.close()
  }
}

async function readDocument(path, limit) {
  const text = await readText(path, limit)
  return text === undefined ? undefined : JSON.parse(text)
}

/** Inspect the pinned rc.5 workspace store without starting or writing to a Harness instance. */
export async function readRestoreIdentity(home, instanceName) {
  if (typeof instanceName !== 'string' || !instancePattern.test(instanceName)) throw new Error('Invalid SSH instance name')
  const root = join(home, '.dsh-remote-ssh')
  const instance = join(root, 'instances', instanceName)
  const identity = await readDocument(join(instance, 'identity.json'), 4096)
  if (identity === undefined) return null
  const { hostId, instanceId } = identity ?? {}
  if (typeof hostId !== 'string' || typeof instanceId !== 'string' || !idPattern.test(hostId) || !idPattern.test(instanceId)) {
    throw new Error('Remote Harness identity is invalid')
  }
  if ((await readText(join(root, 'host-id'), 4096))?.trim() !== hostId) throw new Error('Remote Host identity does not match the instance')
  const workspace = await readDocument(join(instance, 'dsh-home', 'storages', 'workspace.json'), 32 * 1024 * 1024)
  if (workspace === undefined) return null
  const order = workspace?.global?.workspaceIds
  const records = workspace?.tables?.workspaces
  if (workspace?.unit?.name !== 'workspace' || workspace.unit.version !== 2 ||
      !Array.isArray(order) || !records || typeof records !== 'object' || Array.isArray(records)) {
    throw new Error('Remote workspace storage is not a recognized rc.5 registry')
  }
  if (!order.every(id => typeof id === 'string' && idPattern.test(id) &&
      Object.hasOwn(records, id) && typeof records[id]?.path === 'string')) {
    throw new Error('Remote workspace storage is incomplete')
  }
  return order.length > 0 ? { hostId, instanceId } : null
}
