import { createWriteStream } from 'fs'
import Database from 'better-sqlite3'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import * as tar from 'tar'
import { NextResponse } from 'next/server'
import {
  getConfiguredCloudBackupUrl,
  isBackupUrlAllowed,
} from '@/lib/cloud-backup-server'
import { clearStorageCache } from '@/lib/storage'
import {
  beginLocalRestore,
  closeLocalDb,
  endLocalRestore,
  getLocalDataDirPath,
  getLocalDb,
} from '@/lib/local-db'

function shouldIgnoreBackupEntry(name: string): boolean {
  return name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')
}

function isTarGzipFile(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

function isSafeTarEntry(entryPath: string, expectedTopDir: string): boolean {
  // Reject absolute paths and any path component that escapes the archive root.
  const portablePath = entryPath.replace(/\\/g, '/')
  if (path.posix.isAbsolute(portablePath) || /^[a-z]:\//i.test(portablePath)) {
    return false
  }
  if (portablePath.split('/').includes('..')) return false
  const normalized = path.posix.normalize(portablePath)
  if (normalized === '..' || normalized.startsWith('../')) return false
  // All entries must live inside the expected top-level data directory.
  const topDir = normalized.split('/')[0]
  if (topDir !== expectedTopDir) return false
  return true
}

async function createArchive(sourceDir: string, outputPath: string) {
  await tar.create(
    {
      cwd: path.dirname(sourceDir),
      file: outputPath,
      gzip: true,
      portable: true,
      filter: (entryPath) => !shouldIgnoreBackupEntry(path.basename(entryPath)),
    },
    [path.basename(sourceDir)],
  )
}

async function extractArchive(
  archivePath: string,
  outputDir: string,
  expectedTopDir: string,
) {
  await tar.extract({
    cwd: outputDir,
    file: archivePath,
    filter: (entryPath) =>
      !shouldIgnoreBackupEntry(path.basename(entryPath)) &&
      isSafeTarEntry(entryPath, expectedTopDir),
    gzip: true,
    strict: true,
  })
}

async function validateArchive(archivePath: string): Promise<string> {
  let expectedTopDir = ''
  let unsafeEntry = ''

  await tar.list({
    file: archivePath,
    gzip: true,
    strict: true,
    onReadEntry: (entry) => {
      const entryPath = entry.path || String(entry.header?.path)
      const normalized = path.posix.normalize(entryPath.replace(/\\/g, '/'))
      const topDir = normalized.split('/')[0]
      if (!expectedTopDir) expectedTopDir = topDir
      if (!unsafeEntry && !isSafeTarEntry(entryPath, expectedTopDir)) {
        unsafeEntry = entryPath
      }
    },
  })

  if (unsafeEntry) {
    throw new Error(`Unsafe backup archive entry: ${unsafeEntry}`)
  }

  if (!expectedTopDir) {
    throw new Error('Backup archive does not contain a data directory.')
  }

  return expectedTopDir
}

async function validateSqliteFile(dbPath: string) {
  const db = new Database(dbPath, { readonly: true })

  try {
    const row = db.prepare('PRAGMA integrity_check;').get() as
      Record<string, string> | undefined
    if (!row || Object.values(row)[0] !== 'ok') {
      throw new Error('Restored SQLite database failed integrity_check.')
    }
  } finally {
    db.close()
  }
}

async function ensureDirectory(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function listDirectoryEntries(dirPath: string) {
  return await fs.readdir(dirPath, { withFileTypes: true })
}

async function moveDirectoryContents(sourceDir: string, targetDir: string) {
  await ensureDirectory(targetDir)
  const entries = (await listDirectoryEntries(sourceDir)).filter(
    (entry) => !shouldIgnoreBackupEntry(entry.name),
  )

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)

    try {
      await fs.rename(sourcePath, targetPath)
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EXDEV'
      )) {
        throw error
      }

      await fs.cp(sourcePath, targetPath, {
        recursive: true,
        force: true,
      })
      await fs.rm(sourcePath, {
        recursive: true,
        force: true,
      })
    }
  }
}

async function removeSQLiteSidecars(dirPath: string) {
  try {
    const entries = await listDirectoryEntries(dirPath)
    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name.endsWith('.sqlite-wal') ||
          entry.name.endsWith('.sqlite-shm'))
      ) {
        await fs.rm(path.join(dirPath, entry.name), {
          recursive: true,
          force: true,
        })
      }
    }
  } catch {
    // Best effort: stale sidecars should not block the restore.
  }
}

async function copyDirectoryContents(sourceDir: string, targetDir: string) {
  await ensureDirectory(targetDir)
  const entries = (await listDirectoryEntries(sourceDir)).filter(
    (entry) => !shouldIgnoreBackupEntry(entry.name),
  )

  for (const entry of entries) {
    await fs.cp(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name),
      {
        recursive: true,
        force: true,
      },
    )
  }
}

async function removeDirectoryContents(dirPath: string) {
  const entries = (await listDirectoryEntries(dirPath)).filter(
    (entry) => !shouldIgnoreBackupEntry(entry.name),
  )

  for (const entry of entries) {
    await fs.rm(path.join(dirPath, entry.name), {
      recursive: true,
      force: true,
    })
  }
}

async function restoreArchiveFromPath(archivePath: string) {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-backup-import-'),
  )
  const extractRoot = path.join(tempRoot, 'extract')

  try {
    await fs.mkdir(extractRoot, { recursive: true })
    const archivedTopDir = await validateArchive(archivePath)
    await extractArchive(archivePath, extractRoot, archivedTopDir)

    const extractedDataDir = path.join(extractRoot, archivedTopDir)
    const extractedDbPath = path.join(extractedDataDir, 'bladevault.sqlite')

    await fs.access(extractedDataDir)
    await fs.access(extractedDbPath)
    await validateSqliteFile(extractedDbPath)

    const currentDataDir = getLocalDataDirPath()
    const backupDataDir = `${currentDataDir}.before-restore-${Date.now()}.bak`

    beginLocalRestore()
    closeLocalDb()
    clearStorageCache()

    try {
      try {
        await fs.rm(backupDataDir, { recursive: true, force: true })
        await ensureDirectory(currentDataDir)
        await moveDirectoryContents(currentDataDir, backupDataDir)
      } catch (error) {
        if (!(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )) {
          throw error
        }
      }

      await removeSQLiteSidecars(currentDataDir)
      await fs.mkdir(path.dirname(currentDataDir), { recursive: true })

      try {
        await copyDirectoryContents(extractedDataDir, currentDataDir)
        await validateSqliteFile(path.join(currentDataDir, 'bladevault.sqlite'))
      } catch (error) {
        await removeDirectoryContents(currentDataDir)

        try {
          await moveDirectoryContents(backupDataDir, currentDataDir)
        } catch {
          // Best effort rollback if the restore copy fails.
        }

        throw error
      }
    } finally {
      endLocalRestore()
    }

    const stat = await fs.stat(archivePath)
    return {
      ok: true,
      size: stat.size,
      restoredAt: new Date().toISOString(),
      dataDir: currentDataDir,
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

async function downloadArchiveToPath(
  downloadUrl: string,
  accessToken: string,
  outputPath: string,
) {
  const response = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    let details = ''
    try {
      details = await response.text()
    } catch {
      // ignore
    }
    throw new Error(details || `Backup download failed (${response.status})`)
  }

  if (!response.body) {
    throw new Error('Backup server returned an empty response body.')
  }

  await pipeline(
    Readable.fromWeb(response.body as any),
    createWriteStream(outputPath),
  )
}

export async function GET() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-backup-export-'),
  )
  const archivePath = path.join(tempRoot, 'bladevault-data.tar.gz')

  try {
    const dataDir = getLocalDataDirPath()
    await fs.mkdir(dataDir, { recursive: true })

    // Ensure the latest writes are in the main database file before
    // archiving, without closing the connection and forcing the next
    // request to reopen the database.
    getLocalDb().pragma('wal_checkpoint(RESTART)')

    await createArchive(dataDir, archivePath)
    const buffer = await fs.readFile(archivePath)

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="bladevault-data.tar.gz"',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

export async function PUT(request: Request) {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-backup-upload-import-'),
  )
  const archivePath = path.join(tempRoot, 'bladevault-data.tar.gz')

  try {
    const arrayBuffer = await request.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    if (buffer.length === 0) {
      return NextResponse.json(
        { error: 'Backup archive is empty' },
        { status: 400 },
      )
    }

    if (!isTarGzipFile(buffer)) {
      return NextResponse.json(
        { error: 'Backup file is not a valid tar.gz archive' },
        { status: 400 },
      )
    }

    await fs.writeFile(archivePath, buffer)
    const result = await restoreArchiveFromPath(archivePath)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

export async function POST(request: Request) {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-backup-remote-restore-'),
  )
  const archivePath = path.join(tempRoot, 'bladevault-data.tar.gz')

  try {
    const body = (await request.json()) as {
      backupUrl?: string
      accessToken?: string
    }

    const backupUrl =
      typeof body.backupUrl === 'string' ? body.backupUrl.trim() : ''
    const accessToken =
      typeof body.accessToken === 'string' ? body.accessToken.trim() : ''

    if (!backupUrl) {
      return NextResponse.json(
        { error: 'backupUrl is required' },
        { status: 400 },
      )
    }

    if (!accessToken) {
      return NextResponse.json(
        { error: 'accessToken is required' },
        { status: 400 },
      )
    }

    let downloadUrl: string
    try {
      downloadUrl = new URL('/backup/latest', backupUrl).toString()
    } catch {
      return NextResponse.json({ error: 'Invalid backupUrl' }, { status: 400 })
    }

    if (!isBackupUrlAllowed(downloadUrl)) {
      return NextResponse.json(
        {
          error: `backupUrl must point to the configured backup server (${getConfiguredCloudBackupUrl()})`,
        },
        { status: 400 },
      )
    }

    await downloadArchiveToPath(downloadUrl, accessToken, archivePath)

    const result = await restoreArchiveFromPath(archivePath)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}
