import { afterEach, describe, expect, it, vi } from 'vitest'
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
    country: 'USA',
  },
  customFields: {},
  description: 'Light folder',
  sourceUrl: '',
  pinned: false,
}

afterEach(async () => {
  vi.useRealTimers()
  await vault?.cleanup()
  vault = null
})

describe('LocalStorage maintenance events', () => {
  it('creates, lists, updates, and deletes maintenance events', async () => {
    vault = await createTempVault()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'))

    const storage = new LocalStorage()
    const knife = await storage.createKnife(baseInput)

    const event = await storage.addMaintenanceEvent(knife.id, {
      type: 'cleaning',
      occurredAt: '2026-08-10T12:00:00.000Z',
      notes: 'Ultrasonic bath',
    })

    expect(event).toMatchObject({
      knifeId: knife.id,
      type: 'cleaning',
      notes: 'Ultrasonic bath',
    })

    const sharpening = await storage.addMaintenanceEvent(knife.id, {
      type: 'sharpening',
      occurredAt: '2026-08-05T12:00:00.000Z',
      sharpeningDetails: {
        grit: '600',
        angle: '20°',
        passes: 50,
      },
    })

    expect(sharpening.sharpeningDetails).toEqual({
      grit: '600',
      angle: '20°',
      passes: 50,
    })

    const events = await storage.getMaintenanceEvents(knife.id)
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('cleaning')
    expect(events[1]?.type).toBe('sharpening')

    expect(
      (await storage.getKnifeActivity()).filter(
        (activity) => activity.type === 'maintained',
      ),
    ).toEqual([
      {
        knifeId: knife.id,
        type: 'maintained',
        occurredAt: '2026-08-05T12:00:00.000Z',
      },
      {
        knifeId: knife.id,
        type: 'maintained',
        occurredAt: '2026-08-10T12:00:00.000Z',
      },
    ])

    const maintenanceAudit = (await storage.getAuditLog()).filter(
      (audit) => audit.source === 'Maintenance',
    )
    expect(maintenanceAudit).toHaveLength(2)
    expect(maintenanceAudit[0]).toMatchObject({
      type: 'updated',
      knifeId: knife.id,
      subject: 'Benchmade · Bugout',
      actor: 'You',
      source: 'Maintenance',
      summary: 'Sharpening was logged.',
    })

    const updated = await storage.updateMaintenanceEvent(event.id, {
      notes: 'Ultrasonic bath and dry',
    })
    expect(updated.notes).toBe('Ultrasonic bath and dry')

    const clearedSharpening = await storage.updateMaintenanceEvent(
      sharpening.id,
      {
        type: 'cleaning',
        sharpeningDetails: null,
      },
    )
    expect(clearedSharpening.type).toBe('cleaning')
    expect(clearedSharpening.sharpeningDetails).toBeUndefined()

    await storage.deleteMaintenanceEvent(sharpening.id)
    const remaining = await storage.getMaintenanceEvents(knife.id)
    expect(remaining).toHaveLength(1)
    expect(
      (await storage.getKnifeActivity()).filter(
        (activity) => activity.type === 'maintained',
      ),
    ).toHaveLength(1)
  })

  it('rejects invalid maintenance types and missing knives', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife(baseInput)

    await expect(
      storage.addMaintenanceEvent(knife.id, {
        type: 'invalid' as never,
        occurredAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('Invalid maintenance type')

    await expect(
      storage.addMaintenanceEvent('missing', {
        type: 'cleaning',
        occurredAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('not found')
  })

  it('cascades maintenance events when a knife is deleted', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife(baseInput)

    await storage.addMaintenanceEvent(knife.id, {
      type: 'cleaning',
      occurredAt: new Date().toISOString(),
    })

    expect(await storage.getMaintenanceEvents(knife.id)).toHaveLength(1)
    await storage.deleteKnife(knife.id)
    expect(await storage.getMaintenanceEvents(knife.id)).toHaveLength(0)
  })
})
