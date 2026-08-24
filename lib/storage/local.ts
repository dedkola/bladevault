import fs from 'fs/promises'
import { createReadStream } from 'fs'
import path from 'path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'stream'
import {
  AuditLogEvent,
  AuditLogEventChange,
  Knife,
  KnifeActivityEvent,
  KnifeUpdates,
  MaintenanceEvent,
  MaintenanceEventInput,
  MaintenanceEventUpdate,
  MaintenanceType,
  isMaintenanceType,
  maintenanceTypeName,
} from '@/lib/data'
import { normalizeKnifeTextFields } from '@/lib/knife-text'
import { getLocalDb, getLocalImagesDirPath } from '@/lib/local-db'
import { fetchExternalUrl, validateExternalUrl } from '@/lib/url-validation'
import {
  type BulkKnifeUpdateItem,
  type CreateKnifeInput,
  type ImageData,
  type ImageStream,
  type KnifeMutationContext,
  type KnifeUpdateOptions,
  type MaintenanceEventOptions,
  type Storage,
} from './types'

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

function nextUpdatedAt(previous: string): string {
  const previousTime = Date.parse(previous)
  const nextTime = Number.isFinite(previousTime)
    ? Math.max(Date.now(), previousTime + 1)
    : Date.now()
  return new Date(nextTime).toISOString()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatKnifeSubject(knife: { brand: string; name: string }): string {
  return `${knife.brand} · ${knife.name}`
}

function generateOperationId(): string {
  return `op_${randomUUID()}`
}

function recordAuditEvent(
  database: ReturnType<typeof getLocalDb>,
  event: {
    operationId: string
    type: AuditLogEvent['type']
    knifeId: string | null
    subject: string
    actor: string
    source: string
    summary: string
    changes: AuditLogEventChange[]
    occurredAt: string
  },
) {
  database
    .prepare(
      `INSERT INTO audit_log
       (operation_id, event_type, knife_id, subject, actor, source, summary, changes, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.operationId,
      event.type,
      event.knifeId,
      event.subject,
      event.actor,
      event.source,
      event.summary,
      JSON.stringify(event.changes),
      event.occurredAt,
    )
}

function computeUpdateChanges(
  existing: Knife,
  updated: Knife,
): AuditLogEventChange[] {
  const changes: AuditLogEventChange[] = []
  const fields: Array<{ path: keyof Knife; label: string }> = [
    { path: 'name', label: 'Model' },
    { path: 'brand', label: 'Brand / Maker' },
    { path: 'bladeStyle', label: 'Blade Style' },
    { path: 'handleMaterial', label: 'Handle Material' },
    { path: 'description', label: 'Description' },
    { path: 'sourceUrl', label: 'Source URL' },
  ]

  for (const { path: field, label } of fields) {
    const before = String(existing[field] ?? '')
    const after = String(updated[field] ?? '')
    if (before !== after) {
      changes.push({ field: label, before, after })
    }
  }

  if (existing.pinned !== updated.pinned) {
    changes.push({
      field: 'Pinned',
      before: String(existing.pinned),
      after: String(updated.pinned),
    })
  }

  const specFields: Array<{ path: keyof Knife['specs']; label: string }> = [
    { path: 'weight', label: 'Weight' },
    { path: 'overallLength', label: 'Overall Length' },
    { path: 'bladeLength', label: 'Blade Length' },
    { path: 'bladeThickness', label: 'Blade Thickness' },
    { path: 'bladeCoating', label: 'Blade Coating / Finish' },
    { path: 'bladeMaterial', label: 'Blade Material' },
    { path: 'lockingMechanism', label: 'Locking Mechanism' },
    { path: 'designer', label: 'Designer' },
    { path: 'modelNumber', label: 'Model Number' },
    { path: 'handleLength', label: 'Handle Length' },
    { path: 'hardness', label: 'Hardness' },
    { path: 'price', label: 'Price' },
    { path: 'country', label: 'Country' },
  ]

  for (const { path: field, label } of specFields) {
    const before = String(existing.specs[field] ?? '')
    const after = String(updated.specs[field] ?? '')
    if (before !== after) {
      changes.push({ field: label, before, after })
    }
  }

  const allCustomFieldKeys = new Set([
    ...Object.keys(existing.customFields),
    ...Object.keys(updated.customFields),
  ])
  for (const key of allCustomFieldKeys) {
    const before = String(existing.customFields[key] ?? '')
    const after = String(updated.customFields[key] ?? '')
    if (before !== after) {
      changes.push({ field: key, before, after })
    }
  }

  if (existing.images.length !== updated.images.length) {
    changes.push({
      field: 'Images',
      before: `${existing.images.length}`,
      after: `${updated.images.length}`,
    })
  }

  return changes
}

function recordMutation(
  database: ReturnType<typeof getLocalDb>,
  knifeId: string,
  occurredAt: string,
  mutation: KnifeMutationContext | undefined,
) {
  if (!mutation || mutation.changes.length === 0) return

  database
    .prepare(
      `INSERT INTO knife_change_log
       (operation_id, knife_id, source, transport, changes, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mutation.operationId,
      knifeId,
      mutation.source,
      mutation.transport,
      JSON.stringify(mutation.changes),
      occurredAt,
    )
}

export class LocalStorage implements Storage {
  async getAllKnives(): Promise<Knife[]> {
    const rows = getDb()
      .prepare('SELECT * FROM knives ORDER BY added_at DESC')
      .all()
    return rows.map((row) => rowToKnife(row as Record<string, unknown>))
  }

  async getKnifeActivity(): Promise<KnifeActivityEvent[]> {
    const rows = getDb()
      .prepare(
        `SELECT knife_id, event_type, occurred_at
         FROM (
           SELECT id, 0 AS source_order, knife_id, event_type, occurred_at
           FROM knife_activity
           UNION ALL
           SELECT id, 1 AS source_order, knife_id, 'maintained' AS event_type, occurred_at
           FROM maintenance_events
         )
         ORDER BY occurred_at ASC, source_order ASC, id ASC`,
      )
      .all() as Array<{
      id: number
      knife_id: string
      event_type: KnifeActivityEvent['type']
      occurred_at: string
    }>

    return rows.map((row) => ({
      knifeId: row.knife_id,
      type: row.event_type,
      occurredAt: row.occurred_at,
    }))
  }

  async getAuditLog(): Promise<AuditLogEvent[]> {
    const rows = getDb()
      .prepare(
        `SELECT id, operation_id, event_type, knife_id, subject, actor, source, summary, changes, occurred_at
         FROM audit_log
         ORDER BY occurred_at DESC, id DESC`,
      )
      .all() as Array<{
      id: number
      operation_id: string
      event_type: AuditLogEvent['type']
      knife_id: string | null
      subject: string
      actor: string
      source: string
      summary: string
      changes: string
      occurred_at: string
    }>

    return rows.map((row) => ({
      id: row.id,
      operationId: row.operation_id,
      type: row.event_type,
      knifeId: row.knife_id,
      subject: row.subject,
      actor: row.actor,
      source: row.source,
      summary: row.summary,
      changes: (JSON.parse(row.changes) as AuditLogEventChange[]) ?? [],
      occurredAt: row.occurred_at,
    }))
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

    const imagePaths: string[] = []
    for (let i = 0; i < normalizedInput.imageUrls.length; i++) {
      try {
        const src = normalizedInput.imageUrls[i]
        let relativePath: string
        if (src.startsWith('data:image')) {
          relativePath = await this.saveDataUrl(src, id, i)
        } else {
          relativePath = await this.downloadImage(src, id, i)
        }
        imagePaths.push(relativePath)
      } catch {
        // Skip images that fail to download.
      }
    }

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

    const database = getDb()
    const create = database.transaction(() => {
      database
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
      database
        .prepare(
          `INSERT INTO knife_activity (knife_id, event_type, occurred_at)
           VALUES (?, 'created', ?)`,
        )
        .run(newKnife.id, newKnife.addedAt)
      recordAuditEvent(database, {
        operationId: generateOperationId(),
        type: 'created',
        knifeId: newKnife.id,
        subject: formatKnifeSubject(newKnife),
        actor: 'You',
        source: 'Manual entry',
        summary: 'Created a new record with images and source URL.',
        changes: [
          { field: 'Record', before: 'Does not exist', after: 'Created' },
          {
            field: 'Images',
            before: '0',
            after: `${imagePaths.length} downloaded`,
          },
        ],
        occurredAt: newKnife.addedAt,
      })
    })
    create()

    return newKnife
  }

  async updateKnife(
    id: string,
    updates: KnifeUpdates,
    options: KnifeUpdateOptions = {},
  ): Promise<Knife> {
    const existing = await this.getKnifeById(id)
    if (!existing) {
      throw new Error(`Knife with id "${id}" not found`)
    }
    if (
      options.expectedUpdatedAt &&
      options.expectedUpdatedAt !== existing.updatedAt
    ) {
      throw new Error(
        `Knife "${id}" changed after it was read; fetch it again before updating`,
      )
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

    const updatedAt = options.expectedUpdatedAt
      ? nextUpdatedAt(existing.updatedAt)
      : new Date().toISOString()
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

    const database = getDb()
    const update = database.transaction(() => {
      const updateStatement = database.prepare(
        `UPDATE knives
         SET name = ?, brand = ?, steel = ?, blade_style = ?, handle_material = ?, images = ?, specs = ?, custom_fields = ?, description = ?, updated_at = ?, source_url = ?, pinned = ?
         WHERE id = ?${options.expectedUpdatedAt ? ' AND updated_at = ?' : ''}`,
      )
      const parameters = [
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
        ...(options.expectedUpdatedAt ? [existing.updatedAt] : []),
      ]
      const result = updateStatement.run(...parameters)
      if (result.changes !== 1) {
        throw new Error(
          `Knife "${id}" changed after it was read; fetch it again before updating`,
        )
      }
      database
        .prepare(
          `INSERT INTO knife_activity (knife_id, event_type, occurred_at)
           VALUES (?, 'updated', ?)`,
        )
        .run(id, updated.updatedAt)
      recordMutation(database, id, updated.updatedAt, options.mutation)

      const mutation = options.mutation
      const mutationChanges = mutation?.changes ?? []
      if (mutation && mutationChanges.length > 0) {
        recordAuditEvent(database, {
          operationId: mutation.operationId,
          type: 'updated',
          knifeId: id,
          subject: formatKnifeSubject(updated),
          actor: 'MCP client',
          source: 'MCP / update_knife',
          summary: 'Applied metadata update via MCP.',
          changes: mutationChanges.map((change) => ({
            field: change.field,
            before: String(change.previousValue),
            after: String(change.value),
          })),
          occurredAt: updated.updatedAt,
        })
      } else {
        const manualChanges = computeUpdateChanges(existing, updated)
        if (manualChanges.length > 0) {
          recordAuditEvent(database, {
            operationId: generateOperationId(),
            type: 'updated',
            knifeId: id,
            subject: formatKnifeSubject(updated),
            actor: 'You',
            source: 'Manual entry',
            summary: 'Updated record fields.',
            changes: manualChanges,
            occurredAt: updated.updatedAt,
          })
        }
      }
    })
    update()

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
    const activityStatement = database.prepare(
      `INSERT INTO knife_activity (knife_id, event_type, occurred_at)
       VALUES (?, 'updated', ?)`,
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
        activityStatement.run(id, updated.updatedAt)
        const changes = computeUpdateChanges(existing, updated)
        if (changes.length > 0) {
          recordAuditEvent(database, {
            operationId: generateOperationId(),
            type: 'updated',
            knifeId: id,
            subject: formatKnifeSubject(updated),
            actor: 'You',
            source: 'Bulk edit',
            summary: 'Applied bulk update to record fields.',
            changes,
            occurredAt: updated.updatedAt,
          })
        }

        return updated
      }),
    )

    return updateAll()
  }

  async bulkUpdateKnifeItems(
    items: BulkKnifeUpdateItem[],
    context: Omit<KnifeMutationContext, 'changes'>,
  ): Promise<Knife[]> {
    const ids = items.map(({ id }) => id)
    const uniqueIds = new Set(ids)
    if (items.length === 0) return []
    if (uniqueIds.size !== items.length) {
      throw new Error('Bulk updates cannot contain duplicate knife IDs')
    }

    const database = getDb()
    const selectStatement = database.prepare(
      'SELECT * FROM knives WHERE id = ?',
    )
    const updateStatement = database.prepare(
      `UPDATE knives
       SET name = ?, brand = ?, steel = ?, blade_style = ?, handle_material = ?, images = ?, specs = ?, custom_fields = ?, description = ?, updated_at = ?, source_url = ?, pinned = ?
       WHERE id = ?`,
    )
    const activityStatement = database.prepare(
      `INSERT INTO knife_activity (knife_id, event_type, occurred_at)
       VALUES (?, 'updated', ?)`,
    )

    const updateAll = database.transaction(() => {
      const rows = new Map<string, Knife>()
      for (const item of items) {
        const row = selectStatement.get(item.id) as
          Record<string, unknown> | undefined
        if (!row) {
          throw new Error(`Knife with id "${item.id}" not found`)
        }
        const existing = rowToKnife(row)
        if (existing.updatedAt !== item.expectedUpdatedAt) {
          throw new Error(
            `Knife "${item.id}" changed after preview; preview the bulk update again`,
          )
        }
        rows.set(item.id, existing)
      }

      return items.map((item) => {
        const existing = rows.get(item.id)
        if (!existing) {
          throw new Error(`Knife with id "${item.id}" not found`)
        }
        const updates = normalizeKnifeTextFields(item.updates)
        const updatedAt = nextUpdatedAt(existing.updatedAt)
        const updated: Knife = {
          ...existing,
          name: updates.name ?? existing.name,
          brand: updates.brand ?? existing.brand,
          bladeStyle: updates.bladeStyle ?? existing.bladeStyle,
          handleMaterial: updates.handleMaterial ?? existing.handleMaterial,
          description: updates.description ?? existing.description,
          sourceUrl: updates.sourceUrl ?? existing.sourceUrl,
          pinned: updates.pinned ?? existing.pinned,
          updatedAt,
          specs: { ...existing.specs, ...(updates.specs ?? {}) },
          customFields: {
            ...existing.customFields,
            ...Object.fromEntries(
              Object.entries(updates.customFields ?? {}).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string',
              ),
            ),
          },
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
          updated.id,
        )
        activityStatement.run(updated.id, updated.updatedAt)
        recordMutation(database, updated.id, updated.updatedAt, {
          ...context,
          changes: item.changes,
        })
        if (item.changes.length > 0) {
          recordAuditEvent(database, {
            operationId: context.operationId,
            type: 'updated',
            knifeId: updated.id,
            subject: formatKnifeSubject(updated),
            actor: 'MCP client',
            source: 'MCP / bulk_update_knives',
            summary: 'Applied bulk metadata update via MCP.',
            changes: item.changes.map((change) => ({
              field: change.field,
              before: String(change.previousValue),
              after: String(change.value),
            })),
            occurredAt: updated.updatedAt,
          })
        }
        return updated
      })
    })

    return updateAll()
  }

  async deleteKnife(id: string): Promise<void> {
    const knife = await this.getKnifeById(id)
    if (!knife) return

    const occurredAt = new Date().toISOString()
    const database = getDb()
    const remove = database.transaction(() => {
      recordAuditEvent(database, {
        operationId: generateOperationId(),
        type: 'deleted',
        knifeId: id,
        subject: formatKnifeSubject(knife),
        actor: 'You',
        source: 'Collection detail',
        summary: 'Removed the record from the collection.',
        changes: [
          {
            field: 'Record',
            before: formatKnifeSubject(knife),
            after: 'Deleted',
          },
        ],
        occurredAt,
      })
      database
        .prepare('DELETE FROM knife_change_log WHERE knife_id = ?')
        .run(id)
      database.prepare('DELETE FROM knife_activity WHERE knife_id = ?').run(id)
      database.prepare('DELETE FROM compare_list WHERE knife_id = ?').run(id)
      database.prepare('DELETE FROM knives WHERE id = ?').run(id)
    })
    remove()

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

  private rowToMaintenanceEvent(
    row: Record<string, unknown>,
  ): MaintenanceEvent {
    const sharpeningDetails = row.sharpening_details
      ? (JSON.parse(
          String(row.sharpening_details),
        ) as MaintenanceEvent['sharpeningDetails'])
      : undefined

    return {
      id: Number(row.id),
      knifeId: String(row.knife_id),
      type: String(row.type) as MaintenanceType,
      occurredAt: String(row.occurred_at),
      notes: String(row.notes ?? ''),
      sharpeningDetails,
      createdAt: String(row.created_at),
    }
  }

  async getMaintenanceEvents(knifeId: string): Promise<MaintenanceEvent[]> {
    const rows = getDb()
      .prepare(
        `SELECT id, knife_id, type, occurred_at, notes, sharpening_details, created_at
         FROM maintenance_events
         WHERE knife_id = ?
         ORDER BY occurred_at DESC, id DESC`,
      )
      .all(knifeId) as Array<Record<string, unknown>>

    return rows.map((row) => this.rowToMaintenanceEvent(row))
  }

  async addMaintenanceEvent(
    knifeId: string,
    input: MaintenanceEventInput,
    options: MaintenanceEventOptions = {},
  ): Promise<MaintenanceEvent> {
    const knife = await this.getKnifeById(knifeId)
    if (!knife) {
      throw new Error(`Knife with id "${knifeId}" not found`)
    }

    if (!isMaintenanceType(input.type)) {
      throw new Error(`Invalid maintenance type: ${input.type}`)
    }

    const occurredAt = input.occurredAt.trim() || new Date().toISOString()
    const createdAt = new Date().toISOString()
    const notes = input.notes?.trim() ?? ''
    const sharpeningDetails = input.sharpeningDetails
      ? JSON.stringify(input.sharpeningDetails)
      : null

    const database = getDb()
    const insertEvent = database.transaction(() => {
      const result = database
        .prepare(
          `INSERT INTO maintenance_events
           (knife_id, type, occurred_at, notes, sharpening_details, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          knifeId,
          input.type,
          occurredAt,
          notes,
          sharpeningDetails,
          createdAt,
        )

      const maintenanceName = maintenanceTypeName(input.type)
      const changes: AuditLogEventChange[] = [
        {
          field: 'Maintenance',
          before: 'Not logged',
          after: maintenanceName,
        },
        {
          field: 'Maintenance date',
          before: 'Not logged',
          after: occurredAt.slice(0, 10),
        },
      ]
      if (notes) {
        changes.push({ field: 'Notes', before: '', after: notes })
      }

      recordAuditEvent(database, {
        operationId: generateOperationId(),
        type: 'updated',
        knifeId,
        subject: formatKnifeSubject(knife),
        actor: options.actor ?? 'You',
        source: options.source ?? 'Maintenance',
        summary: `${maintenanceName} was logged.`,
        changes,
        occurredAt: createdAt,
      })

      return Number(result.lastInsertRowid)
    })
    const eventId = insertEvent()

    const event = await this.getMaintenanceEventById(eventId)
    if (!event) {
      throw new Error('Failed to retrieve created maintenance event')
    }
    return event
  }

  private getMaintenanceEventById(id: number): MaintenanceEvent | undefined {
    const row = getDb()
      .prepare('SELECT * FROM maintenance_events WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    return row ? this.rowToMaintenanceEvent(row) : undefined
  }

  async updateMaintenanceEvent(
    eventId: number,
    input: MaintenanceEventUpdate,
  ): Promise<MaintenanceEvent> {
    const existing = this.getMaintenanceEventById(eventId)
    if (!existing) {
      throw new Error(`Maintenance event with id "${eventId}" not found`)
    }

    if (input.type && !isMaintenanceType(input.type)) {
      throw new Error(`Invalid maintenance type: ${input.type}`)
    }

    const updates: string[] = []
    const values: (string | null)[] = []

    if (input.type) {
      updates.push('type = ?')
      values.push(input.type)
    }
    if (input.occurredAt !== undefined) {
      updates.push('occurred_at = ?')
      values.push(input.occurredAt.trim() || existing.occurredAt)
    }
    if (input.notes !== undefined) {
      updates.push('notes = ?')
      values.push(input.notes.trim())
    }
    if (input.sharpeningDetails !== undefined) {
      updates.push('sharpening_details = ?')
      values.push(
        input.sharpeningDetails
          ? JSON.stringify(input.sharpeningDetails)
          : null,
      )
    }

    if (updates.length === 0) {
      return existing
    }

    values.push(String(eventId))
    getDb()
      .prepare(
        `UPDATE maintenance_events SET ${updates.join(', ')} WHERE id = ?`,
      )
      .run(...values)

    const updated = this.getMaintenanceEventById(eventId)
    if (!updated) {
      throw new Error('Failed to retrieve updated maintenance event')
    }
    return updated
  }

  async deleteMaintenanceEvent(eventId: number): Promise<void> {
    const existing = this.getMaintenanceEventById(eventId)
    if (!existing) {
      throw new Error(`Maintenance event with id "${eventId}" not found`)
    }

    getDb().prepare('DELETE FROM maintenance_events WHERE id = ?').run(eventId)
  }

  async migrateKnife(knife: Knife, images: string[]): Promise<void> {
    const normalizedKnife = normalizeKnifeTextFields(knife)
    const restoredUpdatedAt =
      normalizedKnife.updatedAt?.trim() || normalizedKnife.addedAt

    const database = getDb()
    const migrate = database.transaction(() => {
      database
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
      database
        .prepare(
          `INSERT INTO knife_activity (knife_id, event_type, occurred_at)
           VALUES (?, 'created', ?)`,
        )
        .run(normalizedKnife.id, normalizedKnife.addedAt)
      if (restoredUpdatedAt !== normalizedKnife.addedAt) {
        database
          .prepare(
            `INSERT INTO knife_activity (knife_id, event_type, occurred_at)
             VALUES (?, 'updated', ?)`,
          )
          .run(normalizedKnife.id, restoredUpdatedAt)
      }
    })
    migrate()
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
      const importedImages: string[] = []

      for (let index = 0; index < knife.images.length; index += 1) {
        const image = knife.images[index]

        if (image.startsWith('data:image')) {
          try {
            importedImages.push(await this.saveDataUrl(image, knife.id, index))
          } catch {
            // ignore broken embedded images during restore
          }
          continue
        }

        if (image.startsWith('http://') || image.startsWith('https://')) {
          try {
            importedImages.push(
              await this.downloadImage(image, knife.id, index),
            )
          } catch {
            importedImages.push(image)
          }
          continue
        }

        importedImages.push(image)
      }

      await this.migrateKnife(knife, importedImages)
    }

    await this.clearCompareList()
    await this.migrateCompareList(compareIds)
  }

  async getImage(relativePath: string): Promise<ImageData> {
    const { resolved, contentType } = this.resolveImage(relativePath)
    const buffer = await fs.readFile(resolved)

    return { buffer, contentType }
  }

  private resolveImage(relativePath: string): {
    resolved: string
    contentType: string
  } {
    const filePath = path.join(getImagesDir(), relativePath)
    const resolved = path.resolve(filePath)
    const base = path.resolve(getImagesDir())

    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error('Invalid image path')
    }

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

    return { resolved, contentType }
  }

  async getImageStream(relativePath: string): Promise<ImageStream> {
    const { resolved, contentType } = this.resolveImage(relativePath)
    await fs.access(resolved)
    const stream = createReadStream(resolved)

    return {
      stream: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      contentType,
    }
  }
}
