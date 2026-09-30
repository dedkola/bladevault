import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDockerImageCache } from '@/lib/docker-image-cache'

let root: string
let cacheDir: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bladevault-image-cache-'))
  cacheDir = path.join(root, '.next', 'cache', 'images')
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.stubEnv('BLADEVAULT_DOCKER_RUNTIME', '1')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})

describe('clearDockerImageCache', () => {
  it('removes optimized variants while preserving the mount and other files', async () => {
    const variant = path.join(cacheDir, 'AbC_123-variant')
    await fs.mkdir(variant, { recursive: true })
    await fs.writeFile(path.join(variant, 'image.webp'), 'old image')
    const dataDir = path.join(root, 'data')
    await fs.mkdir(dataDir)
    await fs.writeFile(path.join(dataDir, 'original.png'), 'source')
    await fs.symlink(dataDir, path.join(cacheDir, 'linked-source'))
    await fs.writeFile(path.join(cacheDir, '.keep'), '')

    await clearDockerImageCache()

    expect((await fs.readdir(cacheDir)).sort()).toEqual([
      '.keep',
      'linked-source',
    ])
    expect(await fs.readFile(path.join(dataDir, 'original.png'), 'utf8')).toBe(
      'source',
    )
  })

  it('does not clear image caches outside Docker', async () => {
    vi.stubEnv('BLADEVAULT_DOCKER_RUNTIME', '')
    const variant = path.join(cacheDir, 'AbC_123-variant')
    await fs.mkdir(variant, { recursive: true })

    await clearDockerImageCache()

    expect(await fs.readdir(cacheDir)).toEqual(['AbC_123-variant'])
  })

  it('accepts an empty cache before the first optimized image request', async () => {
    await expect(clearDockerImageCache()).resolves.toBeUndefined()
  })
})
