import fs from 'fs/promises'
import path from 'path'
import { Knife, KnifeUpdates } from '@/lib/data'
import { normalizeKnifeTextFields } from '@/lib/knife-text'
import { getLocalDb, getLocalImagesDirPath } from '@/lib/local-db'
import { fetchExternalUrl, validateExternalUrl } from '@/lib/url-validation'
import { CreateKnifeInput, ImageData, Storage } from './types'

function extensionFromMimeType(contentType: string): string {
  const type = contentType.split(';')[0].trim().toLowerCase()
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
  }
  return map[type] ?? 'jpg'
}

function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = path.extname(pathname).toLowerCase().replace('.', '')
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext
    }
  } catch {
    // ignore
  }
  return ''
}

function extensionFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/([a-z0-9+]+);base64,/i)
  if (!match) return 'jpg'
  const subtype = match[1].toLowerCase()
  if (subtype === 'jpeg' || subtype === 'jpg') return 'jpg'
  if (['png', 'webp', 'gif', 'avif', 'svg'].includes(subtype)) return subtype
  return 'jpg'
}

export function rowToKnife(row: Record<string, unknown>): Knife {
  const addedAt = String(row.added_at)

  return {
    id: String(row.id),
    name: String(row.name),
    brand: String(row.brand),
    bladeStyle: String(row.blade_style),
    handleMaterial: String(row.handle_material),
    images: (JSON.parse(String(row.images)) as string[] | null) ?? [],
    specs:
      (JSON.parse(String(row.specs)) as Knife['specs'] | null) ??
      ({} as Knife['specs']),
    customFields:
      (JSON.parse(String(row.custom_fields)) as Knife['customFields'] | null) ??
      {},
    description: String(row.description),
    addedAt,
    updatedAt:
      typeof row.updated_at === 'string' && row.updated_at.trim()
        ? row.updated_at
        : addedAt,
    sourceUrl: String(row.source_url ?? ''),
    pinned: Boolean(row.pinned),
  }
}

export function generateId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || `knife-${Date.now()}`
  )
}

export function getNextImageIndex(images: string[]): number {
  let maxIndex = -1
  for (const image of images) {
    try {
      const pathname =
        image.startsWith('http://') || image.startsWith('https://')
          ? new URL(image).pathname
          : image
      const filename = path.basename(pathname)
      const match = filename.match(/^image-(\d+)\./)
      if (match) {
        maxIndex = Math.max(maxIndex, parseInt(match[1], 10) - 1)
      }
    } catch {
      // ignore invalid paths/urls
    }
  }
  return maxIndex + 1
}

function getDb() {
  return getLocalDb()
}

function getImagesDir() {
  return getLocalImagesDirPath()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map((item, idx) => fn(item, i + idx)),
    )
    results.push(...batchResults)
  }
  return results
}

export class LocalStorage implements Storage {
  async getAllKnives(): Promise<Knife[]> {
    const rows = getDb()
      .prepare('SELECT * FROM knives ORDER BY added_at DESC')
      .all()
    return rows.map((row) => rowToKnife(row as Record<string, unknown>))
  }

  async getKnifeById(id: string): Promise<Knife | undefined> {
    const row = getDb().prepare('SELECT * FROM knives WHERE id = ?').get(id)
    return row ? rowToKnife(row as Record<string, unknown>) : undefined
  }

  async ensureUniqueId(id: string): Promise<string> {
    const rows = getDb()
      .prepare('SELECT id FROM knives WHERE id = ? OR id LIKE ?')
      .all(id, `${id}-%`) as Array<{ id: string }>

    if (rows.length === 0) return id
    if (!rows.some((row) => row.id === id)) return id
    const suffixPattern = new RegExp(`^${escapeRegExp(id)}-(\\d+)$`)
    const usedSuffixes = new Set<number>()
    for (const row of rows) {
      const match = row.id.match(suffixPattern)
      if (match) {
        usedSuffixes.add(Number.parseInt(match[1], 10))
      }
    }

    let counter = 2
    while (usedSuffixes.has(counter)) {
      counter += 1
    }
    return `${id}-${counter}`
  }

  async downloadImage(
    url: string,
    knifeId: string,
    index: number,
  ): Promise<string> {
    const validation = await validateExternalUrl(url)
    if (!validation.ok) {
      throw new Error(validation.reason)
    }

    const response = await fetchExternalUrl(validation.url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: validation.url.href,
      },
    })

    if (!response.ok) {
      throw new Error(
        `Failed to download image: ${response.status} ${response.statusText}`,
      )
    }

    const contentType = response.headers.get('content-type') ?? ''
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    let ext =
      extensionFromUrl(validation.url.href) ||
      extensionFromMimeType(contentType)
    if (ext === 'svg' && contentType && !contentType.includes('svg')) {
      ext = extensionFromMimeType(contentType)
    }

    const dir = path.join(getImagesDir(), knifeId)
    await fs.mkdir(dir, { recursive: true })

    const filename = `image-${String(index + 1).padStart(2, '0')}.${ext}`
    const filePath = path.join(dir, filename)
    await fs.writeFile(filePath, buffer)

    return `${knifeId}/${filename}`
  }

  async saveDataUrl(
    dataUrl: string,
    knifeId: string,
    index: number,
  ): Promise<string> {
    const match = dataUrl.match(/^data:image\/([a-z0-9+]+);base64,/i)
    if (!match) {
      throw new Error('Invalid image data URL')
    }

    const base64 = dataUrl.slice(match[0].length)
    const buffer = Buffer.from(base64, 'base64')
    const ext = extensionFromDataUrl(dataUrl)

    const dir = path.join(getImagesDir(), knifeId)
    await fs.mkdir(dir, { recursive: true })

    const filename = `image-${String(index + 1).padStart(2, '0')}.${ext}`
    const filePath = path.join(dir, filename)
    await fs.writeFile(filePath, buffer)

    return `${knifeId}/${filename}`
  }

  async createKnife(input: CreateKnifeInput): Promise<Knife> {
    const normalizedInput = normalizeKnifeTextFields(input)
    const id = await this.ensureUniqueId(generateId(normalizedInput.name))
    const addedAt = new Date().toISOString()
    const updatedAt = addedAt

    const imagePaths: string[] = (
      await processInBatches(
        normalizedInput.imageUrls,
        5,
        async (src, index) => {
          try {
            if (src.startsWith('data:image')) {
              return await this.saveDataUrl(src, id, index)
            }
            return await this.downloadImage(src, id, index)
          } catch {
            // Skip images that fail to download.
            return null
          }
        },
      )
    ).filter((relativePath): relativePath is string => relativePath !== null)

    const customFields: Knife['customFields'] = Object.fromEntries(
      Object.entries(normalizedInput.customFields ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )

    const newKnife: Knife = {
      id,
      name: normalizedInput.name,
      brand: normalizedInput.brand,
      bladeStyle: normalizedInput.bladeStyle,
      handleMaterial: normalizedInput.handleMaterial,
      images: imagePaths,
      specs: normalizedInput.specs,
      customFields,
      description: normalizedInput.description,
      addedAt,
      updatedAt,
      sourceUrl: normalizedInput.sourceUrl ?? '',
      pinned: normalizedInput.pinned ?? false,
    }

    getDb()
      .prepare(
        `INSERT INTO knives (id, name, brand, steel, blade_style, handle_material, images, specs, custom_fields, description, added_at, updated_at, source_url, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newKnife.id,
        newKnife.name,
        newKnife.brand,
        '',
        newKnife.bladeStyle,
        newKnife.handleMaterial,
        JSON.stringify(newKnife.images),
        JSON.stringify(newKnife.specs),
        JSON.stringify(newKnife.customFields),
        newKnife.description,
        newKnife.addedAt,
        newKnife.updatedAt,
        newKnife.sourceUrl,
        newKnife.pinned ? 1 : 0,
      )

    return newKnife
  }

  async updateKnife(id: string, updates: KnifeUpdates): Promise<Knife> {
    const existing = await this.getKnifeById(id)
    if (!existing) {
      throw new Error(`Knife with id "${id}" not found`)
    }

    const normalizedUpdates = normalizeKnifeTextFields(updates)

    const incomingImages = normalizedUpdates.images ?? existing.images
    const existingExternalUrls = new Set(
      existing.images.filter(
        (src) => src.startsWith('http://') || src.startsWith('https://'),
      ),
    )

    let nextIndex = getNextImageIndex(existing.images)
    const processedImages: string[] = []

    for (const src of incomingImages) {
      if (src.startsWith('data:image')) {
        try {
          const relativePath = await this.saveDataUrl(src, id, nextIndex)
          processedImages.push(relativePath)
          nextIndex += 1
        } catch {
          // Skip images that fail to decode.
        }
      } else if (src.startsWith('http://') || src.startsWith('https://')) {
        if (existingExternalUrls.has(src)) {
          processedImages.push(src)
        } else {
          try {
            const relativePath = await this.downloadImage(src, id, nextIndex)
            processedImages.push(relativePath)
            nextIndex += 1
          } catch {
            // Skip images that fail to download.
          }
        }
      } else {
        processedImages.push(src)
      }
    }

    for (const img of existing.images) {
      if (
        !processedImages.includes(img) &&
        !img.startsWith('http://') &&
        !img.startsWith('https://')
      ) {
        try {
          const filePath = path.join(getImagesDir(), img)
          const resolved = path.resolve(filePath)
          const base = path.resolve(getImagesDir())
          if (resolved === base || resolved.startsWith(`${base}${path.sep}`)) {
            await fs.unlink(resolved)
          }
        } catch {
          // ignore cleanup errors
        }
      }
    }

    const updatedAt = new Date().toISOString()
    const updated: Knife = {
      ...existing,
      name: normalizedUpdates.name ?? existing.name,
      brand: normalizedUpdates.brand ?? existing.brand,
      bladeStyle: normalizedUpdates.bladeStyle ?? existing.bladeStyle,
      handleMaterial:
        normalizedUpdates.handleMaterial ?? existing.handleMaterial,
      description: normalizedUpdates.description ?? existing.description,
      sourceUrl: normalizedUpdates.sourceUrl ?? existing.sourceUrl,
      images: processedImages,
      pinned: normalizedUpdates.pinned ?? existing.pinned,
      updatedAt,
      specs: {
        ...existing.specs,
        ...(normalizedUpdates.specs ?? {}),
      },
      customFields: Object.fromEntries(
        Object.entries({
          ...existing.customFields,
          ...normalizedUpdates.customFields,
        }).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    }

    getDb()
      .prepare(
        `UPDATE knives
         SET name = ?, brand = ?, steel = ?, blade_style = ?, handle_material = ?, images = ?, specs = ?, custom_fields = ?, description = ?, updated_at = ?, source_url = ?, pinned = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.brand,
        '',
        updated.bladeStyle,
        updated.handleMaterial,
        JSON.stringify(updated.images),
        JSON.stringify(updated.specs),
        JSON.stringify(updated.customFields),
        updated.description,
        updated.updatedAt,
        updated.sourceUrl,
        updated.pinned ? 1 : 0,
        id,
      )

    return updated
  }

  async bulkUpdateKnives(
    ids: string[],
    updates: KnifeUpdates,
  ): Promise<Knife[]> {
    const uniqueIds = Array.from(new Set(ids))
    if (uniqueIds.length === 0) return []

    const database = getDb()
    const selectStatement = database.prepare(
      'SELECT * FROM knives WHERE id = ?',
    )
    const rows = uniqueIds
      .map(
        (id) => selectStatement.get(id) as Record<string, unknown> | undefined,
      )
      .filter((row): row is Record<string, unknown> => Boolean(row))

    if (rows.length !== uniqueIds.length) {
      throw new Error('One or more selected knives could not be found')
    }

    const normalizedUpdates = normalizeKnifeTextFields(updates)
    const rowsById = new Map(
      rows.map((row) => {
        const knife = rowToKnife(row)
        return [knife.id, knife]
      }),
    )
    const updatedAt = new Date().toISOString()
    const updateStatement = database.prepare(
      `UPDATE knives
       SET name = ?, brand = ?, steel = ?, blade_style = ?, handle_material = ?, images = ?, specs = ?, custom_fields = ?, description = ?, updated_at = ?, source_url = ?, pinned = ?
       WHERE id = ?`,
    )

    const updateAll = database.transaction(() =>
      uniqueIds.map((id) => {
        const existing = rowsById.get(id)
        if (!existing) {
          throw new Error(`Knife with id "${id}" not found`)
        }

        const updated: Knife = {
          ...existing,
          name: normalizedUpdates.name ?? existing.name,
          brand: normalizedUpdates.brand ?? existing.brand,
          bladeStyle: normalizedUpdates.bladeStyle ?? existing.bladeStyle,
          handleMaterial:
            normalizedUpdates.handleMaterial ?? existing.handleMaterial,
          description: normalizedUpdates.description ?? existing.description,
          sourceUrl: normalizedUpdates.sourceUrl ?? existing.sourceUrl,
          images: normalizedUpdates.images ?? existing.images,
          pinned: normalizedUpdates.pinned ?? existing.pinned,
          updatedAt,
          specs: {
            ...existing.specs,
            ...(normalizedUpdates.specs ?? {}),
          },
          customFields: Object.fromEntries(
            Object.entries({
              ...existing.customFields,
              ...normalizedUpdates.customFields,
            }).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string',
            ),
          ),
        }

        updateStatement.run(
          updated.name,
          updated.brand,
          '',
          updated.bladeStyle,
          updated.handleMaterial,
          JSON.stringify(updated.images),
          JSON.stringify(updated.specs),
          JSON.stringify(updated.customFields),
          updated.description,
          updated.updatedAt,
          updated.sourceUrl,
          updated.pinned ? 1 : 0,
          id,
        )

        return updated
      }),
    )

    return updateAll()
  }

  async deleteKnife(id: string): Promise<void> {
    const knife = await this.getKnifeById(id)
    if (!knife) return

    getDb().prepare('DELETE FROM knives WHERE id = ?').run(id)
    getDb().prepare('DELETE FROM compare_list WHERE knife_id = ?').run(id)

    try {
      const dir = path.join(getImagesDir(), id)
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }

  async getCompareList(): Promise<string[]> {
    const rows = getDb()
      .prepare(
        'SELECT knife_id FROM compare_list ORDER BY added_at DESC, rowid DESC',
      )
      .all() as Array<{ knife_id: string }>
    return rows.map((r) => r.knife_id)
  }

  async addToCompare(id: string): Promise<void> {
    const addedAt = new Date().toISOString()
    getDb()
      .prepare(
        'INSERT OR IGNORE INTO compare_list (knife_id, added_at) VALUES (?, ?)',
      )
      .run(id, addedAt)
  }

  async removeFromCompare(id: string): Promise<void> {
    getDb().prepare('DELETE FROM compare_list WHERE knife_id = ?').run(id)
  }

  async clearCompareList(): Promise<void> {
    getDb().prepare('DELETE FROM compare_list').run()
  }

  async migrateKnife(knife: Knife, images: string[]): Promise<void> {
    const normalizedKnife = normalizeKnifeTextFields(knife)
    const restoredUpdatedAt =
      normalizedKnife.updatedAt?.trim() || normalizedKnife.addedAt

    getDb()
      .prepare(
        `INSERT OR REPLACE INTO knives (id, name, brand, steel, blade_style, handle_material, images, specs, custom_fields, description, added_at, updated_at, source_url, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalizedKnife.id,
        normalizedKnife.name,
        normalizedKnife.brand,
        '',
        normalizedKnife.bladeStyle,
        normalizedKnife.handleMaterial,
        JSON.stringify(images),
        JSON.stringify(normalizedKnife.specs),
        JSON.stringify(normalizedKnife.customFields),
        normalizedKnife.description,
        normalizedKnife.addedAt,
        restoredUpdatedAt,
        normalizedKnife.sourceUrl,
        normalizedKnife.pinned ? 1 : 0,
      )
  }

  async migrateCompareList(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.addToCompare(id)
      } catch {
        // ignore invalid compare ids during bulk restore
      }
    }
  }

  async replaceAllWithSnapshot(
    knives: Knife[],
    compareIds: string[],
  ): Promise<void> {
    const current = await this.getAllKnives()

    for (const knife of current) {
      await this.deleteKnife(knife.id)
    }

    for (const knife of knives) {
      const importedImages: string[] = (
        await processInBatches(knife.images, 5, async (image, index) => {
          if (image.startsWith('data:image')) {
            try {
              return await this.saveDataUrl(image, knife.id, index)
            } catch {
              // ignore broken embedded images during restore
              return null
            }
          }

          if (image.startsWith('http://') || image.startsWith('https://')) {
            try {
              return await this.downloadImage(image, knife.id, index)
            } catch {
              return image
            }
          }

          return image
        })
      ).filter((relativePath): relativePath is string => relativePath !== null)

      await this.migrateKnife(knife, importedImages)
    }

    await this.clearCompareList()
    await this.migrateCompareList(compareIds)
  }

  async getImage(relativePath: string): Promise<ImageData> {
    const filePath = path.join(getImagesDir(), relativePath)
    const resolved = path.resolve(filePath)
    const base = path.resolve(getImagesDir())

    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error('Invalid image path')
    }

    const buffer = await fs.readFile(resolved)
    const ext = path.extname(resolved).toLowerCase()
    const contentType =
      {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.avif': 'image/avif',
        '.svg': 'image/svg+xml',
      }[ext] ?? 'application/octet-stream'

    return { buffer, contentType }
  }
}
