import { afterEach, describe, expect, it } from 'vitest'
import { GET as timeline } from '@/app/api/timeline/route'
import { setAppLockPassword } from '@/lib/app-lock'
import { APP_LOCK_HEADER } from '@/lib/app-lock-shared'
import type { KnifeNote, MaintenanceEvent } from '@/lib/data'
import { LocalStorage } from '@/lib/storage/local'
import type { CreateKnifeInput } from '@/lib/storage/types'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

const knifeInput = (name: string, brand: string): CreateKnifeInput => ({
  name,
  brand,
  bladeStyle: 'Drop Point',
  handleMaterial: 'G10',
  imageUrls: [],
  specs: { weight: '', overallLength: '', bladeLength: '', country: '' },
  customFields: {},
  description: '',
  sourceUrl: '',
  pinned: false,
  sold: false,
})

describe('collection timeline data', () => {
  it('reads every knife’s maintenance and notes newest first', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const bugout = await storage.createKnife(knifeInput('Bugout', 'Benchmade'))
    const pm2 = await storage.createKnife(knifeInput('PM2', 'Spyderco'))

    await storage.addMaintenanceEvent(bugout.id, {
      type: 'cleaning',
      occurredAt: '2026-02-01T12:00:00.000Z',
    })
    await storage.addMaintenanceEvent(pm2.id, {
      type: 'sharpening',
      occurredAt: '2026-03-01T12:00:00.000Z',
      notes: 'Sharpmaker, 40°',
    })
    await storage.addKnifeNote(pm2.id, {
      body: 'First carry',
      notedAt: '2026-01-15T12:00:00.000Z',
    })
    await storage.addKnifeNote(bugout.id, {
      body: 'Swapped clip',
      notedAt: '2026-04-01T12:00:00.000Z',
    })

    const response = await timeline(
      new Request('http://localhost/api/timeline'),
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      maintenanceEvents: MaintenanceEvent[]
      notes: KnifeNote[]
    }

    expect(
      payload.maintenanceEvents.map((event) => [event.knifeId, event.type]),
    ).toEqual([
      [pm2.id, 'sharpening'],
      [bugout.id, 'cleaning'],
    ])
    expect(payload.maintenanceEvents[0].notes).toBe('Sharpmaker, 40°')
    expect(payload.notes.map((note) => [note.knifeId, note.body])).toEqual([
      [bugout.id, 'Swapped clip'],
      [pm2.id, 'First carry'],
    ])

    await storage.deleteKnife(pm2.id)
    expect(await storage.getAllMaintenanceEvents()).toEqual([
      expect.objectContaining({ knifeId: bugout.id }),
    ])
    expect(await storage.getAllKnifeNotes()).toEqual([
      expect.objectContaining({ knifeId: bugout.id }),
    ])
  })

  it('returns empty lists for an empty vault', async () => {
    vault = await createTempVault()
    const response = await timeline(
      new Request('http://localhost/api/timeline'),
    )
    expect(await response.json()).toEqual({ maintenanceEvents: [], notes: [] })
  })

  it('stays behind App Lock', async () => {
    vault = await createTempVault()
    setAppLockPassword('test')
    const response = await timeline(
      new Request('http://localhost/api/timeline'),
    )
    expect(response.status).toBe(401)
    expect(response.headers.get(APP_LOCK_HEADER)).toBe('1')
  })
})
