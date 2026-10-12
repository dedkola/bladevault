import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

export type LocalRestoreJournal = {
  ownerPid: number
  ownerStartedAt?: number
  state: 'switching' | 'committed'
  stagingDir: string
  safetyBackupDir: string
  oldEntries: string[]
  newEntries: string[]
}

export function getLocalRestoreJournalPath(dataDir: string): string {
  return path.join(
    path.resolve(dataDir),
    '._bladevault-control',
    'restore-journal.json',
  )
}

function isAlive(pid: number, startedAt?: number): boolean {
  if (
    pid === process.pid &&
    startedAt !== undefined &&
    startedAt !== performance.timeOrigin
  )
    return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readJournal(dataDir: string): LocalRestoreJournal | null {
  try {
    const journal = JSON.parse(
      fs.readFileSync(getLocalRestoreJournalPath(dataDir), 'utf8'),
    ) as LocalRestoreJournal
    // Recovery only operates on our private, same-filesystem staging folders.
    const root = path.resolve(dataDir)
    for (const [directory, prefix] of [
      [journal.stagingDir, '._bladevault-restore-stage-'],
      [journal.safetyBackupDir, '._bladevault-before-restore-'],
    ]) {
      if (
        path.dirname(directory) !== root ||
        !path.basename(directory).startsWith(prefix)
      )
        throw new Error(
          'The restore recovery journal contains an invalid directory.',
        )
    }
    if (
      !['switching', 'committed'].includes(journal.state) ||
      !Number.isSafeInteger(journal.ownerPid) ||
      journal.ownerPid < 1 ||
      !Array.isArray(journal.oldEntries) ||
      !Array.isArray(journal.newEntries) ||
      [...journal.oldEntries, ...journal.newEntries].some(
        (name) =>
          typeof name !== 'string' ||
          !name ||
          path.basename(name) !== name ||
          name === '.' ||
          name === '..',
      )
    )
      throw new Error('The restore recovery journal is invalid.')
    return journal
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function rollbackLocalRestore(
  dataDir: string,
  journal: LocalRestoreJournal,
): void {
  // Missing staged entries have already been installed. Entries still in staging
  // must not cause deletion of an original file that has not yet been moved.
  for (const name of journal.newEntries) {
    const staged = path.join(journal.stagingDir, name)
    const installed = path.join(dataDir, name)
    if (!fs.existsSync(staged) && fs.existsSync(installed)) {
      // Move back instead of deleting, making rollback restartable: a later
      // recovery sees the staged entry and never removes the restored original.
      fs.renameSync(installed, staged)
    }
  }
  for (const name of journal.oldEntries) {
    const previous = path.join(journal.safetyBackupDir, name)
    if (fs.existsSync(previous)) {
      fs.rmSync(path.join(dataDir, name), { recursive: true, force: true })
      fs.renameSync(previous, path.join(dataDir, name))
    }
  }
}

export function recoverInterruptedLocalRestore(dataDir: string): boolean {
  const journal = readJournal(dataDir)
  if (!journal || isAlive(journal.ownerPid, journal.ownerStartedAt))
    return false
  const lockPath = `${getLocalRestoreJournalPath(dataDir)}.recovery`
  // All cooperating processes recover before opening SQLite. A failed rollback
  // retains the journal and access gate instead of exposing partial contents.
  const owner = {
    pid: process.pid,
    startedAt: performance.timeOrigin,
    token: randomUUID(),
  }
  const temporaryLock = `${lockPath}.${owner.token}.tmp`
  try {
    fs.writeFileSync(temporaryLock, JSON.stringify(owner), { mode: 0o600 })
    try {
      fs.linkSync(temporaryLock, lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const previous = JSON.parse(
        fs.readFileSync(lockPath, 'utf8'),
      ) as typeof owner
      if (isAlive(previous.pid, previous.startedAt))
        throw new Error('The vault is being recovered. Please wait a moment.')
      // Recheck ownership before reclaiming a dead recovery process's lock.
      if (
        JSON.parse(fs.readFileSync(lockPath, 'utf8')).token !== previous.token
      )
        throw new Error('The vault is being recovered. Please wait a moment.')
      fs.unlinkSync(lockPath)
      fs.linkSync(temporaryLock, lockPath)
    }
  } finally {
    fs.rmSync(temporaryLock, { force: true })
  }
  try {
    // A competing process may have recovered while we acquired the lock. Only
    // replay the journal that still exists under this ownership.
    const current = readJournal(dataDir)
    if (!current || isAlive(current.ownerPid, current.ownerStartedAt))
      return false
    if (current.state === 'switching') rollbackLocalRestore(dataDir, current)
    fs.rmSync(getLocalRestoreJournalPath(dataDir), { force: true })
    fs.rmSync(current.stagingDir, { recursive: true, force: true })
    return true
  } finally {
    if (
      fs.existsSync(lockPath) &&
      JSON.parse(fs.readFileSync(lockPath, 'utf8')).token === owner.token
    )
      fs.unlinkSync(lockPath)
  }
}
