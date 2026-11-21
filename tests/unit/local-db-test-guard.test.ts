import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getConfiguredLocalDataDirPath,
  getLocalDataDirPath,
  getLocalDbPath,
} from '@/lib/local-db'

const ENV_KEYS = ['BLADEVAULT_DATA_DIR', 'HOME', 'USERPROFILE'] as const

describe('test vault guard', () => {
  let saved: Partial<Record<(typeof ENV_KEYS)[number], string>>
  let fakeHome: string

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    // An empty home, so a broken guard still cannot discover a real vault.
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-guard-home-'))
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    delete process.env.BLADEVAULT_DATA_DIR
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('refuses default data-folder discovery without BLADEVAULT_DATA_DIR', () => {
    expect(() => getLocalDataDirPath()).toThrow(/BladeVault test guard/)
    expect(() => getLocalDbPath()).toThrow(/BladeVault test guard/)
    // The persisted preference read must not swallow the guard's error.
    expect(() => getConfiguredLocalDataDirPath()).toThrow(
      /BladeVault test guard/,
    )
    expect(console.error).toHaveBeenCalled()
  })

  it('uses BLADEVAULT_DATA_DIR when it is set', () => {
    process.env.BLADEVAULT_DATA_DIR = path.join(fakeHome, 'vault')
    expect(getLocalDataDirPath()).toBe(path.join(fakeHome, 'vault'))
    expect(console.error).not.toHaveBeenCalled()
  })
})
