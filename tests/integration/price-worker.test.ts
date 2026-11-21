import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as storesRoute from '@/app/api/prices/stores/route'
import { getLocalDb } from '@/lib/local-db'
import { recordAdvice } from '@/lib/price-monitor/advice-store'
import {
  browserStatePath,
  saveBrowserState,
} from '@/lib/price-monitor/browser-state'
import {
  nextDiscoveryKnife,
  type DiscoverySummary,
} from '@/lib/price-monitor/discovery'
import type { CheckSummary } from '@/lib/price-monitor/engine'
import { requestSourceChecks } from '@/lib/price-monitor/store'
import {
  buildQueueSnapshot,
  getPriceMonitorWorker,
  PriceMonitorWorker,
  type WorkerDeps,
} from '@/lib/price-monitor/worker'
import { getSettings, saveSettings } from '@/lib/settings'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'
import { getVaultAccessState } from '@/lib/vault-access'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const MIN = 60_000
let vault: TempVault | null = null
let workers: PriceMonitorWorker[] = []

beforeEach(async () => {
  vault = await createTempVault()
})
afterEach(async () => {
  // The stores route starts and wakes the process-wide worker. Stop it first so
  // its timers cannot take the lease the harness frees or run after cleanup.
  await getPriceMonitorWorker().stop()
  for (const worker of workers) await worker.stop()
  workers = []
  await vault?.cleanup()
  vault = null
})

function json(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let knifeCounter = 0
/** A knife whose product link and extra URLs become price sources. */
async function knife(
  urls: string[],
  options: { price?: string; sold?: boolean } = {},
) {
  knifeCounter += 1
  const response = await knivesRoute.POST(
    json('http://localhost/api/knives', 'POST', {
      name: `Knife ${knifeCounter}`,
      brand: 'Test',
      specs: { price: options.price ?? '100 USD' },
      sold: options.sold ?? false,
      sourceUrl: urls[0],
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  const params = { params: Promise.resolve({ id }) }
  await priceWatchRoute.GET(new Request('http://localhost/x'), params)
  if (urls.length > 1)
    await priceWatchRoute.PUT(
      json('http://localhost/x', 'PUT', {
        add: urls.slice(1).map((url) => ({ url })),
      }),
      params,
    )
  return id
}

function sourceIds(): Map<string, number> {
  return new Map(
    (
      getLocalDb()
        .prepare('SELECT id, url FROM price_sources WHERE removed_at IS NULL')
        .all() as Array<{ id: number; url: string }>
    ).map((row) => [row.url, row.id]),
  )
}

type Pending = {
  sourceId: number
  trigger: string
  resolve: (summary?: Partial<CheckSummary>) => void
}

/** A worker with a manual clock and checks that finish when told to. */
function harness(extra: Partial<WorkerDeps> = {}) {
  let now = Date.UTC(2026, 10, 18, 12)
  const pending: Pending[] = []
  const deps: WorkerDeps = {
    now: () => now,
    setTimer: () => null,
    clearTimer: () => {},
    random: () => 0,
    check: (sourceId, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener('abort', () =>
          resolve({ status: 'skipped', reason: 'missing' }),
        )
        pending.push({
          sourceId,
          trigger: options.trigger,
          resolve: (summary = {}) => {
            getLocalDb()
              .prepare(
                `UPDATE price_sources
                 SET priority = 0, status = 'ok', next_check_at = ?
                 WHERE id = ?`,
              )
              .run(
                new Date(now + (options.intervalMs ?? 0)).toISOString(),
                sourceId,
              )
            resolve({
              status: 'done',
              outcome: 'ok',
              detection: null,
              errorCode: null,
              laneOutcome: 'success',
              durationMs: 3000,
              retryAfterMs: null,
              ...summary,
            } as CheckSummary)
          },
        })
      }),
    ...extra,
  }
  const worker = new PriceMonitorWorker(deps)
  workers.push(worker)
  return {
    worker,
    pending,
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
    /** Finishes one running check and lets the worker settle. */
    async finish(index = 0, summary?: Partial<CheckSummary>) {
      const [check] = pending.splice(index, 1)
      check.resolve(summary)
      await new Promise((resolve) => setImmediate(resolve))
      await worker.pass()
    },
  }
}

const lanesOf = (pending: Pending[], ids: Map<string, number>) => {
  const byId = new Map([...ids].map(([url, id]) => [id, new URL(url).host]))
  return pending.map((check) => byId.get(check.sourceId)).sort()
}

describe('price monitor worker', () => {
  it('starts every store at once, but one check per store, no burst', async () => {
    await knife(['https://kizer.example/a', 'https://kizer.example/b'])
    await knife(['https://vosteed.com/a', 'https://vosteed.com/b'])
    await knife(['https://knives.example/a', 'https://knives.example/b'])
    await knife(['https://bladehq.com/a'])
    const ids = sourceIds()
    const { worker, pending, finish } = harness()
    worker.start({ scheduled: true })
    await worker.pass()

    expect(lanesOf(pending, ids)).toEqual([
      'bladehq.com',
      'kizer.example',
      'knives.example',
      'vosteed.com',
    ])

    // A finished store waits for its gap instead of starting its next product.
    const firstHost = lanesOf([pending[0]], ids)[0]
    await finish(0)
    expect(pending).toHaveLength(3)
    expect(lanesOf(pending, ids)).not.toContain(firstHost)
  })

  it('spreads a store over the day and records its pace', async () => {
    await knife([
      'https://kizer.example/a',
      'https://kizer.example/b',
      'https://kizer.example/c',
    ])
    const { worker, pending, finish, advance } = harness()
    const gap = () => {
      const lane = getLocalDb()
        .prepare(
          "SELECT ready_at, last_request_at FROM price_host_state WHERE lane_key = 'kizer.example'",
        )
        .get() as { ready_at: string; last_request_at: string }
      return Date.parse(lane.ready_at) - Date.parse(lane.last_request_at)
    }
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending).toHaveLength(1)
    await finish()
    expect(pending).toHaveLength(0)

    // Never-checked products get their first price at the minimum gap.
    expect(gap()).toBe(MIN)
    advance(MIN)
    await worker.pass()
    expect(pending).toHaveLength(1)
    await finish()
    expect(gap()).toBe(MIN)
    advance(MIN)
    await worker.pass()
    expect(pending).toHaveLength(1)
    await finish()

    // Then the store is spread: 24 h × 0.8 / 3 = 6.4 h, capped at 2 h.
    expect(gap()).toBe(2 * 60 * MIN)
  })

  it('spreads a store over the day once every product was checked', async () => {
    await knife(['https://kizer.example/a', 'https://kizer.example/b'])
    // Both products already have a reading; one is due again.
    getLocalDb()
      .prepare(
        "UPDATE price_sources SET priority = 0, last_checked_at = '2026-11-17T12:00:00.000Z'",
      )
      .run()
    const { worker, pending, finish, advance } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending).toHaveLength(1)
    await finish()
    advance(119 * MIN)
    await worker.pass()
    expect(pending).toHaveLength(0)
    advance(2 * MIN)
    await worker.pass()
    expect(pending).toHaveLength(1)
  })

  it('pauses a store after a bot check and probes after the cooldown', async () => {
    await knife(['https://shop.example/a', 'https://shop.example/b'])
    const { worker, pending, finish, advance } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    await finish(0, { outcome: 'blocked', laneOutcome: 'blocked' })
    expect(pending).toHaveLength(0)
    const snapshot = buildQueueSnapshot(Date.UTC(2026, 10, 18, 12, 1))
    expect(snapshot.lanes[0]).toMatchObject({
      laneKey: 'shop.example',
      circuit: 'open',
    })
    advance(29 * MIN)
    await worker.pass()
    expect(pending).toHaveLength(0)
    advance(2 * MIN)
    await worker.pass()
    expect(pending.map((check) => check.trigger)).toEqual(['probe'])
  })

  it('only runs Check now when scheduling is off or not covered', async () => {
    await knife(['https://a.example/p'])
    await knife(['https://b.example/p'], { price: '' })
    await knife(['https://c.example/p'], { sold: true })
    const ids = sourceIds()
    saveSettings({
      priceMonitoring: {
        ...(await import('@/lib/settings')).getSettings().priceMonitoring,
        enabled: false,
      },
    })
    const { worker, pending } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending).toHaveLength(0)

    await requestSourceChecks([ids.get('https://b.example/p')!])
    await worker.pass()
    expect(pending.map((check) => [check.sourceId, check.trigger])).toEqual([
      [ids.get('https://b.example/p'), 'manual'],
    ])

    // Back on: the no-price and sold knives stay out of the schedule.
    saveSettings({
      priceMonitoring: {
        ...(await import('@/lib/settings')).getSettings().priceMonitoring,
        enabled: true,
      },
    })
    await worker.pass()
    expect(pending.map((check) => check.sourceId).sort()).toEqual(
      [ids.get('https://a.example/p'), ids.get('https://b.example/p')].sort(),
    )
  })

  it('lets only one worker per vault run checks', async () => {
    await knife(['https://a.example/p'])
    const first = harness()
    const second = harness()
    first.worker.start({ scheduled: true })
    second.worker.start({ scheduled: true })
    await first.worker.pass()
    await second.worker.pass()
    expect(first.pending).toHaveLength(1)
    expect(second.pending).toHaveLength(0)
  })

  it('holds stores in advised quiet hours or pauses; Check now still runs', async () => {
    await knife(['https://a.example/p'])
    await knife(['https://b.example/p'])
    await knife(['https://c.example/p'])
    const ids = sourceIds()
    const { worker, pending, now } = harness()
    const hour = new Date(now()).getHours()
    const createdAt = new Date(now()).toISOString()
    const expiresAt = new Date(now() + 48 * 60 * MIN).toISOString()
    const lane = {
      minGapMs: null,
      pauseUntil: null,
      quietHours: null,
      strategy: null,
      reason: 'test',
      adjustments: [],
    }
    await recordAdvice({
      generation: getVaultAccessState().generation,
      createdAt,
      trigger: 'manual',
      model: 'm',
      input: {
        now: createdAt,
        timeZone: 'UTC',
        frequencyHours: 24,
        activeHours: null,
        statsDays: 7,
        stores: [],
      },
      applied: {
        createdAt,
        expiresAt,
        lanes: [
          {
            ...lane,
            laneKey: 'a.example',
            quietHours: [hour, (hour + 2) % 24],
          },
          {
            ...lane,
            laneKey: 'b.example',
            pauseUntil: new Date(now() + 60 * MIN).toISOString(),
          },
        ],
      },
    })
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://c.example/p'),
    ])

    await requestSourceChecks([ids.get('https://a.example/p')!])
    await worker.pass()
    expect(pending.map((check) => [check.sourceId, check.trigger])).toEqual([
      [ids.get('https://c.example/p'), 'scheduled'],
      [ids.get('https://a.example/p'), 'manual'],
    ])
  })

  it('asks the AI advisor once it is due, only with AI on', async () => {
    await knife(['https://a.example/p'])
    const advise = vi.fn<NonNullable<WorkerDeps['advise']>>(async () => ({
      status: 'skipped' as const,
      reason: 'no_data' as const,
    }))
    const off = harness({ advise })
    off.worker.start({ scheduled: true })
    await off.worker.pass()
    await new Promise((resolve) => setImmediate(resolve))
    expect(advise).not.toHaveBeenCalled()
    await off.worker.stop()

    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        ai: {
          enabled: true,
          baseUrl: 'http://localhost:11434/v1',
          model: 'm',
          headers: {},
          extractionFallback: true,
          advisor: true,
          resolveErrors: true,
          vision: false,
          confirmChanges: true,
          spotCheck: true,
          dailyDigest: false,
          maxPageKb: 200,
          maxAnswerTokens: 16_384,
          usage: DEFAULT_PRICE_MONITORING.ai.usage,
          agentMode: 'off',
        },
      },
    })
    const on = harness({ advise })
    on.worker.start({ scheduled: true })
    await on.worker.pass()
    await new Promise((resolve) => setImmediate(resolve))
    expect(advise).toHaveBeenCalledTimes(1)
    expect(advise).toHaveBeenCalledWith('daily')
    // Checked again only every 10 minutes.
    await on.worker.pass()
    await new Promise((resolve) => setImmediate(resolve))
    expect(advise).toHaveBeenCalledTimes(1)
  })

  it('wakes the AI supervisor for changes, otherwise on its heartbeat', async () => {
    const id = await knife(['https://a.example/p'])
    const supervise = vi.fn<NonNullable<WorkerDeps['supervise']>>(async () => ({
      status: 'skipped' as const,
      reason: 'busy' as const,
    }))
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        ai: {
          ...DEFAULT_PRICE_MONITORING.ai,
          enabled: true,
          baseUrl: 'http://localhost:11434/v1',
          model: 'm',
          agentMode: 'act',
          usage: { ...DEFAULT_PRICE_MONITORING.ai.usage, mode: 'unlimited' },
        },
      },
    })
    const test = harness({ supervise })
    const ago = (minutes: number) =>
      new Date(test.now() - minutes * 60_000).toISOString()
    getLocalDb()
      .prepare(
        `INSERT INTO price_agent_runs
           (started_at, trigger, mode, model, duration_ms, ok, actions)
         VALUES (?, 'scheduled', 'act', 'm', 1000, 1, '[]')`,
      )
      .run(ago(30))
    const settle = async () => {
      await test.worker.pass()
      await new Promise((resolve) => setImmediate(resolve))
    }
    test.worker.start({ scheduled: true })
    await settle()
    // 30 minutes after the last run, nothing changed: the hourly beat waits.
    expect(supervise).not.toHaveBeenCalled()

    const [sourceId] = sourceIds().values()
    getLocalDb()
      .prepare(
        `INSERT INTO price_change_events
           (knife_id, source_id, direction, previous_price_minor,
            price_minor, currency, delta_minor, delta_pct, availability,
            from_snapshot_id, to_snapshot_id, source_url, store_name,
            extraction_method, occurred_at)
         VALUES (?, ?, 'drop', 10000, 9000, 'USD', -1000, -10, 'in_stock',
                 1, 2, 'https://a.example/p', 'A', 'json_ld', ?)`,
      )
      .run(id, sourceId, ago(0))
    // The drop is a minute old: it waits for the batch to fill.
    test.advance(60_000)
    await settle()
    expect(supervise).not.toHaveBeenCalled()
    test.advance(60_000)
    await settle()
    expect(supervise).toHaveBeenCalledWith('event')
  })

  it('searches other stores on a store’s lane only when it is free', async () => {
    await knife(['https://www.bladehq.com/item--Other-Knife--2'])
    const lookFor = await knife([])
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        ai: {
          ...DEFAULT_PRICE_MONITORING.ai,
          enabled: true,
          baseUrl: 'http://localhost:11434/v1',
          model: 'test-model',
        },
        otherStores: {
          enabled: true,
          stores: { bladehq: true },
        },
      },
    })
    let finishSearch: (summary: DiscoverySummary) => void = () => {}
    const discover = vi.fn(
      (_knifeId: string, options: { signal: AbortSignal }) =>
        new Promise<DiscoverySummary>((resolve) => {
          finishSearch = resolve
          options.signal.addEventListener('abort', () =>
            resolve({ status: 'skipped', reason: 'missing' }),
          )
        }),
    )
    const { worker, pending, finish, advance, now } = harness({
      nextDiscovery: nextDiscoveryKnife,
      discover,
    })
    worker.start({ scheduled: true })
    await worker.pass()
    // The due Blade HQ check goes first; the search waits for the lane.
    expect(pending).toHaveLength(1)
    expect(discover).not.toHaveBeenCalled()
    await finish()
    expect(discover).not.toHaveBeenCalled()

    advance(2 * 60 * MIN + MIN)
    await worker.pass()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(discover.mock.calls[0]).toEqual([
      lookFor,
      { signal: expect.any(AbortSignal), store: 'bladehq' },
    ])
    // The search holds the Blade HQ lane like a check would.
    expect(worker.discovering).not.toBeNull()
    await requestSourceChecks([...sourceIds().values()])
    await worker.pass()
    expect(pending).toHaveLength(0)

    finishSearch({
      status: 'done',
      result: 'not_found',
      laneOutcome: 'success',
      aiProblem: false,
      durationMs: 4000,
      retryAfterMs: null,
      sourceId: null,
    })
    await worker.idle()
    const lane = getLocalDb()
      .prepare(
        "SELECT last_request_at FROM price_host_state WHERE lane_key = 'bladehq.com'",
      )
      .get() as { last_request_at: string }
    expect(Date.parse(lane.last_request_at)).toBe(now())
  })

  it('searches a store with one source within minutes, not at its check spread', async () => {
    await knife(['https://www.bladehq.com/item--Test-Knife--1'])
    const lookFor = await knife([])
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        ai: {
          ...DEFAULT_PRICE_MONITORING.ai,
          enabled: true,
          baseUrl: 'http://localhost:11434/v1',
          model: 'test-model',
        },
        otherStores: {
          enabled: true,
          stores: { bladehq: true },
        },
      },
    })
    const discover = vi.fn(async (): Promise<DiscoverySummary> => ({
      status: 'done',
      result: 'not_found',
      laneOutcome: 'success',
      aiProblem: false,
      durationMs: 4000,
      retryAfterMs: null,
      sourceId: null,
    }))
    const { worker, pending, finish, advance, now } = harness({
      nextDiscovery: (_settings, _now, store) =>
        store === 'bladehq' ? lookFor : null,
      discover,
    })
    // The AI advisor paused Blade HQ for half an hour: searches wait too.
    const createdAt = new Date(now()).toISOString()
    await recordAdvice({
      generation: getVaultAccessState().generation,
      createdAt,
      trigger: 'manual',
      model: 'm',
      input: {
        now: createdAt,
        timeZone: 'UTC',
        frequencyHours: 24,
        activeHours: null,
        statsDays: 7,
        stores: [],
      },
      applied: {
        createdAt,
        expiresAt: new Date(now() + 48 * 60 * MIN).toISOString(),
        lanes: [
          {
            laneKey: 'bladehq.com',
            minGapMs: null,
            pauseUntil: new Date(now() + 30 * MIN).toISOString(),
            quietHours: null,
            strategy: null,
            reason: 'test',
            adjustments: [],
          },
        ],
      },
    })
    // Manual checks still run in a pause; its one source is checked now.
    await requestSourceChecks([...sourceIds().values()])
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending).toHaveLength(1)
    await finish()
    const spreadReadyAt = Date.parse(
      (
        getLocalDb()
          .prepare(
            "SELECT ready_at FROM price_host_state WHERE lane_key = 'bladehq.com'",
          )
          .get() as { ready_at: string }
      ).ready_at,
    )
    // One source a day: its next check waits the two-hour spread cap.
    expect(spreadReadyAt - now()).toBeGreaterThanOrEqual(2 * 60 * MIN)

    advance(6 * MIN)
    await worker.pass()
    expect(discover).not.toHaveBeenCalled()

    advance(25 * MIN)
    await worker.pass()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(discover.mock.calls[0]).toEqual([
      lookFor,
      { signal: expect.any(AbortSignal), store: 'bladehq' },
    ])
    await worker.idle()
    const lane = getLocalDb()
      .prepare(
        "SELECT ready_at, last_request_at FROM price_host_state WHERE lane_key = 'bladehq.com'",
      )
      .get() as { ready_at: string; last_request_at: string }
    expect(Date.parse(lane.last_request_at)).toBe(now())
    // The search does not bring the next scheduled check forward.
    expect(Date.parse(lane.ready_at)).toBe(spreadReadyAt)

    // The next search follows the store's minimum gap of five minutes.
    advance(4 * MIN)
    await worker.pass()
    expect(discover).toHaveBeenCalledTimes(1)
    advance(2 * MIN)
    await worker.pass()
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('probes a paused store with a search once its cooldown is over', async () => {
    const lookFor = await knife([])
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        ai: {
          ...DEFAULT_PRICE_MONITORING.ai,
          enabled: true,
          baseUrl: 'http://localhost:11434/v1',
          model: 'test-model',
        },
        otherStores: {
          enabled: true,
          stores: { bladehq: true },
        },
      },
    })
    const discover = vi.fn(async (): Promise<DiscoverySummary> => ({
      status: 'done',
      result: 'not_found',
      laneOutcome: 'success',
      aiProblem: false,
      durationMs: 4000,
      retryAfterMs: null,
      sourceId: null,
    }))
    const { worker, now } = harness({
      nextDiscovery: nextDiscoveryKnife,
      discover,
    })
    // Blade HQ has no price sources: only a search can probe it.
    const ended = new Date(now() - MIN).toISOString()
    getLocalDb()
      .prepare(
        `INSERT INTO price_host_state
           (lane_key, min_gap_ms, ready_at, circuit, cooldown_until,
            open_count, updated_at)
         VALUES ('bladehq.com', 60000, ?, 'open', ?, 1, ?)`,
      )
      .run(ended, ended, ended)
    worker.start({ scheduled: true })
    await worker.pass()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(discover.mock.calls[0]).toEqual([
      lookFor,
      { signal: expect.any(AbortSignal), store: 'bladehq' },
    ])
    await worker.idle()
    const lane = getLocalDb()
      .prepare(
        "SELECT circuit FROM price_host_state WHERE lane_key = 'bladehq.com'",
      )
      .get() as { circuit: string }
    expect(lane.circuit).toBe('closed')
  })
})

async function storeAction(laneKey: string, action: string) {
  const response = await storesRoute.POST(
    json('http://localhost/api/prices/stores', 'POST', { laneKey, action }),
  )
  return {
    status: response.status,
    body: (await response.json()) as { queued?: number; error?: string },
  }
}

describe('store actions', () => {
  it('pauses a whole store; Check this store now still runs it', async () => {
    await knife(['https://shop.example/a', 'https://shop.example/b'])
    await knife(['https://other.example/c'])
    const ids = sourceIds()
    expect((await storeAction('shop.example', 'pause')).status).toBe(200)
    const { worker, pending, finish } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['other.example'])
    await finish()

    // A paused store stays listed with its products, so it can be resumed.
    const lane = buildQueueSnapshot().lanes.find(
      (entry) => entry.laneKey === 'shop.example',
    )
    expect(lane).toMatchObject({ paused: true, sources: 2 })

    const checked = await storeAction('shop.example', 'check')
    expect(checked).toMatchObject({ status: 200, body: { queued: 2 } })
    await worker.pass()
    expect(pending.map((check) => check.trigger)).toEqual(['manual'])
    await finish()

    expect((await storeAction('shop.example', 'unpause')).status).toBe(200)
    expect(
      buildQueueSnapshot().lanes.find(
        (entry) => entry.laneKey === 'shop.example',
      )?.paused,
    ).toBe(false)
  })

  it('resumes a blocked store now and resets its saved cookies', async () => {
    await knife(['https://shop.example/a', 'https://shop.example/b'])
    const { worker, pending, finish, now, advance } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    await finish(0, { outcome: 'blocked', laneOutcome: 'blocked' })
    expect(buildQueueSnapshot(now()).lanes[0].circuit).toBe('open')

    expect((await storeAction('shop.example', 'resume')).status).toBe(200)
    // The route uses the real clock; move the worker's clock up to it.
    advance(Date.now() - now() + 1000)
    await worker.pass()
    // A normal scheduled check, not a probe: the cooldown is over.
    expect(pending.map((check) => check.trigger)).toEqual(['scheduled'])
    const openCount = (
      getLocalDb()
        .prepare(
          "SELECT open_count FROM price_host_state WHERE lane_key = 'shop.example'",
        )
        .get() as { open_count: number }
    ).open_count
    expect(openCount).toBe(1)

    await saveBrowserState('shop.example', { cookies: [], origins: [] })
    expect(fs.existsSync(browserStatePath('shop.example'))).toBe(true)
    expect((await storeAction('shop.example', 'reset_cookies')).status).toBe(
      200,
    )
    expect(fs.existsSync(browserStatePath('shop.example'))).toBe(false)
  })

  it('rejects unknown stores and actions', async () => {
    expect((await storeAction('nowhere.example', 'pause')).status).toBe(404)
    expect((await storeAction('nowhere.example', 'explode')).status).toBe(400)
  })
})

describe('queue snapshot', () => {
  it('reports waiting checks and Check all progress', async () => {
    await knife(['https://shop.example/a', 'https://shop.example/b'])
    const start = new Date().toISOString()
    let snapshot = buildQueueSnapshot(Date.now(), { since: start })
    expect(snapshot).toMatchObject({ waiting: 2, checkedSince: 0 })
    getLocalDb()
      .prepare(
        `UPDATE price_sources SET last_checked_at = ?, priority = 0,
           next_check_at = ? WHERE url = 'https://shop.example/a'`,
      )
      .run(
        new Date(Date.parse(start) + 1000).toISOString(),
        new Date(Date.now() + 60 * MIN).toISOString(),
      )
    snapshot = buildQueueSnapshot(Date.now(), { since: start })
    expect(snapshot).toMatchObject({ waiting: 1, checkedSince: 1 })
    expect(buildQueueSnapshot().checkedSince).toBeNull()
  })

  it('counts pages out of stock for two weeks as slowed and spreads the rest', async () => {
    await knife([
      'https://shop.example/a',
      'https://shop.example/b',
      'https://shop.example/c',
      'https://shop.example/d',
    ])
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        schedule: {
          ...DEFAULT_PRICE_MONITORING.schedule,
          mode: 'custom',
          intervalHours: 6,
        },
      },
    })
    const gapBefore = buildQueueSnapshot().lanes[0].gapMs
    const ids = sourceIds()
    const longAgo = new Date(Date.now() - 20 * 24 * 60 * MIN).toISOString()
    for (const url of ['https://shop.example/a', 'https://shop.example/b']) {
      const id = ids.get(url)!
      const row = getLocalDb()
        .prepare('SELECT knife_id FROM price_sources WHERE id = ?')
        .get(id) as { knife_id: string }
      getLocalDb()
        .prepare(
          `INSERT INTO price_snapshots
             (knife_id, source_id, availability, extraction_status,
              extraction_method, observed_at, last_seen_at)
           VALUES (?, ?, 'out_of_stock', 'no_price', 'jsonld', ?, ?)`,
        )
        .run(row.knife_id, id, longAgo, new Date().toISOString())
      getLocalDb()
        .prepare(
          "UPDATE price_sources SET last_availability = 'out_of_stock' WHERE id = ?",
        )
        .run(id)
    }
    const lane = buildQueueSnapshot().lanes[0]
    expect(lane).toMatchObject({ sources: 4, slowed: 2 })
    // 6 h × 0.8 over 2.5 checks instead of 4.
    expect(gapBefore).toBe((6 * 60 * MIN * 0.8) / 4)
    expect(lane.gapMs).toBe((6 * 60 * MIN * 0.8) / 2.5)
  })
})
