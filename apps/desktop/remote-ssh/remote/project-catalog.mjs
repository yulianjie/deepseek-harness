// Catalog rows are only cross-Host navigation targets. The active Client
// reads all other Workspace and Session state from its own Host as usual.
const workspaceId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const maxProjects = 1024
const maxTitleLength = 256
export const catalogBytes = 1024 * 1024
export const catalogCapability = 'workspace-catalog'
export const catalogPath = '/api/dsh-remote-ssh/workspaces'

function titleText(title) {
  return title.slice(0, maxTitleLength).replace(/\p{Cc}/gu, ' ').toWellFormed()
}

/** Read the same live registry the official Workspace Controller follows. */
export function projectCatalog(registry) {
  if (!registry) return null
  const projects = registry.list()
  return {
    workspaces: projects.slice(0, maxProjects).map(({ id, title }) => ({
      workspaceId: id, title: titleText(title),
    })),
    truncated: projects.length > maxProjects,
  }
}

/** Copy only catalog fields off the SSH wire. Keep ids opaque to the UI. */
export function decodeCatalog(value) {
  if (!Array.isArray(value?.workspaces) || value.workspaces.length > maxProjects ||
    typeof value.truncated !== 'boolean') throw new TypeError('Invalid Workspace catalog')

  const seen = new Set()
  const workspaces = value.workspaces.map(row => {
    if (typeof row?.workspaceId !== 'string' || !workspaceId.test(row.workspaceId) || seen.has(row.workspaceId) ||
      typeof row.title !== 'string' || row.title.length > maxTitleLength) throw new TypeError('Invalid Workspace row')
    seen.add(row.workspaceId)
    return { workspaceId: row.workspaceId, title: titleText(row.title) }
  })
  return { workspaces, truncated: value.truncated }
}
