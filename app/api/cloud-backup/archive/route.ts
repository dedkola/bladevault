import { createWriteStream } from 'fs'
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
import { closeLocalDb, getLocalDataDirPath } from '@/lib/local-db'
import { replaceLocalDataFromDirectory } from '@/lib/local-data-restore'

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
    await fs.access(extractedDataDir)
    const result = await replaceLocalDataFromDirectory(extractedDataDir)

    const stat = await fs.stat(archivePath)
    return {
      ...result,
      size: stat.size,
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

    closeLocalDb()
    clearStorageCache()

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
