import { createHash, randomUUID } from 'node:crypto'
import type { Knife } from '@/lib/data'
import {
  type KnifeChangeInput,
  type ValidatedKnifeChange,
  getKnifeFieldValue,
  resolveKnifeField,
  validateKnifeChanges,
} from '@/lib/knife-fields'
import { getSettings } from '@/lib/settings'
import { getStorage } from '@/lib/storage'
import type { BulkKnifeUpdateItem } from '@/lib/storage/types'

export type McpTransport = 'stdio' | 'http'

export type KnifeChangeProposalInput = {
  knifeId: string
  field: string
  proposedValue: string | boolean | null
  reason: string
  confidence?: number
}

export type BulkKnifeChangeInput = {
  knifeId: string
  expectedUpdatedAt?: string
  changes: KnifeChangeInput[]
}

function createPreviewHash(
  items: Array<{
    id: string
    expectedUpdatedAt: string
    changes: ValidatedKnifeChange[]
  }>,
): string {
  const payload = items
    .map((item) => ({
      id: item.id,
      expectedUpdatedAt: item.expectedUpdatedAt,
      changes: item.changes,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export async function proposeKnifeChanges(
  proposals: KnifeChangeProposalInput[],
) {
  if (proposals.length === 0) {
    throw new Error('Provide at least one proposed change')
  }
  if (proposals.length > 500) {
    throw new Error('A proposal can contain at most 500 changes')
  }

  const storage = getStorage()
  const customFields = getSettings().customFields
  const knives = new Map<string, Knife>()
  const results = []

  for (const proposal of proposals) {
    let knife = knives.get(proposal.knifeId)
    if (!knife) {
      knife = await storage.getKnifeById(proposal.knifeId)
      if (knife) knives.set(knife.id, knife)
    }
    if (!knife) {
      results.push({
        ...proposal,
        valid: false,
        error: `Knife with id "${proposal.knifeId}" not found`,
      })
      continue
    }

    try {
      const validated = validateKnifeChanges({
        knife,
        customFields,
        changes: [{ field: proposal.field, value: proposal.proposedValue }],
      })
      const change = validated.changes[0]
      const canonicalField =
        resolveKnifeField(proposal.field, customFields)?.path ?? proposal.field
      results.push({
        knifeId: knife.id,
        field: change?.field ?? canonicalField,
        currentValue:
          change?.previousValue ?? getKnifeFieldValue(knife, canonicalField),
        proposedValue: change?.value ?? proposal.proposedValue,
        reason: proposal.reason,
        confidence: proposal.confidence,
        expectedUpdatedAt: knife.updatedAt,
        valid: true,
        noOp: validated.changes.length === 0,
      })
    } catch (error) {
      results.push({
        ...proposal,
        expectedUpdatedAt: knife.updatedAt,
        valid: false,
        error: error instanceof Error ? error.message : 'Invalid proposal',
      })
    }
  }

  return {
    total: results.length,
    validCount: results.filter(({ valid }) => valid).length,
    invalidCount: results.filter(({ valid }) => !valid).length,
    proposals: results,
  }
}

export async function updateKnifeMetadata({
  knifeId,
  expectedUpdatedAt,
  changes,
  transport,
}: {
  knifeId: string
  expectedUpdatedAt: string
  changes: KnifeChangeInput[]
  transport: McpTransport
}) {
  const storage = getStorage()
  const existing = await storage.getKnifeById(knifeId)
  if (!existing) throw new Error(`Knife with id "${knifeId}" not found`)
  if (existing.updatedAt !== expectedUpdatedAt) {
    throw new Error(
      `Knife "${knifeId}" changed after it was read; fetch it again before updating`,
    )
  }

  const validated = validateKnifeChanges({
    knife: existing,
    changes,
    customFields: getSettings().customFields,
  })
  if (validated.changes.length === 0) {
    return { changed: false, changes: [], knife: existing }
  }

  const knife = await storage.updateKnife(knifeId, validated.updates, {
    expectedUpdatedAt,
    mutation: {
      operationId: randomUUID(),
      source: 'mcp',
      transport,
      changes: validated.changes,
    },
  })
  return { changed: true, changes: validated.changes, knife }
}

async function validateBulkItems(items: BulkKnifeChangeInput[]) {
  if (items.length === 0) throw new Error('Provide at least one knife update')
  if (items.length > 100) {
    throw new Error('Bulk updates can contain at most 100 knives')
  }
  const ids = items.map(({ knifeId }) => knifeId)
  if (new Set(ids).size !== ids.length) {
    throw new Error('Bulk updates cannot contain duplicate knife IDs')
  }

  const storage = getStorage()
  const customFields = getSettings().customFields
  const validItems: BulkKnifeUpdateItem[] = []
  const results: Array<Record<string, unknown>> = []

  for (const item of items) {
    const knife = await storage.getKnifeById(item.knifeId)
    if (!knife) {
      results.push({
        knifeId: item.knifeId,
        valid: false,
        error: `Knife with id "${item.knifeId}" not found`,
      })
      continue
    }
    if (item.expectedUpdatedAt && item.expectedUpdatedAt !== knife.updatedAt) {
      results.push({
        knifeId: item.knifeId,
        valid: false,
        error: 'Knife changed after it was read',
        currentUpdatedAt: knife.updatedAt,
      })
      continue
    }

    try {
      const validated = validateKnifeChanges({
        knife,
        changes: item.changes,
        customFields,
      })
      results.push({
        knifeId: item.knifeId,
        valid: true,
        noOp: validated.changes.length === 0,
        expectedUpdatedAt: knife.updatedAt,
        changes: validated.changes,
      })
      if (validated.changes.length > 0) {
        validItems.push({
          id: knife.id,
          expectedUpdatedAt: knife.updatedAt,
          updates: validated.updates,
          changes: validated.changes,
        })
      }
    } catch (error) {
      results.push({
        knifeId: item.knifeId,
        valid: false,
        error: error instanceof Error ? error.message : 'Invalid update',
      })
    }
  }

  const previewHash = createPreviewHash(
    validItems.map((item) => ({
      id: item.id,
      expectedUpdatedAt: item.expectedUpdatedAt,
      changes: item.changes,
    })),
  )
  return { validItems, results, previewHash }
}

export async function bulkUpdateKnifeMetadata({
  items,
  apply = false,
  previewHash,
  transport,
}: {
  items: BulkKnifeChangeInput[]
  apply?: boolean
  previewHash?: string
  transport: McpTransport
}) {
  const validation = await validateBulkItems(items)
  const invalidCount = validation.results.filter(
    (item) => item.valid === false,
  ).length

  if (!apply) {
    return {
      applied: false,
      previewHash: validation.previewHash,
      validCount: validation.results.length - invalidCount,
      invalidCount,
      items: validation.results,
    }
  }

  if (invalidCount > 0) {
    throw new Error('Bulk update was not applied because validation failed')
  }
  if (!previewHash || previewHash !== validation.previewHash) {
    throw new Error(
      'Bulk update preview is missing or stale; preview the exact update again',
    )
  }
  if (validation.validItems.length === 0) {
    return {
      applied: false,
      changedCount: 0,
      previewHash: validation.previewHash,
      items: validation.results,
    }
  }

  const operationId = randomUUID()
  const knives = await getStorage().bulkUpdateKnifeItems(
    validation.validItems,
    {
      operationId,
      source: 'mcp',
      transport,
    },
  )
  return {
    applied: true,
    operationId,
    changedCount: knives.length,
    knives,
  }
}
