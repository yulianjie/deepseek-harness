/** Materialize a verified copy of a pinned Windows primary runtime for development. */
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readPrimaryRuntime } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import lock from '../../../scripts/primary-runtime/lock.json' with { type: 'json' }
import { primaryRuntimePayloadDigest } from '../../../scripts/primary-runtime/prepare.ts'
import { smokePrimaryRuntime } from './prepare-primary-runtime.ts'

interface ReuseOptions {
  readonly appRoot: string
  readonly source: string
  readonly officeAssets: string
  readonly version: string
  readonly pnpmVersion: string
}

function normalizePath(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function statIfPresent(path: string) {
  try { return await lstat(path) } catch (error: unknown) {
    if (!hasCode(error, 'ENOENT')) throw error
    return undefined
  }
}

async function ordinaryEntry(path: string) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())
    || normalizePath(await realpath(path)) !== normalizePath(path)) {
    throw new Error(`desktop runtime reuse: expected an unlinked file or directory at ${path}`)
  }
  return info
}

async function directory(path: string): Promise<void> {
  const driveRelative = process.platform === 'win32' && /^[/\\](?![/\\])/u.test(path)
  if (!isAbsolute(path) || driveRelative || !(await ordinaryEntry(path)).isDirectory()) {
    throw new Error(`desktop runtime reuse: expected a real absolute directory at ${path}`)
  }
}

async function createDirectory(path: string): Promise<void> {
  try {
    await mkdir(path)
  } catch (error: unknown) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  await directory(path)
}

async function verifyManifest(root: string, options: ReuseOptions, digest: string): Promise<void> {
  await directory(root)
  if (!(await ordinaryEntry(join(root, 'runtime.json'))).isFile()) {
    throw new Error('desktop runtime reuse: expected a regular runtime.json')
  }
  const manifest = await readPrimaryRuntime(root)
  const distributions = Object.entries(lock.pythonPackages)
  if (manifest.desktopVersion !== options.version || manifest.platform !== 'win32' || manifest.arch !== 'x64'
    || manifest.payloadDigest !== digest || manifest.python !== lock.pythonVersion || manifest.node !== lock.nodeVersion
    || manifest.pnpm !== options.pnpmVersion || Object.keys(manifest.pythonPackages).length !== distributions.length
    || distributions.some(([name, version]) => manifest.pythonPackages[name] !== version)) {
    throw new Error('desktop runtime reuse: runtime.json does not match the pinned Desktop runtime')
  }
}

async function verifyTree(root: string): Promise<void> {
  if (!(await ordinaryEntry(root)).isDirectory()) return
  for (const name of await readdir(root)) await verifyTree(join(root, name))
}

async function verifyStagingPath(cache: string, staging: string): Promise<void> {
  if (!/^\.copy-[^\\/]+$/u.test(relative(cache, staging))) throw new Error('desktop runtime reuse: staging escaped the development cache')
  await directory(cache)
  await directory(staging)
}

function verifyNative(root: string, smoke: (root: string) => void): void {
  try { smoke(root) } catch (error: unknown) {
    if (!(error instanceof Error) || !('status' in error) || typeof error.status !== 'number') throw error
    const status = (error.status >>> 0).toString(16).toUpperCase().padStart(8, '0')
    throw new Error(`desktop runtime reuse: native runtime check exited with 0x${status}: ${error.message}`, { cause: error })
  }
}

/**
 * Validate and copy an explicit Windows x64 runtime into the checkout's development cache.
 * @param options - checked-out Desktop directory, pinned release identity, and explicit source paths.
 * @param smoke - native payload checks, using the standard Desktop smoke by default.
 * @returns the unlinked cached payload path after native verification.
 */
export async function reusePrimaryRuntime(
  options: ReuseOptions, smoke: (root: string) => void = smokePrimaryRuntime,
): Promise<string> {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(options.version)) {
    throw new Error('desktop runtime reuse: expected a pinned Desktop version')
  }
  const digest = primaryRuntimePayloadDigest('win-x64', lock, options.pnpmVersion)
  await verifyManifest(options.source, options, digest)
  await directory(options.officeAssets)
  await directory(options.appRoot)
  let cache = options.appRoot
  for (const segment of ['.desktop-build', 'development', 'runtime-reuse']) {
    cache = join(cache, segment)
    await createDirectory(cache)
  }
  // The published directory has the same path budget as the staging directory.
  // Full release and payload identities are verified in runtime.json.
  const key = createHash('sha256').update(options.version).update('\0').update(digest).digest('hex').slice(0, 12)
  const target = join(cache, key)
  const payload = join(target, 'primary-runtime')
  const existing = await statIfPresent(target)
  if (existing !== undefined) {
    await directory(target)
    await verifyManifest(payload, options, digest)
    await directory(join(target, 'office-skills'))
    await verifyTree(target)
    verifyNative(payload, smoke)
    return payload
  }

  const staging = await mkdtemp(join(cache, '.copy-'))
  let published = false
  try {
    const copyOptions = {
      recursive: true, force: false, errorOnExist: true,
      filter: async (path: string) => { await ordinaryEntry(path); return true },
    }
    const stagedPayload = join(staging, 'primary-runtime')
    await cp(options.source, stagedPayload, copyOptions)
    await cp(options.officeAssets, join(staging, 'office-skills'), copyOptions)
    await verifyManifest(stagedPayload, options, digest)
    await verifyStagingPath(cache, staging)
    if (await statIfPresent(target) !== undefined) throw new Error('desktop runtime reuse: target appeared during staging')
    await rename(staging, target)
    try {
      verifyNative(payload, smoke)
    } catch (error: unknown) {
      await directory(cache)
      await directory(target)
      await rename(target, staging)
      throw error
    }
    published = true
    return payload
  } finally {
    if (!published && await statIfPresent(staging) !== undefined) {
      await verifyStagingPath(cache, staging)
      await rm(staging, { recursive: true, force: true })
    }
  }
}
