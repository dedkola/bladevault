import { afterEach, describe, expect, it } from 'vitest'
import * as inboxRoute from '@/app/api/care-inbox/route'
import * as knifeRoute from '@/app/api/knives/[id]/route'
import * as knivesRoute from '@/app/api/knives/route'
import { getLocalDb, LOCAL_DB_SCHEMA_VERSION } from '@/lib/local-db'
import { LocalStorage } from '@/lib/storage/local'
import { saveSettings } from '@/lib/settings'
import { DEFAULT_MAINTENANCE_REMINDERS } from '@/lib/settings-shared'
import {
  syncCareInbox,
  updateCareInbox,
} from '@/lib/services/care-inbox-service'
import type { CareNotification } from '@/lib/care-notifications'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

const now = new Date(2026, 10, 17, 9)
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 86_400_000).toISOString()

function jsonRequest(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/care-inbox', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function readNotifications(response: Response) {
  return ((await response.json()) as { notifications: CareNotification[] })
    .notifications
}

async function createKnife(name: string) {
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, brand: 'Kizer', specs: {} }),
    }),
  )
  return ((await response.json()) as { knife: { id: string } }).knife.id
}

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('care inbox storage', () => {
  it('creates the table from schema 8 on', async () => {
    vault = await createTempVault()
    expect(LOCAL_DB_SCHEMA_VERSION).toBeGreaterThanOrEqual(8)
    expect(getLocalDb().pragma('user_version', { simple: true })).toBe(
      LOCAL_DB_SCHEMA_VERSION,
    )
    expect(
      getLocalDb()
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'care_notifications'",
        )
        .get(),
    ).toBeTruthy()
  })

  it('syncs, escalates, snoozes and resolves messages', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const bone = await createKnife('Bone')
    const abrams = await createKnife('Abrams')
    await storage.addMaintenanceEvent(bone, {
      type: 'sharpening',
      occurredAt: daysAgo(80),
    })
    await storage.addMaintenanceEvent(abrams, {
      type: 'sharpening',
      occurredAt: daysAgo(1),
    })

    const first = await syncCareInbox(now)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      knifeId: bone,
      track: 'sharpening',
      level: 'due-soon',
      readAt: null,
    })
    expect(await syncCareInbox(now)).toEqual(first)

    const read = await updateCareInbox({ action: 'read-all' }, now)
    expect(read[0].readAt).toBe(now.toISOString())

    const overdue = await syncCareInbox(
      new Date(now.getTime() + 12 * 86_400_000),
    )
    expect(overdue).toHaveLength(1)
    expect(overdue[0]).toMatchObject({ level: 'overdue', readAt: null })

    const snoozed = await updateCareInbox(
      { action: 'snooze', ids: [overdue[0].id], days: 7 },
      now,
    )
    expect(snoozed[0].snoozedUntil).not.toBeNull()

    await storage.addMaintenanceEvent(bone, {
      type: 'sharpening',
      occurredAt: now.toISOString(),
    })
    const resolved = await syncCareInbox(now)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ resolution: 'logged' })
  })

  it('leaves the inbox untouched while reminders are off', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const bone = await createKnife('Bone')
    await storage.addMaintenanceEvent(bone, {
      type: 'cleaning',
      occurredAt: daysAgo(70),
    })
    saveSettings({
      maintenanceReminders: {
        ...DEFAULT_MAINTENANCE_REMINDERS,
        enabled: false,
      },
    })
    expect(await syncCareInbox(now)).toEqual([])
  })
})

describe('care inbox API route', () => {
  it('syncs on POST, updates on PATCH and drops messages with the knife', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const bone = await createKnife('Bone')
    await storage.addMaintenanceEvent(bone, {
      type: 'cleaning',
      occurredAt: '2020-01-01T12:00:00.000Z',
    })

    expect(
      await readNotifications(await inboxRoute.GET(jsonRequest('GET'))),
    ).toEqual([])

    const synced = await readNotifications(
      await inboxRoute.POST(jsonRequest('POST')),
    )
    expect(synced).toHaveLength(1)
    expect(synced[0]).toMatchObject({ track: 'cleaning', level: 'overdue' })

    const bad = await inboxRoute.PATCH(
      jsonRequest('PATCH', { action: 'snooze', ids: [synced[0].id], days: 0 }),
    )
    expect(bad.status).toBe(400)

    const dismissed = await readNotifications(
      await inboxRoute.PATCH(
        jsonRequest('PATCH', { action: 'dismiss', ids: [synced[0].id] }),
      ),
    )
    expect(dismissed[0].dismissedAt).not.toBeNull()

    await knifeRoute.DELETE(
      new Request(`http://localhost/api/knives/${bone}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: bone }) },
    )
    expect(
      await readNotifications(await inboxRoute.GET(jsonRequest('GET'))),
    ).toEqual([])
  })
})
