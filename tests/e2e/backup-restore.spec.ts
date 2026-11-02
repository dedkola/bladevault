import { expect, test } from '@playwright/test'
import { ZipFile } from 'yazl'

// Next.js clones and caps proxied request bodies at 10 MB, and silently
// truncates anything larger. Backup restores upload far more than that.
const PROXY_BODY_LIMIT = 10 * 1024 * 1024

function createOversizedArchive(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const zip = new ZipFile()
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.on('error', reject)
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    // The manifest is intentionally unsupported: reaching the manifest check
    // proves the whole archive arrived, including its tail past the 10 MB mark.
    zip.addBuffer(
      Buffer.from(
        JSON.stringify({
          formatVersion: 999,
          bladeVaultVersion: '0.0.0',
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          knifeCount: 0,
          imageCount: 1,
        }),
      ),
      'manifest.json',
    )
    zip.addBuffer(Buffer.from('{}'), 'metadata.json')
    zip.addBuffer(Buffer.from('unused'), 'database.sqlite')
    zip.addEmptyDirectory('images')
    zip.addBuffer(
      Buffer.alloc(PROXY_BODY_LIMIT + 2 * 1024 * 1024, 7),
      'images/large.bin',
      { compress: false },
    )
    zip.end()
  })
}

test('accepts backup uploads larger than the proxy body limit', async ({
  request,
}) => {
  const archive = await createOversizedArchive()
  expect(archive.byteLength).toBeGreaterThan(PROXY_BODY_LIMIT)

  const response = await request.post('/api/local-backup/archive', {
    headers: { 'Content-Type': 'application/zip' },
    data: archive,
    timeout: 120_000,
  })

  expect(response.status()).toBe(400)
  await expect(response.json()).resolves.toEqual({
    error: 'Backup format 999 is not supported by this BladeVault version.',
  })
})
