import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const loadCommonJs = createRequire(import.meta.url)
const backgroundMode = loadCommonJs('../../electron/background-mode.cjs')

const tempDirs: string[] = []
function makeUserDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-background-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('desktop background mode', () => {
  it('is off when nothing was saved', () => {
    expect(backgroundMode.readBackgroundMode(makeUserDataDir())).toBe(false)
  })

  it('saves and reads the choice', () => {
    const dir = makeUserDataDir()
    expect(backgroundMode.writeBackgroundMode(dir, true)).toBe(true)
    expect(backgroundMode.readBackgroundMode(dir)).toBe(true)
    expect(backgroundMode.writeBackgroundMode(dir, false)).toBe(false)
    expect(backgroundMode.readBackgroundMode(dir)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([backgroundMode.BACKGROUND_MODE_FILE])
  })

  it('creates the user-data folder when needed', () => {
    const dir = path.join(makeUserDataDir(), 'nested')
    backgroundMode.writeBackgroundMode(dir, true)
    expect(backgroundMode.readBackgroundMode(dir)).toBe(true)
  })

  it('treats anything but enabled: true as off', () => {
    const dir = makeUserDataDir()
    const file = path.join(dir, backgroundMode.BACKGROUND_MODE_FILE)
    for (const content of ['not json', 'null', '{"enabled":"yes"}', '[]']) {
      fs.writeFileSync(file, content)
      expect(backgroundMode.readBackgroundMode(dir)).toBe(false)
    }
  })
})
