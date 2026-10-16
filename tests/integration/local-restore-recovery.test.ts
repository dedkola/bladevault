import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceLocalDataFromDirectory } from '@/lib/local-data-restore'
import { getLocalDb } from '@/lib/local-db'
import {
  getLocalRestoreJournalPath,
  recoverInterruptedLocalRestore,
  rollbackLocalRestore,
  type LocalRestoreJournal,
} from '@/lib/local-restore-recovery'
import { LocalStorage } from '@/lib/storage/local'
import {
  getVaultAccessState,
  getVaultControlDir,
  getVaultGeneration,
} from '@/lib/vault-access'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault
let directories: string[]

beforeEach(async () => {
  vault = await createTempVault('bladevault-recovery-')
  directories = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  await vault.cleanup()
  for (const directory of directories)
    await fs.rm(directory, { recursive: true, force: true })
})

async function recoveryFixture(
  state: LocalRestoreJournal['state'] = 'switching',
) {
  getVaultGeneration()
  const stagingDir = path.join(
    vault.dataDir,
    '._bladevault-restore-stage-fixture',
  )
  const safetyBackupDir = path.join(
    vault.dataDir,
    '._bladevault-before-restore-fixture',
  )
  await fs.mkdir(stagingDir)
  await fs.mkdir(safetyBackupDir)
  const journal: LocalRestoreJournal = {
    ownerPid: 2147483647,
    state,
    stagingDir,
    safetyBackupDir,
    oldEntries: ['a.txt', 'b.txt'],
    newEntries: ['a.txt', 'b.txt'],
  }
  await fs.writeFile(path.join(vault.dataDir, 'a.txt'), 'new a')
  await fs.writeFile(path.join(vault.dataDir, 'b.txt'), 'new b')
  await fs.writeFile(path.join(safetyBackupDir, 'a.txt'), 'old a')
  await fs.writeFile(path.join(safetyBackupDir, 'b.txt'), 'old b')
  await fs.writeFile(
    getLocalRestoreJournalPath(vault.dataDir),
    JSON.stringify(journal),
  )
  return journal
}

describe('local restore rollback and recovery', () => {
  it('rolls back a failed mid-install rename without changing the collection or generation', async () => {
    const storage = new LocalStorage()
    const knife = await storage.createKnife({
      name: 'Rollback knife',
      brand: 'Backup brand',
      bladeStyle: 'Drop Point',
      handleMaterial: 'G10',
      specs: { weight: '', overallLength: '', bladeLength: '', country: '' },
      description: '',
      sourceUrl: '',
      pinned: false,
      sold: false,
      imageUrls: ['data:image/png;base64,YmFja3VwIGltYWdl'],
    })
    const source = await fs.mkdtemp(
      path.join(os.tmpdir(), 'bladevault-recovery-source-'),
    )
    directories.push(source)
    await getLocalDb().backup(path.join(source, 'bladevault.sqlite'))
    await fs.cp(
      path.join(vault.dataDir, 'images'),
      path.join(source, 'images'),
      { recursive: true },
    )
    await storage.updateKnife(knife.id, {
      brand: 'Current brand',
      images: [...knife.images, 'data:image/png;base64,Y3VycmVudCBpbWFnZQ=='],
    })
    const before = await storage.getAllKnives()
    const imagesBefore = await Promise.all(
      before[0].images.map((image) => storage.getImage(image)),
    )
    const generation = getVaultGeneration()
    const rename = fs.rename.bind(fs)
    const failure = vi
      .spyOn(fs, 'rename')
      .mockImplementation(async (from, to) => {
        if (
          String(to) === path.join(vault.dataDir, 'images') &&
          path
            .basename(path.dirname(String(from)))
            .startsWith('._bladevault-restore-stage-')
        )
          throw new Error('Injected image installation failure.')
        return rename(from, to)
      })
    await expect(replaceLocalDataFromDirectory(source)).rejects.toThrow(
      'Injected image installation failure.',
    )
    failure.mockRestore()
    expect(getVaultAccessState()).toMatchObject({
      generation,
      phase: 'idle',
      readOnly: false,
    })
    expect(await storage.getAllKnives()).toEqual(before)
    const imagesAfter = await Promise.all(
      before[0].images.map((image) => storage.getImage(image)),
    )
    expect(imagesAfter).toEqual(imagesBefore)
    await expect(
      fs.access(getLocalRestoreJournalPath(vault.dataDir)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replays a partially completed rollback without deleting an already restored original', async () => {
    const journal = await recoveryFixture()
    const rename = fsSync.renameSync.bind(fsSync)
    const failure = vi
      .spyOn(fsSync, 'renameSync')
      .mockImplementation((from, to) => {
        if (String(from) === path.join(journal.safetyBackupDir, 'b.txt'))
          throw new Error('Interrupted rollback.')
        return rename(from, to)
      })
    expect(() => rollbackLocalRestore(vault.dataDir, journal)).toThrow(
      'Interrupted rollback.',
    )
    failure.mockRestore()
    expect(await fs.readFile(path.join(vault.dataDir, 'a.txt'), 'utf8')).toBe(
      'old a',
    )
    expect(recoverInterruptedLocalRestore(vault.dataDir)).toBe(true)
    expect(await fs.readFile(path.join(vault.dataDir, 'a.txt'), 'utf8')).toBe(
      'old a',
    )
    expect(await fs.readFile(path.join(vault.dataDir, 'b.txt'), 'utf8')).toBe(
      'old b',
    )
    expect(recoverInterruptedLocalRestore(vault.dataDir)).toBe(false)
  })

  it('cleans a committed journal while keeping the new collection and the safety copy', async () => {
    const journal = await recoveryFixture('committed')
    expect(recoverInterruptedLocalRestore(vault.dataDir)).toBe(true)
    expect(await fs.readFile(path.join(vault.dataDir, 'a.txt'), 'utf8')).toBe(
      'new a',
    )
    expect(await fs.readFile(path.join(vault.dataDir, 'b.txt'), 'utf8')).toBe(
      'new b',
    )
    expect(
      await fs.readFile(path.join(journal.safetyBackupDir, 'a.txt'), 'utf8'),
    ).toBe('old a')
    await expect(fs.access(journal.stagingDir)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      fs.access(getLocalRestoreJournalPath(vault.dataDir)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims an interrupted recovery lock when a restarted process reuses its PID', async () => {
    const journal = await recoveryFixture()
    const lockPath = `${getLocalRestoreJournalPath(vault.dataDir)}.recovery`
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: performance.timeOrigin - 1,
        token: 'previous-recovery-process',
      }),
    )
    await fs.writeFile(
      path.join(getVaultControlDir(), 'restore.json'),
      JSON.stringify({
        pid: 2147483647,
        startedAt: performance.timeOrigin - 1,
        token: 'dead-installer',
        phase: 'switching',
      }),
    )
    expect(getVaultAccessState().phase).toBe('idle')
    expect(await fs.readFile(path.join(vault.dataDir, 'a.txt'), 'utf8')).toBe(
      'old a',
    )
    expect(await fs.readFile(path.join(vault.dataDir, 'b.txt'), 'utf8')).toBe(
      'old b',
    )
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(journal.stagingDir)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
