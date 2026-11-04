import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import lock from '../../../scripts/primary-runtime/lock.json' with { type: 'json' }
import { primaryRuntimePayloadDigest } from '../../../scripts/primary-runtime/prepare.ts'
import { reusePrimaryRuntime } from '../scripts/reuse-primary-runtime.ts'

const version = '0.2.1-rc.5'
const pnpmVersion = '11.28.5'
const manifest = {
  desktopVersion: version, platform: 'win32', arch: 'x64',
  payloadDigest: primaryRuntimePayloadDigest('win-x64', lock, pnpmVersion),
  python: lock.pythonVersion, node: lock.nodeVersion, pnpm: pnpmVersion, pythonPackages: lock.pythonPackages,
}

async function fixture() {
  const temp = await realpath(tmpdir())
  const root = await mkdtemp(join(temp, 'dsh-desktop-runtime-reuse-'))
  onTestFinished(async () => {
    if (dirname(await realpath(root)) !== temp) throw new Error('fixture path changed')
    await rm(root, { recursive: true, force: true })
  })
  const appRoot = join(root, 'desktop')
  const source = join(root, 'installed')
  const officeAssets = join(root, 'assets')
  await Promise.all([appRoot, source, officeAssets].map(path => mkdir(path)))
  await writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'fixture.txt'), 'source bytes')
  await writeFile(join(officeAssets, 'skill.md'), 'Office fixture')
  const cache = join(appRoot, '.desktop-build', 'development', 'runtime-reuse')
  return { appRoot, source, officeAssets, version, pnpmVersion, cache }
}

it('verifies the payload at its short published path and reuses the isolated copy on a subsequent launch', async () => {
  const options = await fixture()
  const smoke = vi.fn<(root: string) => void>()
  const output = await reusePrimaryRuntime(options, smoke)
  expect(dirname(dirname(output))).toBe(options.cache)
  expect(smoke.mock.calls[0]).toEqual([output])
  expect(dirname(output).slice(options.cache.length + 1)).toMatch(/^[a-f0-9]{12}$/u)
  expect(await readFile(join(output, 'fixture.txt'), 'utf8')).toBe('source bytes')
  expect(await readFile(join(dirname(output), 'office-skills', 'skill.md'), 'utf8')).toBe('Office fixture')
  expect((await lstat(output)).isSymbolicLink()).toBe(false)
  await writeFile(join(output, 'fixture.txt'), 'isolated copy')
  expect(await readFile(join(options.source, 'fixture.txt'), 'utf8')).toBe('source bytes')
  expect(await reusePrimaryRuntime(options, smoke)).toBe(output)
  expect(smoke.mock.calls[1]).toEqual([output])
})

it.each([
  { desktopVersion: '0.2.1-rc.4' }, { platform: 'darwin' }, { arch: 'arm64' },
  { pnpm: '11.0.0' }, { payloadDigest: '0'.repeat(64) },
])('rejects an incompatible source before staging: %o', async (changes) => {
  const options = await fixture()
  const smoke = vi.fn<(root: string) => void>()
  await writeFile(join(options.source, 'runtime.json'), JSON.stringify({ ...manifest, ...changes }))
  await expect(reusePrimaryRuntime(options, smoke)).rejects.toThrow('does not match the pinned')
  expect(smoke).not.toHaveBeenCalled()
  expect(await readdir(options.appRoot)).toEqual([])
})

it('rejects a build directory link before copying to its target', async () => {
  const options = await fixture()
  const link = join(options.appRoot, '.desktop-build')
  await symlink(options.officeAssets, link, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(reusePrimaryRuntime(options, vi.fn())).rejects.toThrow('expected an unlinked')
  expect(await readdir(options.officeAssets)).toEqual(['skill.md'])
})

it('rejects a relative source before preparing a development directory', async () => {
  const options = await fixture()
  await expect(reusePrimaryRuntime({ ...options, source: 'installed' }, vi.fn())).rejects.toThrow('real absolute directory')
  expect(await readdir(options.appRoot)).toEqual([])
})

it('rejects an invalid cached payload without replacing it', async () => {
  const options = await fixture()
  const smoke = vi.fn<(root: string) => void>()
  const output = await reusePrimaryRuntime(options, smoke)
  const cachedManifest = join(output, 'runtime.json')
  const invalid = JSON.stringify({ ...manifest, pnpm: '11.0.0' })
  await writeFile(cachedManifest, invalid)
  await expect(reusePrimaryRuntime(options, smoke)).rejects.toThrow('does not match the pinned')
  expect(smoke).toHaveBeenCalledTimes(1)
  expect(await readFile(cachedManifest, 'utf8')).toBe(invalid)
})

it('rejects a linked source child and leaves no staged copy', async () => {
  const options = await fixture()
  await symlink(options.officeAssets, join(options.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(reusePrimaryRuntime(options, vi.fn())).rejects.toThrow('expected an unlinked')
  expect(await readdir(options.cache)).toEqual([])
})

it('keeps a failed native smoke outside the reusable cache', async () => {
  const options = await fixture()
  const smoke = vi.fn(() => { throw Object.assign(new Error('fixture smoke failure'), { status: 0xc0000106 }) })
  await expect(reusePrimaryRuntime(options, smoke)).rejects.toThrow('native runtime check exited with 0xC0000106')
  expect(await readdir(options.cache)).toEqual([])
})
