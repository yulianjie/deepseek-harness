/** Host startup failure releases its partial Cordis tree. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import { expect, it, vi } from 'vitest'
import { createHostRuntime, type HostKey } from '../src/host-runtime.ts'

it('disposes installed Host effects when composition fails', async () => {
  const release = vi.fn()
  const startupError = new Error('failed to assemble Host pane')
  await expect(createHostRuntime({
    hostKey: brandString<HostKey>('test:startup'),
    connection: { interactions: 'none' },
    installConnection,
    compose(ctx) {
      ctx.effect(() => release, 'test: Host effect')
      throw startupError
    },
  })).rejects.toBe(startupError)
  expect(release).toHaveBeenCalledOnce()
})
