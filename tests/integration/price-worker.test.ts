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
import type { DiscoverySummary } from '@/lib/price-monitor/discovery'
import type { CheckSummary } from '@/lib/price-monitor/engine'
import { DISCOVERY_STORES } from '@/lib/price-monitor/discovery-stores'
import { readRetryTasks } from '@/lib/price-monitor/round-store'
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
import { monitorWholeCollection } from '@/tests/helpers/monitor-whole-collection'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const MIN = 60_000
let vault: TempVault | null = null
let workers: PriceMonitorWorker[] = []

beforeEach(async () => {
  vault = await createTempVault()
  monitorWholeCollection()
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
                 SET priority = 0, status = 'ok', next_check_at = ?,
                     last_checked_at = ?
                 WHERE id = ?`,
              )
              .run(
                new Date(now + (options.intervalMs ?? 0)).toISOString(),
                new Date(now).toISOString(),
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

const HOUR = 60 * MIN

/** Every link was read yesterday: rounds check them, not first readings. */
function checkedYesterday(now = Date.UTC(2026, 10, 18, 12)) {
  getLocalDb()
    .prepare(
      `UPDATE price_sources SET priority = 0, last_checked_at = ?,
         next_check_at = NULL`,
    )
    .run(new Date(now - 24 * HOUR).toISOString())
}

function roundEvery(intervalHours: 6 | 12 | 24) {
  saveSettings({
    priceMonitoring: {
      ...getSettings().priceMonitoring,
      schedule: { ...getSettings().priceMonitoring.schedule, intervalHours },
    },
  })
}

function otherStores(stores: Partial<Record<string, boolean>>) {
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
        stores: {
          bladehq: false,
          smkw: false,
          dlttrading: false,
          knifejoy: false,
          northwestknives: false,
          amazon: false,
          ...stores,
        },
      },
    },
  })
}

const notFound: DiscoverySummary = {
  status: 'done',
  result: 'not_found',
  laneOutcome: 'success',
  aiProblem: false,
  durationMs: 4000,
  retryAfterMs: null,
  sourceId: null,
}

/**
 * Searches that finish when told to. With a clock, a finished search is
 * saved like a real one, so the knife is not due there for a day.
 */
function searches(clock?: () => number) {
  const calls: Array<{
    knifeId: string
    store: string
    resolve: (summary: DiscoverySummary) => void
  }> = []
  const save = (knifeId: string, store: string) => {
    if (!clock) return
    const at = clock()
    getLocalDb()
      .prepare(
        `INSERT OR REPLACE INTO price_discovery
           (knife_id, store, marketplace, status, attempts, last_attempt_at,
            next_attempt_at)
         VALUES (?, ?, ?, 'not_found', 1, ?, ?)`,
      )
      .run(
        knifeId,
        store,
        DISCOVERY_STORES[store as keyof typeof DISCOVERY_STORES].marketplace,
        new Date(at).toISOString(),
        new Date(at + 24 * HOUR).toISOString(),
      )
  }
  const discover = vi.fn(
    (knifeId: string, options: { signal: AbortSignal; store: string }) =>
      new Promise<DiscoverySummary>((resolve) => {
        calls.push({
          knifeId,
          store: options.store,
          resolve: (summary) => {
            save(knifeId, options.store)
            resolve(summary)
          },
        })
        options.signal.addEventListener('abort', () =>
          resolve({ status: 'skipped', reason: 'missing' }),
        )
      }),
  )
  return { calls, discover }
}

const retryKeys = () =>
  readRetryTasks(getLocalDb())
    .map((task) => `${task.key}:${task.reason}`)
    .sort()

/** The AI supervisor watches a knife closely, checked every `everyMs`. */
function watchClosely(knifeId: string, everyMs: number, now: number) {
  getLocalDb()
    .prepare(
      `INSERT INTO price_watch
         (knife_id, mode, updated_at, focus_until, focus_interval_ms,
          focus_reason)
       VALUES (?, 'auto', ?, ?, ?, 'test')
       ON CONFLICT(knife_id) DO UPDATE SET
         focus_until = excluded.focus_until,
         focus_interval_ms = excluded.focus_interval_ms`,
    )
    .run(
      knifeId,
      new Date(now).toISOString(),
      new Date(now + 72 * HOUR).toISOString(),
      everyMs,
    )
}

/** AI advice pauses a store until `until`. */
async function pauseStore(laneKey: string, until: number, now: number) {
  const createdAt = new Date(now).toISOString()
  await recordAdvice({
    generation: getVaultAccessState().generation,
    createdAt,
    trigger: 'manual',
    model: 'm',
    input: {
      now: createdAt,
      timeZone: 'UTC',
      frequencyHours: 24,
      statsDays: 7,
      stores: [],
    },
    applied: {
      createdAt,
      expiresAt: new Date(now + 48 * HOUR).toISOString(),
      lanes: [
        {
          laneKey,
          minGapMs: null,
          pauseUntil: new Date(until).toISOString(),
          quietHours: null,
          strategy: null,
          reason: 'test',
          adjustments: [],
        },
      ],
    },
  })
}

const nextCheckAt = (sourceId: number) =>
  (
    getLocalDb()
      .prepare('SELECT next_check_at FROM price_sources WHERE id = ?')
      .get(sourceId) as { next_check_at: string | null }
  ).next_check_at

function wishlistWithCollectionPass(wishlist: string[]) {
  const at = new Date(Date.UTC(2026, 10, 1)).toISOString()
  const insert = getLocalDb().prepare(
    `INSERT INTO wishlist_items (knife_id, lane, position, added_at, updated_at)
     VALUES (?, 'next', ?, ?, ?)`,
  )
  wishlist.forEach((id, index) => insert.run(id, index, at, at))
  saveSettings({
    priceMonitoring: {
      ...getSettings().priceMonitoring,
      scope: { kind: 'wishlist', knifeIds: [] },
      collectionPass: { enabled: true, superSalePercent: 50 },
    },
  })
}

describe('store queues', () => {
  it('checks every store at the same time, each at its own pace', async () => {
    await knife(['https://a.example/1', 'https://b.example/1'])
    await knife(['https://a.example/2', 'https://c.example/2'])
    await knife(['https://b.example/3'])
    checkedYesterday()
    roundEvery(6)
    const ids = sourceIds()
    const { worker, pending, finish, advance, now } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    // One check per store, all stores at once.
    expect(lanesOf(pending, ids)).toEqual([
      'a.example',
      'b.example',
      'c.example',
    ])
    expect(pending.map((check) => check.trigger)).toEqual([
      'scheduled',
      'scheduled',
      'scheduled',
    ])
    expect(buildQueueSnapshot(now())).toMatchObject({ backlog: 5 })
    await finish()
    await finish()
    await finish()

    // Each store waits its own gap (1 minute) before its next link.
    advance(MIN - 1000)
    await worker.pass()
    expect(pending).toHaveLength(0)
    advance(1000)
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['a.example', 'b.example'])
    await finish()
    await finish()
    advance(MIN)
    await worker.pass()
    expect(pending).toHaveLength(0)
    expect(buildQueueSnapshot(now())).toMatchObject({ backlog: 0 })

    // Every link comes back one interval after its check.
    const first = ids.get('https://c.example/2')!
    expect(Date.parse(nextCheckAt(first)!)).toBe(now() - 2 * MIN + 6 * HOUR)
  })

  it('never lets a slow store hold up a fast one', async () => {
    await knife(['https://fast.example/1', 'https://slow.example/1'])
    await knife(['https://fast.example/2', 'https://slow.example/2'])
    checkedYesterday()
    const ids = sourceIds()
    const { worker, pending, finish, advance, now } = harness()
    const start = now()
    await pauseStore('slow.example', start + HOUR, start)
    worker.start({ scheduled: true })
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['fast.example'])
    await finish()
    advance(MIN)
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['fast.example'])
    await finish()

    // The paused store keeps its links due and runs them when it is ready.
    advance(start + HOUR - now())
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['slow.example'])
    expect(retryKeys()).toEqual([])
  })

  it('gives watched knives at most one check in three while others wait', async () => {
    const watchedA = await knife(['https://shop.example/w1'])
    await knife(['https://shop.example/r1'])
    await knife(['https://shop.example/r2'])
    const watchedB = await knife(['https://shop.example/w2'])
    await knife(['https://shop.example/r3'])
    checkedYesterday()
    const ids = sourceIds()
    const urlOf = new Map([...ids].map(([url, id]) => [id, url]))
    const { worker, pending, finish, advance, now } = harness()
    watchClosely(watchedA, 3 * HOUR, now())
    watchClosely(watchedB, 3 * HOUR, now())
    worker.start({ scheduled: true })
    const order: string[] = []
    for (let pick = 0; pick < 5; pick += 1) {
      await worker.pass()
      order.push(...pending.map((check) => urlOf.get(check.sourceId)!))
      await finish()
      advance(MIN)
    }
    expect(order.map((url) => url.split('/').at(-1))).toEqual([
      'w1',
      'r1',
      'r2',
      'w2',
      'r3',
    ])
  })

  it('checks What to monitor first at each store, the rest of the collection at most once a day', async () => {
    const wished = await knife(['https://shop.example/1'])
    await knife(['https://shop.example/2'])
    checkedYesterday()
    roundEvery(6)
    wishlistWithCollectionPass([wished])
    const ids = sourceIds()
    const { worker, pending, finish, advance, now } = harness()
    const start = now()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://shop.example/1'),
    ])
    await finish()
    advance(MIN)
    await worker.pass()
    expect(pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://shop.example/2'),
    ])
    expect(buildQueueSnapshot(now()).collectionPass).toEqual({
      knives: 1,
      done: 0,
    })
    await finish()
    expect(buildQueueSnapshot(now()).collectionPass).toEqual({
      knives: 1,
      done: 1,
    })

    // 6 hours on, only the Wishlist link is due again; the rest waits a day.
    advance(start + 6 * HOUR + MIN - now())
    await worker.pass()
    expect(pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://shop.example/1'),
    ])
    await finish()
    expect(Date.parse(nextCheckAt(ids.get('https://shop.example/2')!)!)).toBe(
      start + MIN + 24 * HOUR,
    )

    // Switched off: no collection status.
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        collectionPass: { enabled: false, superSalePercent: 50 },
      },
    })
    expect(buildQueueSnapshot(now()).collectionPass).toBeNull()
  })

  it('makes every link due with Check all now, also where checks are not scheduled', async () => {
    await knife(['https://a.example/1'])
    await knife(['https://b.example/2'])
    const ids = sourceIds()
    const { worker, pending, finish, now } = harness()
    // Both were checked a moment ago: nothing is due.
    getLocalDb()
      .prepare(
        'UPDATE price_sources SET priority = 0, last_checked_at = ?, next_check_at = ?',
      )
      .run(
        new Date(now() - MIN).toISOString(),
        new Date(now() + 6 * HOUR).toISOString(),
      )
    worker.start({ scheduled: false })
    await worker.pass()
    expect(pending).toHaveLength(0)

    const round = await worker.startRoundNow()
    expect(round).toMatchObject({ trigger: 'manual' })
    expect(round?.knifeIds).toHaveLength(2)
    // One Check all at a time.
    expect(await worker.startRoundNow()).toBeNull()
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['a.example', 'b.example'])
    expect(buildQueueSnapshot(now()).round).toMatchObject({
      knives: 2,
      done: 0,
    })
    await finish()
    expect(buildQueueSnapshot(now()).round).toMatchObject({ done: 1 })
    await finish()
    await worker.pass()
    const snapshot = buildQueueSnapshot(now())
    expect(snapshot.round).toBeNull()
    expect(snapshot.lastRound).toMatchObject({ knives: 2 })
  })

  it('only runs Check now when scheduling is off or not covered', async () => {
    await knife(['https://a.example/p'])
    const off = await knife(['https://b.example/p'])
    await priceWatchRoute.PUT(
      json('http://localhost/x', 'PUT', { mode: 'off' }),
      {
        params: Promise.resolve({ id: off }),
      },
    )
    await knife(['https://c.example/p'], { sold: true })
    const ids = sourceIds()
    saveSettings({
      priceMonitoring: { ...getSettings().priceMonitoring, enabled: false },
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

    // Back on: the Never monitor and sold knives stay out of the schedule.
    saveSettings({
      priceMonitoring: { ...getSettings().priceMonitoring, enabled: true },
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
    checkedYesterday()
    const ids = sourceIds()
    const { worker, pending, now } = harness()
    const hour = new Date(now()).getHours()
    await recordAdvice({
      generation: getVaultAccessState().generation,
      createdAt: new Date(now()).toISOString(),
      trigger: 'manual',
      model: 'm',
      input: {
        now: new Date(now()).toISOString(),
        timeZone: 'UTC',
        frequencyHours: 24,
        statsDays: 7,
        stores: [],
      },
      applied: {
        createdAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + 48 * HOUR).toISOString(),
        lanes: [
          {
            laneKey: 'a.example',
            minGapMs: null,
            pauseUntil: null,
            quietHours: [hour, (hour + 2) % 24],
            strategy: null,
            reason: 'test',
            adjustments: [],
          },
          {
            laneKey: 'b.example',
            minGapMs: null,
            pauseUntil: new Date(now() + HOUR).toISOString(),
            quietHours: null,
            strategy: null,
            reason: 'test',
            adjustments: [],
          },
        ],
      },
    })
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending.map((check) => [check.sourceId, check.trigger])).toEqual([
      [ids.get('https://c.example/p'), 'scheduled'],
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
          findMovedPages: true,
          autoRelink: false,
          fixVariants: true,
          retryBlocked: true,
          confirmChanges: true,
          spotCheck: true,
          dailyDigest: false,
          maxPageKb: 200,
          maxAnswerTokens: 16_384,
          usage: DEFAULT_PRICE_MONITORING.ai.usage,
          agentMode: 'off',
          chat: DEFAULT_PRICE_MONITORING.ai.chat,
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
    expect(supervise).toHaveBeenCalledWith('event', {
      canWrite: expect.any(Function),
    })
  })
})

describe('Other stores searches', () => {
  it('searches at every store where the knife has no listing, taking turns with price checks', async () => {
    const own = await knife(['https://maker.example/a'])
    const atBladeHq = await knife([
      'https://www.bladehq.com/item--Test-Knife--2',
    ])
    checkedYesterday()
    otherStores({ bladehq: true, smkw: true, amazon: true })
    const ids = sourceIds()
    const clock = { now: () => 0 }
    const { calls, discover } = searches(() => clock.now())
    const { worker, pending, finish, advance, now } = harness({ discover })
    clock.now = now
    worker.start({ scheduled: true })
    await worker.pass()
    // The maker's store checks; each Other store searches first.
    expect(lanesOf(pending, ids)).toEqual(['maker.example'])
    expect(calls.map((call) => [call.knifeId, call.store])).toEqual([
      [own, 'bladehq'],
      [own, 'smkw'],
      [own, 'amazon'],
    ])
    expect([...worker.searches.keys()].sort()).toEqual([
      'amazon',
      'bladehq.com',
      'smkw.com',
    ])
    await finish()
    for (const call of calls.splice(0)) call.resolve(notFound)
    await worker.idle()

    // Blade HQ's next turn is its price check; a store with a listing is
    // never searched for that knife.
    advance(MIN)
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['www.bladehq.com'])
    expect(calls).toHaveLength(0)
    await finish()

    // Five minutes between searches at one store.
    advance(5 * MIN)
    await worker.pass()
    expect(calls.map((call) => [call.knifeId, call.store]).sort()).toEqual([
      [atBladeHq, 'amazon'],
      [atBladeHq, 'smkw'],
    ])
  })

  it('checks a listing the search just found next at that store', async () => {
    const lookFor = await knife([])
    otherStores({ bladehq: true })
    const { calls, discover } = searches()
    const { worker, pending, advance } = harness({ discover })
    worker.start({ scheduled: true })
    await worker.pass()
    expect(calls.map((call) => [call.knifeId, call.store])).toEqual([
      [lookFor, 'bladehq'],
    ])
    await priceWatchRoute.PUT(
      json('http://localhost/x', 'PUT', {
        add: [{ url: 'https://www.bladehq.com/item--Found-Knife--9' }],
      }),
      { params: Promise.resolve({ id: lookFor }) },
    )
    const found = sourceIds().get(
      'https://www.bladehq.com/item--Found-Knife--9',
    )!
    calls[0].resolve({ ...notFound, result: 'found', sourceId: found })
    await worker.idle()
    // Its first price follows the search at the store's minimum gap.
    advance(MIN)
    await worker.pass()
    expect(pending.map((check) => [check.sourceId, check.trigger])).toEqual([
      [found, 'scheduled'],
    ])
  })

  it('waits out a store’s own search gap', async () => {
    const first = await knife([])
    const second = await knife([])
    otherStores({ knifejoy: true })
    const clock = { now: () => 0 }
    const { calls, discover } = searches(() => clock.now())
    const { worker, advance, now } = harness({ discover })
    clock.now = now
    worker.start({ scheduled: true })
    await worker.pass()
    expect(calls.map((call) => call.knifeId)).toEqual([first])
    calls[0].resolve(notFound)
    await worker.idle()

    // KnifeJoy allows one search every 15 minutes.
    advance(MIN)
    await worker.pass()
    expect(calls).toHaveLength(1)
    advance(14 * MIN)
    await worker.pass()
    expect(calls.map((call) => call.knifeId)).toEqual([first, second])
  })

  it('probes a paused store with a search once its cooldown is over', async () => {
    const lookFor = await knife([])
    otherStores({ bladehq: true })
    const discover = vi.fn(async (): Promise<DiscoverySummary> => notFound)
    const { worker, now } = harness({ discover })
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
      {
        signal: expect.any(AbortSignal),
        store: 'bladehq',
        canWrite: expect.any(Function),
      },
    ])
    await worker.idle()
    const lane = getLocalDb()
      .prepare(
        "SELECT circuit FROM price_host_state WHERE lane_key = 'bladehq.com'",
      )
      .get() as { circuit: string }
    expect(lane.circuit).toBe('closed')
  })

  it('does not slow a store for long AI searches; throttling still does', async () => {
    for (let index = 0; index < 4; index += 1) await knife([])
    otherStores({ bladehq: true })
    let outcome: DiscoverySummary & { status: 'done' } = {
      ...(notFound as DiscoverySummary & { status: 'done' }),
      // Three minutes of AI matching and browsing.
      durationMs: 3 * MIN,
    }
    const discover = vi.fn(async (): Promise<DiscoverySummary> => outcome)
    const { worker, advance } = harness({ discover })
    const minGap = () =>
      (
        getLocalDb()
          .prepare(
            "SELECT min_gap_ms FROM price_host_state WHERE lane_key = 'bladehq.com'",
          )
          .get() as { min_gap_ms: number }
      ).min_gap_ms
    worker.start({ scheduled: true })
    for (let search = 1; search <= 3; search += 1) {
      await worker.pass()
      await worker.idle()
      await worker.pass()
      expect(discover).toHaveBeenCalledTimes(search)
      expect(minGap()).toBe(MIN)
      // Five minutes between searches at one store.
      advance(5 * MIN)
    }

    outcome = { ...outcome, laneOutcome: 'throttled' }
    await worker.pass()
    await worker.idle()
    expect(discover).toHaveBeenCalledTimes(4)
    expect(minGap()).toBe(2 * MIN)
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

  it('pauses a store whose pages load without prices, others go on', async () => {
    await knife(['https://shop.example/a'])
    await knife(['https://shop.example/b'])
    await knife(['https://shop.example/c'])
    await knife(['https://other.example/a', 'https://other.example/b'])
    const ids = sourceIds()
    const { worker, pending, finish, now, advance } = harness()
    worker.start({ scheduled: true })
    const shop = (check: Pending) =>
      [...ids].find(([, id]) => id === check.sourceId)?.[0].includes('shop.')
    const suspect = {
      outcome: 'no_price',
      errorCode: 'not_found',
      suspect: true,
    } as const
    for (let i = 0; i < 3; i += 1) {
      await worker.pass()
      const index = pending.findIndex(shop)
      expect(index).toBeGreaterThanOrEqual(0)
      await finish(index, suspect)
      for (const _ of [...pending]) await finish(0)
      advance(10 * MIN)
    }
    const lanes = buildQueueSnapshot(now()).lanes
    const shopLane = lanes.find((lane) => lane.laneKey === 'shop.example')
    expect(shopLane).toMatchObject({
      circuit: 'open',
      openReason: 'soft_block',
    })
    await worker.pass()
    expect(pending.some(shop)).toBe(false)
    expect(
      lanes.find((lane) => lane.laneKey === 'other.example')?.circuit,
    ).toBe('closed')
  })

  it('reads robots.txt once a day and keeps the gap at its Crawl-delay', async () => {
    await knife(['https://shop.example/a'])
    const crawlDelay = vi.fn<NonNullable<WorkerDeps['crawlDelay']>>(
      async () => 5 * MIN,
    )
    const { worker, now, advance } = harness({ crawlDelay })
    worker.start({ scheduled: true })
    await worker.pass()
    await vi.waitFor(() => expect(crawlDelay).toHaveBeenCalledTimes(1))
    expect(crawlDelay.mock.calls[0][0]).toBe('https://shop.example/a')
    await vi.waitFor(() =>
      expect(buildQueueSnapshot(now()).lanes[0]).toMatchObject({
        robotsDelayMs: 5 * MIN,
        gapMs: 5 * MIN,
      }),
    )
    // Read again only after a day.
    advance(20 * MIN)
    await worker.pass()
    expect(crawlDelay).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown stores and actions', async () => {
    expect((await storeAction('nowhere.example', 'pause')).status).toBe(404)
    expect((await storeAction('nowhere.example', 'explode')).status).toBe(400)
  })
})

describe('queue snapshot', () => {
  it('reports Check now requests, links due and each store', async () => {
    await knife(['https://shop.example/a', 'https://shop.example/b'])
    checkedYesterday(Date.now())
    roundEvery(12)
    const ids = sourceIds()
    expect(buildQueueSnapshot()).toMatchObject({
      waiting: 0,
      backlog: 2,
      round: null,
      lastRound: null,
      frequencyMs: 12 * HOUR,
      retries: { waiting: 0, scheduled: 0, nextAt: null },
      slowStores: [],
    })
    await requestSourceChecks([ids.get('https://shop.example/a')!])
    const snapshot = buildQueueSnapshot()
    expect(snapshot.waiting).toBe(1)
    expect(snapshot.backlog).toBe(1)
    expect(snapshot.lanes[0]).toMatchObject({
      laneKey: 'shop.example',
      sources: 2,
      manual: 1,
      gapMs: MIN,
      retries: 0,
      due: 1,
    })
  })

  it('names a store too slow to check every link within the interval', async () => {
    await knife(['https://shop.example/a', 'https://shop.example/b'])
    roundEvery(6)
    getLocalDb()
      .prepare(
        `INSERT INTO price_host_state
           (lane_key, min_gap_ms, ready_at, circuit, open_count, updated_at)
         VALUES ('shop.example', ?, ?, 'closed', 0, ?)`,
      )
      .run(4 * HOUR, new Date().toISOString(), new Date().toISOString())
    expect(buildQueueSnapshot().slowStores).toEqual([
      { laneKey: 'shop.example', links: 2, cycleMs: 8 * HOUR },
    ])
  })

  it('checks a sold-out official link on schedule, also with its alerts quieted', async () => {
    await knife(['https://maker.example/1'])
    checkedYesterday()
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        ignoreOfficialOutOfStock: true,
      },
    })
    const ids = sourceIds()
    getLocalDb()
      .prepare(
        "UPDATE price_sources SET last_availability = 'out_of_stock' WHERE id = ?",
      )
      .run(ids.get('https://maker.example/1'))
    const { worker, pending } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['maker.example'])
  })

  it('counts pages out of stock for two weeks as slowed', async () => {
    await knife([
      'https://shop.example/a',
      'https://shop.example/b',
      'https://shop.example/c',
      'https://shop.example/d',
    ])
    roundEvery(6)
    const ids = sourceIds()
    const longAgo = new Date(Date.now() - 20 * 24 * HOUR).toISOString()
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
    expect(buildQueueSnapshot().lanes[0]).toMatchObject({
      sources: 4,
      slowed: 2,
      gapMs: MIN,
    })
  })
})
