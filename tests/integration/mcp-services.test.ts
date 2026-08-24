import { afterEach, describe, expect, it } from 'vitest'
import { getLocalDb } from '@/lib/local-db'
import { getMcpRuntimeStatus } from '@/lib/mcp/config'
import {
  findDuplicates,
  findMissingFields,
  getCollectionStats,
  getKnifeDetails,
  searchKnives,
} from '@/lib/services/collection-service'
import {
  bulkUpdateKnifeMetadata,
  proposeKnifeChanges,
  updateKnifeMetadata,
} from '@/lib/services/knife-service'
import {
  addMaintenanceEvent,
  getKnifeMaintenance,
} from '@/lib/services/maintenance-service'
import { LocalStorage } from '@/lib/storage/local'
import type { CreateKnifeInput } from '@/lib/storage/types'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

const baseInput: CreateKnifeInput = {
  name: 'Bugout',
  brand: 'Benchmade',
  bladeStyle: 'Drop Point',
  handleMaterial: 'Grivory',
  imageUrls: [],
  specs: {
    weight: '1.85 oz',
    overallLength: '7.46 in',
    bladeLength: '3.24 in',
    bladeMaterial: 'CPM-S30V',
    modelNumber: '535',
    country: 'USA',
  },
  customFields: {},
  description: '',
  sourceUrl: 'https://example.com/bugout',
  pinned: false,
}

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('MCP collection and mutation services', () => {
  it('searches existing fields and scores likely duplicates', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    await storage.createKnife(baseInput)
    await storage.createKnife({ ...baseInput, name: 'Bugout duplicate' })

    const search = await searchKnives({
      query: 'S30V',
      filters: [{ field: 'country', value: 'USA' }],
      limit: 10,
      offset: 0,
    })
    expect(search.total).toBe(2)
    const duplicates = await findDuplicates({ limit: 10 })
    expect(duplicates.candidates[0]).toMatchObject({ score: 100 })

    const details = await getKnifeDetails('bugout')
    expect(details.knife).toMatchObject({
      id: 'bugout',
      specs: { bladeMaterial: 'CPM-S30V' },
    })
    const stats = await getCollectionStats({ includeSchema: true })
    expect(stats).toMatchObject({ total: 2, duplicateCandidateCount: 1 })
    expect(stats.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'specs.bladeMaterial',
          aliases: expect.arrayContaining(['steel']),
        }),
      ]),
    )
    const missing = await findMissingFields({
      fields: ['designer'],
      limit: 10,
    })
    expect(missing.fields[0]).toMatchObject({
      field: 'specs.designer',
      total: 2,
    })
  })

  it('previews, locks, applies atomically, and audits metadata updates', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const first = await storage.createKnife(baseInput)
    const second = await storage.createKnife({ ...baseInput, name: 'Bailout' })

    const proposal = await proposeKnifeChanges([
      {
        knifeId: first.id,
        field: 'steel',
        proposedValue: 'CPM-M4',
        reason: 'Verified manufacturer specification',
      },
    ])
    expect(proposal.proposals[0]).toMatchObject({
      valid: true,
      field: 'specs.bladeMaterial',
      currentValue: 'CPM-S30V',
    })
    expect((await storage.getKnifeById(first.id))?.specs.bladeMaterial).toBe(
      'CPM-S30V',
    )

    await expect(
      updateKnifeMetadata({
        knifeId: first.id,
        expectedUpdatedAt: 'stale',
        changes: [{ field: 'steel', value: 'CPM-M4' }],
        transport: 'stdio',
      }),
    ).rejects.toThrow('changed after it was read')

    const preview = await bulkUpdateKnifeMetadata({
      items: [
        {
          knifeId: first.id,
          expectedUpdatedAt: first.updatedAt,
          changes: [{ field: 'steel', value: 'CPM-M4' }],
        },
        {
          knifeId: second.id,
          expectedUpdatedAt: second.updatedAt,
          changes: [{ field: 'country', value: 'Japan' }],
        },
      ],
      transport: 'http',
    })
    expect(preview).toMatchObject({ applied: false, validCount: 2 })

    const applied = await bulkUpdateKnifeMetadata({
      items: [
        {
          knifeId: first.id,
          expectedUpdatedAt: first.updatedAt,
          changes: [{ field: 'steel', value: 'CPM-M4' }],
        },
        {
          knifeId: second.id,
          expectedUpdatedAt: second.updatedAt,
          changes: [{ field: 'country', value: 'Japan' }],
        },
      ],
      apply: true,
      previewHash: preview.previewHash,
      transport: 'http',
    })
    expect(applied).toMatchObject({ applied: true, changedCount: 2 })
    expect(
      getLocalDb()
        .prepare('SELECT COUNT(*) AS count FROM knife_change_log')
        .get(),
    ).toEqual({ count: 2 })
    expect(getMcpRuntimeStatus().stats).toMatchObject({
      knifeCount: 2,
      writeOperationCount: 1,
      changedKnifeCount: 2,
    })
    expect(getMcpRuntimeStatus().stats.lastWriteAt).toBeTruthy()
  })

  it('reads and adds maintenance events through service helpers', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife(baseInput)

    await addMaintenanceEvent({
      knifeId: knife.id,
      type: 'cleaning',
      occurredAt: '2026-08-10T00:00:00.000Z',
      notes: 'Ultrasonic',
      origin: 'mcp',
    })

    await addMaintenanceEvent({
      knifeId: knife.id,
      type: 'sharpening',
      occurredAt: '2026-08-05T00:00:00.000Z',
      sharpeningDetails: {
        grit: '600',
        system: 'KME',
      },
    })

    const maintenance = await getKnifeMaintenance(knife.id)
    expect(maintenance.events).toHaveLength(2)
    expect(maintenance.lastDone.cleaned).toBe('2026-08-10T00:00:00.000Z')
    expect(maintenance.lastDone.sharpened).toBe('2026-08-05T00:00:00.000Z')
    expect(await storage.getAuditLog()).toContainEqual(
      expect.objectContaining({
        knifeId: knife.id,
        actor: 'MCP client',
        source: 'MCP / add_maintenance_event',
        summary: 'Cleaning was logged.',
      }),
    )

    await expect(
      addMaintenanceEvent({
        knifeId: 'missing',
        type: 'cleaning',
      }),
    ).rejects.toThrow('not found')
  })

  it('validates single and bulk mutation boundaries', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife(baseInput)

    const updated = await updateKnifeMetadata({
      knifeId: knife.id,
      expectedUpdatedAt: knife.updatedAt,
      changes: [{ field: 'designer', value: 'Ray Laconico' }],
      transport: 'stdio',
    })
    expect(updated).toMatchObject({
      changed: true,
      knife: { specs: { designer: 'Ray Laconico' } },
    })

    await expect(
      updateKnifeMetadata({
        knifeId: knife.id,
        expectedUpdatedAt: updated.knife.updatedAt,
        changes: [{ field: 'images', value: 'outside-the-vault' }],
        transport: 'stdio',
      }),
    ).rejects.toThrow('Unsupported field')
    await expect(
      bulkUpdateKnifeMetadata({ items: [], transport: 'http' }),
    ).rejects.toThrow('at least one')
    await expect(
      bulkUpdateKnifeMetadata({
        items: [
          {
            knifeId: knife.id,
            changes: [{ field: 'brand', value: 'One' }],
          },
          {
            knifeId: knife.id,
            changes: [{ field: 'brand', value: 'Two' }],
          },
        ],
        transport: 'http',
      }),
    ).rejects.toThrow('duplicate knife IDs')
    await expect(
      bulkUpdateKnifeMetadata({
        items: Array.from({ length: 101 }, (_, index) => ({
          knifeId: `knife-${index}`,
          changes: [{ field: 'brand', value: 'Maker' }],
        })),
        transport: 'http',
      }),
    ).rejects.toThrow('at most 100')
  })
})
