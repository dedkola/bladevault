import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import { closeLocalDb, getLocalDb } from '@/lib/local-db'
import {
  ADVICE_UNFINISHED,
  finishAdvice,
  readAdvisorHistory,
  startAdvice,
} from '@/lib/price-monitor/advice-store'
import type { AdvisorInput } from '@/lib/price-monitor/advisor'
import { buildAgentSnapshot } from '@/lib/price-monitor/agent'
import { readAttentionRows } from '@/lib/price-monitor/attention'
import { writeLaneState } from '@/lib/price-monitor/store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { getSettings } from '@/lib/settings'
import { getVaultAccessState } from '@/lib/vault-access'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

// The AI advisor and supervisor: what they run on and how often.

let vault: TempVault | null = null

beforeEach(async () => {
  vault = await createTempVault()
})
afterEach(async () => {
  await getPriceMonitorWorker().stop()
  await vault?.cleanup()
  vault = null
})

const MIN = 60_000
const HOUR = 60 * MIN

async function createKnife(name: string, price = '$135') {
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Vosteed', name, specs: { price } }),
    }),
  )
  return ((await response.json()) as { knife: { id: string } }).knife.id
}

async function updateWatch(knifeId: string, body: Record<string, unknown>) {
  const response = await priceWatchRoute.PUT(
    new Request(`http://localhost/api/knives/${knifeId}/price-watch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: knifeId }) },
  )
  expect(response.status).toBe(200)
}

function sourceId(knifeId: string): number {
  return (
    getLocalDb()
      .prepare('SELECT id FROM price_sources WHERE knife_id = ?')
      .get(knifeId) as { id: number }
  ).id
}

const input: AdvisorInput = {
  now: new Date().toISOString(),
  timeZone: 'UTC',
  frequencyHours: 6,
  activeHours: null,
  statsDays: 7,
  stores: [],
}

describe('advisor runs', () => {
  it('records a run when it starts, so a slow call is not doubled', async () => {
    const { generation } = getVaultAccessState()
    const database = getLocalDb()
    expect(readAdvisorHistory(database)).toEqual({
      lastRunAt: null,
      failures: 0,
    })
    const startedAt = Date.parse('2026-11-21T16:47:29.325Z')
    const first = await startAdvice({
      generation,
      createdAt: new Date(startedAt).toISOString(),
      trigger: 'repeated_blocks',
      model: 'm',
      input,
    })
    // In flight (or the app quit mid-call): already the last run.
    expect(readAdvisorHistory(database)).toEqual({
      lastRunAt: startedAt,
      failures: 1,
    })
    await finishAdvice({
      generation,
      adviceId: first,
      error: 'The AI endpoint did not answer in time.',
    })
    const second = await startAdvice({
      generation,
      createdAt: new Date(startedAt + 6 * HOUR).toISOString(),
      trigger: 'repeated_blocks',
      model: 'm',
      input,
    })
    expect(readAdvisorHistory(database).failures).toBe(2)
    await finishAdvice({
      generation,
      adviceId: second,
      applied: {
        createdAt: new Date(startedAt + 6 * HOUR).toISOString(),
        expiresAt: new Date(startedAt + 54 * HOUR).toISOString(),
        lanes: [],
      },
    })
    expect(readAdvisorHistory(database)).toEqual({
      lastRunAt: startedAt + 6 * HOUR,
      failures: 0,
    })
    expect(
      database
        .prepare('SELECT id, error FROM price_regulator_advice ORDER BY id')
        .all(),
    ).toEqual([
      { id: first, error: 'The AI endpoint did not answer in time.' },
      { id: second, error: null },
    ])
    expect(ADVICE_UNFINISHED).toMatch(/did not finish/)
  })
})

describe('stores dropped from Other stores', () => {
  it('forgets their leftover searches and pacing, keeps found listings', async () => {
    const knifeId = await createKnife('Raccoon')
    const database = getLocalDb()
    const now = new Date().toISOString()
    database
      .prepare(
        `INSERT INTO price_discovery
           (knife_id, store, marketplace, status, attempts, last_attempt_at)
         VALUES (?, 'knifecenter', 'knifecenter.com', 'blocked', 3, ?),
                (?, 'knifecenter', 'knifecenter.co.uk', 'found', 1, ?),
                (?, 'bladehq', 'bladehq.com', 'not_found', 1, ?)`,
      )
      .run(knifeId, now, knifeId, now, knifeId, now)
    database
      .prepare(
        `INSERT INTO price_host_state
           (lane_key, min_gap_ms, ready_at, circuit, cooldown_until,
            open_count, updated_at)
         VALUES ('knifecenter.com', 60000, ?, 'open', ?, 3, ?),
                ('vosteed.com', 60000, ?, 'closed', NULL, 0, ?)`,
      )
      .run(now, now, now, now, now)

    closeLocalDb()
    const reopened = getLocalDb()
    const discovery = () =>
      reopened
        .prepare(
          'SELECT store, status FROM price_discovery ORDER BY store, status',
        )
        .all()
    expect(discovery()).toEqual([
      { store: 'bladehq', status: 'not_found' },
      { store: 'knifecenter', status: 'found' },
    ])
    const lanes = () =>
      reopened
        .prepare('SELECT lane_key FROM price_host_state ORDER BY lane_key')
        .all()
    expect(lanes()).toEqual([{ lane_key: 'vosteed.com' }])

    // A KnifeCenter page the user added by hand keeps its pacing.
    await updateWatch(knifeId, {
      add: [{ url: 'https://www.knifecenter.com/item/KZV1234/kizer' }],
    })
    getLocalDb()
      .prepare(
        `INSERT INTO price_host_state (lane_key, min_gap_ms, ready_at, updated_at)
         VALUES ('knifecenter.com', 60000, ?, ?)`,
      )
      .run(now, now)
    closeLocalDb()
    expect(
      getLocalDb()
        .prepare(
          "SELECT lane_key FROM price_host_state WHERE lane_key = 'knifecenter.com'",
        )
        .all(),
    ).toEqual([{ lane_key: 'knifecenter.com' }])
  })
})

describe('sources scheduled monitoring does not cover', () => {
  it('are left out of attention and are never due for the supervisor', async () => {
    const watched = await createKnife('Watched')
    const off = await createKnife('Off')
    await updateWatch(watched, {
      add: [{ url: 'https://shop.example/products/watched' }],
    })
    await updateWatch(off, {
      mode: 'off',
      add: [{ url: 'https://shop.example/products/off' }],
    })
    const database = getLocalDb()
    const earlier = new Date(Date.now() - 30 * HOUR).toISOString()
    database
      .prepare(
        `UPDATE price_sources
         SET status = 'failed', last_checked_at = ?, next_check_at = ?`,
      )
      .run(earlier, earlier)

    expect(readAttentionRows(database).map((row) => row.name)).toEqual([
      'Watched',
    ])

    const snapshot = buildAgentSnapshot({
      database,
      settings: getSettings().priceMonitoring,
      mode: 'act',
      now: Date.now(),
    })
    const byId = new Map(snapshot.sources.map((entry) => [entry.id, entry]))
    expect(byId.get(sourceId(off))).toMatchObject({
      monitored: false,
      dueInMin: null,
    })
    expect(byId.get(sourceId(watched))?.dueInMin).toBeLessThan(0)
    expect(snapshot.coverage).toMatchObject({ monitored: 1, dueNow: 1 })
  })

  it('shows the supervisor a retry that waits behind its store', async () => {
    const knifeId = await createKnife('Retry')
    await updateWatch(knifeId, {
      add: [{ url: 'https://shop.example/products/retry' }],
    })
    const database = getLocalDb()
    const now = Date.now()
    const id = sourceId(knifeId)
    // An earlier run asked for a retry with AI: queued, AI slot cleared.
    database
      .prepare(
        `UPDATE price_sources
         SET status = 'failed', priority = 1, last_ai_at = NULL,
             last_checked_at = ?, next_check_at = ?
         WHERE id = ?`,
      )
      .run(
        new Date(now - 2 * HOUR).toISOString(),
        new Date(now).toISOString(),
        id,
      )
    await writeLaneState(
      {
        laneKey: 'shop.example',
        minGapMs: 60_000,
        readyAt: now + 90 * MIN,
        circuit: 'closed',
        cooldownUntil: null,
        openCount: 0,
        successStreak: 0,
        failureStreak: 0,
        lastRequestAt: now - 30 * MIN,
      },
      getVaultAccessState().generation,
    )
    const snapshot = buildAgentSnapshot({
      database,
      settings: getSettings().priceMonitoring,
      mode: 'act',
      now,
    })
    expect(snapshot.sources.find((entry) => entry.id === id)).toMatchObject({
      queued: true,
      aiRetryPending: true,
      storeHoldMin: 90,
    })
    expect(
      snapshot.stores.find((store) => store.store === 'shop.example'),
    ).toMatchObject({ readyInMin: 90 })
  })
})
