import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const loadCommonJs = createRequire(import.meta.url)
const whatsNew = loadCommonJs('../../electron/whats-new.cjs')
const { CONSENT_FILE } = loadCommonJs('../../electron/error-reporting.cjs')
const { buildReleaseHighlights } = loadCommonJs(
  '../../scripts/release-highlights.cjs',
)

const PACKAGE = {
  bladevaultWhatsNew: {
    items: ['Add a new view', 'Fix sorting'],
    moreCount: 0,
  },
}

const tempDirs: string[] = []
function makeUserDataDir({ earlierInstall = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-whats-new-'))
  tempDirs.push(dir)
  if (earlierInstall) {
    fs.writeFileSync(path.join(dir, CONSENT_FILE), '{"enabled":true}')
  }
  return dir
}

function pending(userDataDir: string, overrides = {}) {
  return whatsNew.getPendingWhatsNew({
    userDataDir,
    packageJson: PACKAGE,
    version: '2.3.0',
    isPackaged: true,
    disabled: false,
    ...overrides,
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('release highlights', () => {
  it('lists features first, then fixes, without prefixes or PR numbers', () => {
    expect(
      buildReleaseHighlights([
        'fix(scrape): keep gallery order (#10)',
        '2.2.1',
        'chore(deps): bump next from 16.0.0 to 16.0.1',
        'feat(desktop): show what is new after updates (#12)',
        'docs: explain backups',
        'perf: load the collection faster',
        'Merge branch main',
        'update readme',
      ]),
    ).toEqual({
      items: [
        'Show what is new after updates',
        'Keep gallery order',
        'Load the collection faster',
      ],
      moreCount: 0,
    })
  })

  it('keeps the list short and counts the rest', () => {
    const subjects = Array.from({ length: 8 }, (_, i) => `fix: issue ${i}`)
    expect(buildReleaseHighlights(subjects)).toEqual({
      items: ['Issue 0', 'Issue 1', 'Issue 2', 'Issue 3', 'Issue 4'],
      moreCount: 3,
    })
  })

  it('drops duplicate titles', () => {
    expect(
      buildReleaseHighlights(['fix: same thing', 'fix(ui): Same thing']).items,
    ).toEqual(['Same thing'])
  })
})

describe('desktop what is new', () => {
  it('records a fresh install without showing anything', () => {
    const dir = makeUserDataDir()
    expect(pending(dir)).toBeNull()
    expect(whatsNew.readLastSeenVersion(dir)).toBe('2.3.0')
  })

  it('shows the list once after an update from an earlier install', () => {
    const dir = makeUserDataDir({ earlierInstall: true })
    expect(pending(dir)).toEqual({
      version: '2.3.0',
      items: ['Add a new view', 'Fix sorting'],
      moreCount: 0,
      url: 'https://github.com/dedkola/bladevault/releases/tag/v2.3.0',
    })
    whatsNew.writeLastSeenVersion(dir, '2.3.0')
    expect(pending(dir)).toBeNull()
  })

  it('shows the list after an update from a recorded version', () => {
    const dir = makeUserDataDir()
    whatsNew.writeLastSeenVersion(dir, '2.2.1')
    expect(pending(dir)?.version).toBe('2.3.0')
  })

  it('skips builds without a list and does not ask again', () => {
    const dir = makeUserDataDir({ earlierInstall: true })
    expect(pending(dir, { packageJson: {} })).toBeNull()
    expect(whatsNew.readLastSeenVersion(dir)).toBe('2.3.0')
  })

  it('stays off in development builds and test modes', () => {
    const dir = makeUserDataDir({ earlierInstall: true })
    expect(pending(dir, { isPackaged: false })).toBeNull()
    expect(pending(dir, { disabled: true })).toBeNull()
    expect(whatsNew.readLastSeenVersion(dir)).toBeNull()
  })

  it('builds a short dialog with a link to all changes', () => {
    const options = whatsNew.getDialogOptions({
      version: '2.3.0',
      items: ['Add a new view'],
      moreCount: 2,
      url: 'https://github.com/dedkola/bladevault/releases/tag/v2.3.0',
    })
    expect(options.message).toBe('What’s new in BladeVault 2.3.0')
    expect(options.detail).toBe('• Add a new view\n• …and 2 more changes')
    expect(options.buttons).toEqual(['OK', 'See All Changes'])
  })
})
