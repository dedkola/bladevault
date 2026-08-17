import { createReadStream, createWriteStream } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { crc32 } from 'zlib'
import * as unzipper from 'unzipper'
import { ZipFile } from 'yazl'
import pkg from '@/package.json'
import { clearStorageCache } from '@/lib/storage'
import {
  beginLocalRestore,
  closeLocalDb,
  endLocalRestore,
  getLocalDataDirPath,
  getLocalDb,
  getLocalImagesDirPath,
  LOCAL_DB_SCHEMA_VERSION,
} from '@/lib/local-db'
import {
  replaceLocalDataFromDirectory,
  validateLocalDatabase,
} from '@/lib/local-data-restore'

export const runtime = 'nodejs'

const BACKUP_FORMAT_VERSION = 1
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_JSON_BYTES = 256 * 1024

type LocalBackupManifest = {
  formatVersion: number
  bladeVaultVersion: string
  schemaVersion: number
  createdAt: string
  knifeCount: number
  imageCount: number
}

class BackupValidationError extends Error {}

function shouldIgnoreEntry(name: string): boolean {
  return name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')
}

function isSafeZipPath(entryPath: string): boolean {
  if (!entryPath || entryPath.includes('\0') || entryPath.includes('\\')) {
    return false
  }
  if (path.posix.isAbsolute(entryPath) || /^[a-z]:\//i.test(entryPath)) {
    return false
  }
  if (entryPath.split('/').includes('..')) return false

  const comparablePath = entryPath.endsWith('/')
    ? entryPath.slice(0, -1)
    : entryPath
  return (
    comparablePath.length > 0 &&
    path.posix.normalize(comparablePath) === comparablePath
  )
}

function isAllowedZipPath(entryPath: string): boolean {
  return (
    entryPath === 'manifest.json' ||
    entryPath === 'metadata.json' ||
    entryPath === 'database.sqlite' ||
    entryPath === 'images/' ||
    entryPath.startsWith('images/')
  )
}

function isSymlinkEntry(entry: unzipper.File): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

function parseManifest(value: unknown): LocalBackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackupValidationError('Backup manifest is invalid.')
  }

  const manifest = value as Record<string, unknown>
  const formatVersion = manifest.formatVersion
  const schemaVersion = manifest.schemaVersion
  const knifeCount = manifest.knifeCount
  const imageCount = manifest.imageCount
  const bladeVaultVersion = manifest.bladeVaultVersion
  const createdAt = manifest.createdAt

  if (formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupValidationError(
      `Backup format ${String(formatVersion)} is not supported by this BladeVault version.`,
    )
  }
  if (
    !Number.isInteger(schemaVersion) ||
    Number(schemaVersion) < 0 ||
    Number(schemaVersion) > LOCAL_DB_SCHEMA_VERSION
  ) {
    throw new BackupValidationError(
      `Backup database schema ${String(schemaVersion)} is not compatible with this BladeVault version.`,
    )
  }
  if (!Number.isInteger(knifeCount) || Number(knifeCount) < 0) {
    throw new BackupValidationError(
      'Backup manifest has an invalid knife count.',
    )
  }
  if (!Number.isInteger(imageCount) || Number(imageCount) < 0) {
    throw new BackupValidationError(
      'Backup manifest has an invalid image count.',
    )
  }
  if (typeof bladeVaultVersion !== 'string' || !bladeVaultVersion.trim()) {
    throw new BackupValidationError(
      'Backup manifest is missing the BladeVault version.',
    )
  }
  if (
    typeof createdAt !== 'string' ||
    !createdAt.trim() ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    throw new BackupValidationError(
      'Backup manifest has an invalid creation date.',
    )
  }

  return {
    formatVersion,
    bladeVaultVersion,
    schemaVersion: Number(schemaVersion),
    createdAt,
    knifeCount: Number(knifeCount),
    imageCount: Number(imageCount),
  }
}

async function readSmallJsonEntry(entry: unzipper.File): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  let checksum = 0
  const stream = entry.stream()

  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BYTES) {
      stream.destroy()
      throw new BackupValidationError(`${entry.path} is too large.`)
    }
    chunks.push(buffer)
    checksum = crc32(buffer, checksum)
  }

  if (checksum !== entry.crc32) {
    throw new BackupValidationError(`${entry.path} failed its CRC check.`)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new BackupValidationError(`${entry.path} is not valid JSON.`)
  }
}

function validateZipEntries(entries: unzipper.File[]) {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new BackupValidationError('Backup archive contains too many files.')
  }

  const seen = new Set<string>()
  let totalSize = 0

  for (const entry of entries) {
    if (!isSafeZipPath(entry.path) || !isAllowedZipPath(entry.path)) {
      throw new BackupValidationError(
        `Unsafe or unexpected backup archive entry: ${entry.path}`,
      )
    }
    if (seen.has(entry.path)) {
      throw new BackupValidationError(
        `Backup archive contains a duplicate entry: ${entry.path}`,
      )
    }
    seen.add(entry.path)

    if (isSymlinkEntry(entry)) {
      throw new BackupValidationError(
        `Backup archive contains a symbolic link: ${entry.path}`,
      )
    }
    if ((entry.flags & 0x1) !== 0) {
      throw new BackupValidationError(
        'Encrypted backup archives are not supported.',
      )
    }
    if (entry.type !== 'File' && entry.type !== 'Directory') {
      throw new BackupValidationError(
        `Backup archive entry has an unsupported type: ${entry.path}`,
      )
    }
    if (entry.type === 'Directory' && !entry.path.endsWith('/')) {
      throw new BackupValidationError(
        `Backup archive directory is malformed: ${entry.path}`,
      )
    }
    if (
      entry.type === 'File' &&
      entry.compressionMethod !== 0 &&
      entry.compressionMethod !== 8
    ) {
      throw new BackupValidationError(
        `Backup archive entry uses unsupported compression: ${entry.path}`,
      )
    }
    if (
      !Number.isSafeInteger(entry.compressedSize) ||
      entry.compressedSize < 0 ||
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0
    ) {
      throw new BackupValidationError(
        `Backup archive entry has an invalid size: ${entry.path}`,
      )
    }

    totalSize += entry.uncompressedSize
    if (totalSize > MAX_EXTRACTED_BYTES) {
      throw new BackupValidationError('Backup archive is too large to restore.')
    }
    if (
      entry.uncompressedSize > 100 * 1024 * 1024 &&
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > 1000
    ) {
      throw new BackupValidationError(
        `Backup archive entry has an unsafe compression ratio: ${entry.path}`,
      )
    }
  }

  for (const requiredPath of [
    'manifest.json',
    'metadata.json',
    'database.sqlite',
    'images/',
  ]) {
    if (!seen.has(requiredPath)) {
      throw new BackupValidationError(
        `Backup archive is missing ${requiredPath}.`,
      )
    }
  }

  for (const requiredFile of [
    'manifest.json',
    'metadata.json',
    'database.sqlite',
  ]) {
    if (entries.find((entry) => entry.path === requiredFile)?.type !== 'File') {
      throw new BackupValidationError(
        `Backup archive entry ${requiredFile} must be a file.`,
      )
    }
  }
  if (entries.find((entry) => entry.path === 'images/')?.type !== 'Directory') {
    throw new BackupValidationError(
      'Backup archive entry images/ must be a directory.',
    )
  }
}

function toBackupValidationError(error: unknown): BackupValidationError {
  if (error instanceof BackupValidationError) return error
  return new BackupValidationError(
    error instanceof Error ? error.message : 'Backup archive is invalid.',
  )
}

async function extractEntry(entry: unzipper.File, targetPath: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  let written = 0
  let checksum = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length
      if (written > entry.uncompressedSize || written > MAX_EXTRACTED_BYTES) {
        callback(
          new BackupValidationError(`${entry.path} exceeds its declared size.`),
        )
        return
      }
      checksum = crc32(chunk, checksum)
      callback(null, chunk)
    },
  })

  await pipeline(
    entry.stream(),
    limiter,
    createWriteStream(targetPath, { mode: 0o600 }),
  )

  if (written !== entry.uncompressedSize) {
    throw new BackupValidationError(`${entry.path} has an invalid size.`)
  }
  if (checksum !== entry.crc32) {
    throw new BackupValidationError(`${entry.path} failed its CRC check.`)
  }
}

async function prepareBackupForRestore(
  archivePath: string,
  outputDir: string,
  includeImages: boolean,
): Promise<LocalBackupManifest> {
  let directory: unzipper.CentralDirectory
  try {
    directory = await unzipper.Open.file(archivePath)
  } catch (error) {
    throw new BackupValidationError(
      error instanceof Error
        ? `Backup ZIP could not be opened: ${error.message}`
        : 'Backup ZIP could not be opened.',
    )
  }

  validateZipEntries(directory.files)
  const byPath = new Map(directory.files.map((entry) => [entry.path, entry]))
  const manifest = parseManifest(
    await readSmallJsonEntry(byPath.get('manifest.json')!),
  )
  const metadata = await readSmallJsonEntry(byPath.get('metadata.json')!)
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new BackupValidationError('Backup metadata is invalid.')
  }

  await fs.mkdir(outputDir, { recursive: true })
  await extractEntry(
    byPath.get('database.sqlite')!,
    path.join(outputDir, 'bladevault.sqlite'),
  )

  const database = validateLocalDatabase(
    path.join(outputDir, 'bladevault.sqlite'),
  )
  if (database.schemaVersion !== manifest.schemaVersion) {
    throw new BackupValidationError(
      'Backup manifest does not match the database schema version.',
    )
  }
  if (database.knifeCount !== manifest.knifeCount) {
    throw new BackupValidationError(
      'Backup manifest does not match the database knife count.',
    )
  }

  const imageEntries = directory.files.filter(
    (entry) => entry.type === 'File' && entry.path.startsWith('images/'),
  )
  if (imageEntries.length !== manifest.imageCount) {
    throw new BackupValidationError(
      'Backup manifest does not match the number of image files.',
    )
  }

  if (includeImages) {
    await fs.mkdir(path.join(outputDir, 'images'), { recursive: true })
    for (const entry of imageEntries) {
      const relativePath = entry.path.slice('images/'.length)
      await extractEntry(entry, path.join(outputDir, 'images', relativePath))
    }
  }

  return manifest
}

async function collectImageFiles(
  directory: string,
  relativeDir = '',
): Promise<Array<{ absolutePath: string; archivePath: string }>> {
  let entries
  try {
    entries = await fs.readdir(path.join(directory, relativeDir), {
      withFileTypes: true,
    })
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return []
    }
    throw error
  }

  const files: Array<{ absolutePath: string; archivePath: string }> = []
  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name)) continue
    const nextRelativePath = path.join(relativeDir, entry.name)
    const absolutePath = path.join(directory, nextRelativePath)

    if (entry.isSymbolicLink()) {
      throw new Error(
        `Local image path is a symbolic link: ${nextRelativePath}`,
      )
    }
    if (entry.isDirectory()) {
      files.push(...(await collectImageFiles(directory, nextRelativePath)))
    } else if (entry.isFile()) {
      files.push({
        absolutePath,
        archivePath: `images/${nextRelativePath.split(path.sep).join('/')}`,
      })
    }
  }

  return files
}

async function writeBackupZip(outputPath: string) {
  getLocalDb()
  beginLocalRestore()
  closeLocalDb()
  clearStorageCache()

  try {
    const dataDir = getLocalDataDirPath()
    const dbPath = path.join(dataDir, 'bladevault.sqlite')
    const images = await collectImageFiles(getLocalImagesDirPath())
    const database = validateLocalDatabase(dbPath)
    const createdAt = new Date().toISOString()
    const manifest: LocalBackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      bladeVaultVersion: pkg.version,
      schemaVersion: database.schemaVersion,
      createdAt,
      knifeCount: database.knifeCount,
      imageCount: images.length,
    }
    const metadata = {
      application: 'BladeVault',
      archiveType: 'full-local-backup',
      databaseFile: 'database.sqlite',
      imagesDirectory: 'images/',
      contents:
        'Collection records and settings are stored in database.sqlite; local image files are stored in images/.',
    }

    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(outputPath, { mode: 0o600 })
      const archive = new ZipFile()
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
      }

      output.on('close', () => {
        if (settled) return
        settled = true
        resolve()
      })
      output.on('error', fail)
      archive.outputStream.on('error', fail)
      archive.outputStream.pipe(output)
      archive.addBuffer(
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
        'manifest.json',
      )
      archive.addBuffer(
        Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
        'metadata.json',
      )
      archive.addFile(dbPath, 'database.sqlite')
      archive.addEmptyDirectory('images')
      for (const image of images) {
        archive.addFile(image.absolutePath, image.archivePath)
      }
      archive.end()
    })

    return manifest
  } finally {
    endLocalRestore()
  }
}

async function writeRequestArchive(request: Request, outputPath: string) {
  if (!request.body) {
    throw new BackupValidationError('Backup archive is empty.')
  }

  const declaredSize = Number(request.headers.get('content-length') || 0)
  if (declaredSize > MAX_ARCHIVE_BYTES) {
    throw new BackupValidationError('Backup archive is too large.')
  }

  let received = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > MAX_ARCHIVE_BYTES) {
        callback(new BackupValidationError('Backup archive is too large.'))
        return
      }
      callback(null, chunk)
    },
  })

  await pipeline(
    Readable.fromWeb(request.body as any),
    limiter,
    createWriteStream(outputPath, { mode: 0o600 }),
  )

  if (received === 0) {
    throw new BackupValidationError('Backup archive is empty.')
  }

  const handle = await fs.open(outputPath, 'r')
  try {
    const magic = Buffer.alloc(4)
    await handle.read(magic, 0, magic.length, 0)
    if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new BackupValidationError(
        'Selected file is not a BladeVault ZIP backup.',
      )
    }
  } finally {
    await handle.close()
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown error'
  return Response.json(
    { error: message },
    { status: error instanceof BackupValidationError ? 400 : 500 },
  )
}

export async function GET() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-local-backup-export-'),
  )
  const archivePath = path.join(tempRoot, 'bladevault-backup.zip')

  try {
    const manifest = await writeBackupZip(archivePath)
    const stat = await fs.stat(archivePath)
    const stream = createReadStream(archivePath)
    const cleanup = () => {
      void fs.rm(tempRoot, { recursive: true, force: true })
    }
    stream.once('close', cleanup)

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="bladevault-backup-${manifest.createdAt.slice(0, 10)}.zip"`,
        'Content-Length': String(stat.size),
        'Content-Type': 'application/zip',
      },
    })
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true })
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-local-backup-inspect-'),
  )
  const archivePath = path.join(tempRoot, 'backup.zip')
  const inspectDir = path.join(tempRoot, 'inspect')

  try {
    await writeRequestArchive(request, archivePath)
    let manifest: LocalBackupManifest
    try {
      manifest = await prepareBackupForRestore(archivePath, inspectDir, false)
    } catch (error) {
      throw toBackupValidationError(error)
    }
    return Response.json({ manifest })
  } catch (error) {
    return errorResponse(error)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

export async function PUT(request: Request) {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'bladevault-local-backup-restore-'),
  )
  const archivePath = path.join(tempRoot, 'backup.zip')
  const restoredDataDir = path.join(tempRoot, 'data')

  try {
    await writeRequestArchive(request, archivePath)
    let manifest: LocalBackupManifest
    try {
      manifest = await prepareBackupForRestore(
        archivePath,
        restoredDataDir,
        true,
      )
    } catch (error) {
      throw toBackupValidationError(error)
    }
    const result = await replaceLocalDataFromDirectory(restoredDataDir)
    return Response.json({ ...result, manifest })
  } catch (error) {
    return errorResponse(error)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}
