import Database from 'better-sqlite3'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import { getConfiguredCloudBackupUrl } from '@/lib/cloud-backup-server'
import { validateLocalDatabase } from '@/lib/local-data-restore'
import { RestoreSizeLimitStream } from '@/lib/restore-size-limit-stream'

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024 * 1024
const MAX_ENTRIES = 100_000

function ignored(name: string) {
  return (
    name === '__webpage_drafts' ||
    name === '.DS_Store' ||
    name === '__MACOSX' ||
    name.startsWith('._')
  )
}

function safeEntry(entryPath: string, topDir: string) {
  const portablePath = entryPath.replace(/\\/g, '/')
  const segments = portablePath.replace(/\/$/, '').split('/')
  return (
    !path.posix.isAbsolute(portablePath) &&
    !/^[a-z]:\//i.test(portablePath) &&
    segments[0] === topDir &&
    segments.every((segment) => segment && segment !== '.' && segment !== '..')
  )
}

export async function downloadCloudRestoreArchive(
  accessToken: string,
  archivePath: string,
  downloadUrl = new URL(
    '/backup/latest',
    getConfiguredCloudBackupUrl(),
  ).toString(),
) {
  const signal = AbortSignal.timeout(12 * 60 * 60 * 1000)
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'error',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      response.status === 404
        ? 'There is no cloud backup to restore.'
        : `Backup download failed (${response.status}).`,
    )
  }
  if (!response.body)
    throw new Error('Backup server returned an empty response body.')
  const length = Number(response.headers.get('Content-Length') ?? 0)
  if (length > MAX_ARCHIVE_BYTES) {
    await response.body.cancel()
    throw new Error('Backup archive exceeds the supported restore size.')
  }
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    new RestoreSizeLimitStream(MAX_ARCHIVE_BYTES),
    createWriteStream(archivePath, { mode: 0o600 }),
    { signal },
  )
}

export async function prepareCloudRestoreArchive(
  archivePath: string,
  extractRoot: string,
): Promise<string> {
  if ((await fs.stat(archivePath)).size > MAX_ARCHIVE_BYTES)
    throw new Error('Backup archive exceeds the supported restore size.')
  let topDir = ''
  let invalid = ''
  let total = 0
  let entries = 0
  const list = tar.list({
    gzip: true,
    strict: true,
    onReadEntry: (entry) => {
      const portablePath = entry.path.replace(/\\/g, '/')
      if (!topDir) topDir = portablePath.split('/')[0]
      entries += 1
      total += entry.size
      if (!safeEntry(entry.path, topDir))
        invalid ||= 'Backup archive contains an unsafe path.'
      if (!['File', 'OldFile', 'Directory'].includes(entry.type))
        invalid ||= 'Backup archive contains a link or unsupported file.'
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        total > MAX_EXTRACTED_BYTES ||
        entries > MAX_ENTRIES
      )
        invalid ||= 'Backup archive exceeds the supported restore size.'
      entry.resume()
    },
  })
  await pipeline(
    createReadStream(archivePath, { highWaterMark: 64 * 1024 }),
    list,
  )
  if (invalid) throw new Error(invalid)
  if (!topDir)
    throw new Error('Backup archive does not contain a data directory.')
  await fs.mkdir(extractRoot, { recursive: true, mode: 0o700 })
  const extract = tar.extract({
    cwd: extractRoot,
    gzip: true,
    strict: true,
    jobs: 1,
    filter: (entryPath) =>
      safeEntry(entryPath, topDir) && !entryPath.split('/').some(ignored),
  })
  await pipeline(
    createReadStream(archivePath, { highWaterMark: 64 * 1024 }),
    extract,
  )
  const dataDir = path.join(extractRoot, topDir)
  const dbPath = path.join(dataDir, 'bladevault.sqlite')
  validateLocalDatabase(dbPath)
  const database = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = database.prepare('SELECT images FROM knives').all() as Array<{
      images: string
    }>
    for (const row of rows) {
      const images: unknown = JSON.parse(row.images)
      if (!Array.isArray(images))
        throw new Error('Backup database contains invalid image metadata.')
      for (const image of images) {
        if (typeof image !== 'string')
          throw new Error('Backup database contains invalid image metadata.')
        if (image.startsWith('https://') || image.startsWith('http://'))
          continue
        const parts = image.split('/')
        if (
          image.includes('\\') ||
          path.isAbsolute(image) ||
          parts.some(
            (part) => !part || part === '.' || part === '..' || ignored(part),
          )
        )
          throw new Error('Backup contains an invalid local image path.')
        const stat = await fs.lstat(path.join(dataDir, 'images', image))
        if (!stat.isFile())
          throw new Error('Backup references an unavailable collection image.')
      }
    }
  } finally {
    database.close()
  }
  return dataDir
}
