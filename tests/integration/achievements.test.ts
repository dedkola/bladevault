import { afterEach, describe, expect, it } from 'vitest'
import * as achievementsRoute from '@/app/api/achievements/route'
import * as knifeRoute from '@/app/api/knives/[id]/route'
import * as knivesRoute from '@/app/api/knives/route'
import { pendingCelebrations } from '@/lib/achievements/unlocks'
import { createBladeVaultMcpServer } from '@/lib/mcp/create-server'
import { getAchievementReport } from '@/lib/services/achievements-service'
import type {
  AchievementState,
  AchievementSyncResult,
} from '@/lib/achievements/unlocks'
import { getLocalDb, LOCAL_DB_SCHEMA_VERSION } from '@/lib/local-db'
import {
  getAchievementState,
  syncAchievements,
} from '@/lib/services/achievements-service'
import { getSettings, saveSettings } from '@/lib/settings'
import { getSystemMessages } from '@/lib/system-message-store'
import {
  DEFAULT_ACHIEVEMENTS,
  normalizeAchievementSettings,
} from '@/lib/settings-shared'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

function request(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/achievements', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function addKnives(count: number, start = 0): Promise<string[]> {
  const ids: string[] = []
  for (let index = start; index < start + count; index += 1) {
    const response = await knivesRoute.POST(
      new Request('http://localhost/api/knives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Knife ${index}`,
          brand: `Brand ${index % 4}`,
          specs: {},
        }),
      }),
    )
    expect(response.ok).toBe(true)
    ids.push(((await response.json()) as { knife: { id: string } }).knife.id)
  }
  return ids
}

const ids = (state: AchievementState) => state.unlocks.map((u) => u.id).sort()

describe('achievement storage', () => {
  it('creates the achievement tables in schema 12', async () => {
    vault = await createTempVault()
    expect(LOCAL_DB_SCHEMA_VERSION).toBeGreaterThanOrEqual(12)
    const tables = getLocalDb()
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'achievement_%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort()
    expect(tables).toEqual(['achievement_meta', 'achievement_unlocks'])
  })

  it('backfills an existing vault silently, then celebrates new unlocks', async () => {
    vault = await createTempVault()
    await addKnives(5)

    const first = await syncAchievements()
    expect(first.newlyUnlocked).toEqual([])
    expect(first.backfilledCount).toBeGreaterThanOrEqual(3)
    expect(ids(first)).toEqual(
      expect.arrayContaining(['first-blade', 'pocketful', 'brand-curious']),
    )
    expect(first.unlocks.every((u) => u.backfilled && u.seenAt)).toBe(true)
    expect(pendingCelebrations(first.unlocks)).toEqual([])

    const added = await addKnives(5, 5)
    const second = await syncAchievements()
    expect(second.backfilledCount).toBe(0)
    expect(second.newlyUnlocked.map((u) => u.id)).toEqual(['drawer-starter'])
    expect(second.newlyUnlocked[0]).toMatchObject({
      backfilled: false,
      seenAt: null,
    })
    // Credited to a knife from this batch (ties within a millisecond are fine).
    expect(added).toContain(second.newlyUnlocked[0].knifeId)
    expect(pendingCelebrations(second.unlocks).map((u) => u.id)).toEqual([
      'drawer-starter',
    ])

    const again = await syncAchievements()
    expect(again.newlyUnlocked).toEqual([])
    expect(again.unlocks).toEqual(second.unlocks)
  })

  it('celebrates the first knife when tracking starts on an empty vault', async () => {
    vault = await createTempVault()
    const empty = await syncAchievements()
    expect(empty.unlocks).toEqual([])
    expect(empty.backfilledCount).toBe(0)

    await addKnives(1)
    const first = await syncAchievements()
    expect(first.newlyUnlocked.map((u) => u.id)).toEqual(['first-blade'])
  })

  it('keeps unlocks after the knives behind them are deleted', async () => {
    vault = await createTempVault()
    await syncAchievements()
    const [knifeId] = await addKnives(1)
    await syncAchievements()

    const response = await knifeRoute.DELETE(
      new Request(`http://localhost/api/knives/${knifeId}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: knifeId }) },
    )
    expect(response.ok).toBe(true)

    const after = await syncAchievements()
    expect(ids(after)).toContain('first-blade')
    const progress = after.progress.find((p) => p.id === 'first-blade')
    expect(progress).toMatchObject({ current: 0, done: false })
  })

  it('reads price monitoring results for market badges', async () => {
    vault = await createTempVault()
    const [knifeId] = await addKnives(1)
    const db = getLocalDb()
    const at = new Date().toISOString()
    db.prepare(
      `INSERT INTO price_change_events
         (knife_id, source_id, direction, previous_price_minor, price_minor,
          currency, delta_minor, delta_pct, availability, from_snapshot_id,
          to_snapshot_id, source_url, store_name, extraction_method, occurred_at)
       VALUES (?, 1, 'drop', 10000, 6500, 'USD', -3500, -35, 'in_stock', 1, 2,
               'https://example.com', 'Example', 'json-ld', ?)`,
    ).run(knifeId, at)
    db.prepare(
      `INSERT INTO stock_events
         (knife_id, source_id, kind, previous_availability, availability,
          from_snapshot_id, to_snapshot_id, source_url, store_name, occurred_at)
       VALUES (?, 1, 'back_in_stock', 'out_of_stock', 'in_stock', 2, 3,
               'https://example.com', 'Example', ?)`,
    ).run(knifeId, at)

    const state = await syncAchievements()
    expect(ids(state)).toEqual(
      expect.arrayContaining(['deal-hunter', 'bargain-bin', 'restock-radar']),
    )
    expect(ids(state)).not.toContain('price-watcher')
  })
})

describe('achievements API', () => {
  it('syncs, marks unlocks seen and resets', async () => {
    vault = await createTempVault()
    await achievementsRoute.POST(request('POST'))
    await addKnives(1)

    const synced = (await (
      await achievementsRoute.POST(request('POST'))
    ).json()) as AchievementSyncResult
    expect(synced.newlyUnlocked.map((u) => u.id)).toEqual(['first-blade'])
    expect(synced.summary).toMatchObject({ unlockedCount: 1, score: 10 })

    const seen = await achievementsRoute.PATCH(
      request('PATCH', { action: 'seen', ids: ['first-blade'] }),
    )
    expect(seen.status).toBe(200)
    const seenState = (await seen.json()) as AchievementState
    expect(seenState.unlocks[0].seenAt).not.toBeNull()

    const read = (await (
      await achievementsRoute.GET(request('GET'))
    ).json()) as AchievementState
    expect(read.unlocks).toEqual(seenState.unlocks)
    expect(read.progress).toHaveLength(100)

    const reset = (await (
      await achievementsRoute.PATCH(request('PATCH', { action: 'reset' }))
    ).json()) as AchievementState
    expect(reset.unlocks).toEqual([])

    // After a reset the next sync backfills silently again.
    const resynced = await syncAchievements()
    expect(resynced.newlyUnlocked).toEqual([])
    expect(resynced.backfilledCount).toBeGreaterThan(0)
  })

  it('does not record unlocks on GET', async () => {
    vault = await createTempVault()
    await addKnives(1)
    const state = (await (
      await achievementsRoute.GET(request('GET'))
    ).json()) as AchievementState
    expect(state.unlocks).toEqual([])
    expect(state.progress.find((p) => p.id === 'first-blade')?.done).toBe(true)
  })

  it.each([
    [{ action: 'seen', ids: [] }],
    [{ action: 'seen', ids: ['not-a-badge'] }],
    [{ action: 'unlock', ids: ['first-blade'] }],
    [null],
  ])('rejects invalid actions: %j', async (body) => {
    vault = await createTempVault()
    const response = await achievementsRoute.PATCH(request('PATCH', body))
    expect(response.status).toBe(400)
  })
})

describe('achievement settings', () => {
  it('normalizes partial and invalid values', () => {
    expect(normalizeAchievementSettings(undefined)).toEqual(
      DEFAULT_ACHIEVEMENTS,
    )
    expect(
      normalizeAchievementSettings({ enabled: false, celebrate: 'yes' }),
    ).toEqual({ ...DEFAULT_ACHIEVEMENTS, enabled: false })
    expect(
      normalizeAchievementSettings(
        { inbox: false },
        { ...DEFAULT_ACHIEVEMENTS, showSecret: false },
      ),
    ).toEqual({ ...DEFAULT_ACHIEVEMENTS, inbox: false, showSecret: false })
  })

  it('persists the settings', async () => {
    vault = await createTempVault()
    expect(getSettings().achievements).toEqual(DEFAULT_ACHIEVEMENTS)
    saveSettings({
      achievements: { ...DEFAULT_ACHIEVEMENTS, celebrate: false },
    })
    expect(getSettings().achievements.celebrate).toBe(false)
    // Saving another setting keeps them.
    saveSettings({ pinnedItemsFirst: false })
    expect(getSettings().achievements.celebrate).toBe(false)
  })

  it('stops tracking while off and backfills quietly when back on', async () => {
    vault = await createTempVault()
    await syncAchievements()
    await addKnives(1)
    expect((await syncAchievements()).newlyUnlocked.map((u) => u.id)).toEqual([
      'first-blade',
    ])

    saveSettings({
      achievements: { ...DEFAULT_ACHIEVEMENTS, enabled: false },
    })
    await addKnives(4, 1)
    const off = await syncAchievements()
    expect(off).toMatchObject({
      enabled: false,
      progress: [],
      newlyUnlocked: [],
    })
    // Earned badges are kept while off.
    expect(ids(off)).toEqual(['first-blade'])
    expect((await getAchievementState()).enabled).toBe(false)

    saveSettings({ achievements: DEFAULT_ACHIEVEMENTS })
    const on = await syncAchievements()
    expect(on.enabled).toBe(true)
    expect(on.newlyUnlocked).toEqual([])
    expect(on.backfilledCount).toBeGreaterThan(0)
    expect(ids(on)).toContain('pocketful')
    const firstBlade = on.unlocks.find((u) => u.id === 'first-blade')
    expect(firstBlade).toMatchObject({ backfilled: false })

    // Tracking resumes normally afterwards.
    await addKnives(5, 5)
    expect((await syncAchievements()).newlyUnlocked.map((u) => u.id)).toEqual([
      'drawer-starter',
    ])
  })
})

describe('achievement Inbox messages', () => {
  it('adds one message per unlock and a summary for the backfill', async () => {
    vault = await createTempVault()
    await addKnives(2)
    await syncAchievements()
    const afterBackfill = await getSystemMessages()
    expect(afterBackfill).toHaveLength(1)
    expect(afterBackfill[0]).toMatchObject({
      kind: 'achievement',
      title: expect.stringMatching(/^Your vault already meets 1 achievement$/),
    })

    await addKnives(3, 2)
    await syncAchievements()
    await syncAchievements()
    const messages = await getSystemMessages()
    const unlock = messages.find((m) => m.key === 'unlock:pocketful')
    expect(unlock).toMatchObject({
      kind: 'achievement',
      title: 'Achievement unlocked: Pocketful',
      readAt: null,
    })
    expect(unlock?.detail).toMatch(/Unlocked with Brand \d Knife [2-4]$/)
    expect(messages.filter((m) => m.key === 'unlock:pocketful')).toHaveLength(1)
  })

  it('writes no messages while Inbox messages are off', async () => {
    vault = await createTempVault()
    saveSettings({ achievements: { ...DEFAULT_ACHIEVEMENTS, inbox: false } })
    await syncAchievements()
    await addKnives(1)
    const result = await syncAchievements()
    expect(result.newlyUnlocked.map((u) => u.id)).toEqual(['first-blade'])
    expect(await getSystemMessages()).toEqual([])
  })

  it('adds the message key column to existing system messages', async () => {
    vault = await createTempVault()
    const columns = getLocalDb()
      .prepare("SELECT name FROM pragma_table_info('system_messages')")
      .all()
      .map((row) => (row as { name: string }).name)
    expect(columns).toContain('dedupe_key')
  })
})

describe('achievements over MCP', () => {
  it('registers get_achievements as a read-only tool', () => {
    const server = createBladeVaultMcpServer('stdio') as unknown as {
      _registeredTools: Record<
        string,
        { annotations?: { readOnlyHint?: boolean } }
      >
    }
    expect(
      server._registeredTools.get_achievements?.annotations?.readOnlyHint,
    ).toBe(true)
  })

  it('reports rank, unlocks and progress without recording or spoiling secrets', async () => {
    vault = await createTempVault()
    await addKnives(3)
    expect((await getAchievementReport()).unlockedCount).toBe(0)

    await achievementsRoute.POST(request('POST'))
    const report = (await getAchievementReport()) as {
      rank: string
      unlockedCount: number
      hiddenSecretCount: number
      achievements: Array<{
        id: string
        unlocked: boolean
        secret: boolean
        progress: { text: string } | null
      }>
    }
    expect(report.rank).toBe('Rookie')
    expect(report.unlockedCount).toBeGreaterThan(0)
    expect(report.hiddenSecretCount).toBe(7)
    expect(report.achievements.some((a) => a.secret)).toBe(false)
    const firstBlade = report.achievements.find((a) => a.id === 'first-blade')
    expect(firstBlade).toMatchObject({ unlocked: true, progress: null })

    const locked = (await getAchievementReport({
      status: 'locked',
      category: 'size',
    })) as typeof report
    expect(locked.achievements.every((a) => !a.unlocked)).toBe(true)
    expect(locked.achievements[0]?.progress?.text).toMatch(/^3 \/ \d+$/)
  })

  it('says when achievements are off', async () => {
    vault = await createTempVault()
    await saveSettings({
      achievements: { ...getSettings().achievements, enabled: false },
    })
    expect(await getAchievementReport()).toMatchObject({ enabled: false })
  })
})
