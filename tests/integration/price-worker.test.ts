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
import {
  readCurrentRound,
  readRetryTasks,
} from '@/lib/price-monitor/round-store'
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
  mode: string
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
          mode: options.mode ?? 'fix',
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

/** Every link was read yesterday: cycles check them, not first readings. */
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

/** Searches that finish when told to. */
function searches() {
  const calls: Array<{
    knifeId: string
    store: string
    resolve: (summary: DiscoverySummary) => void
  }> = []
  const discover = vi.fn(
    (knifeId: string, options: { signal: AbortSignal; store: string }) =>
      new Promise<DiscoverySummary>((resolve) => {
        calls.push({ knifeId, store: options.store, resolve })
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

describe('price check cycles', () => {
  it('checks every store at the same time, each at its own gap, without AI', async () => {
    await knife(['https://a.example/1', 'https://b.example/1'])
    await knife(['https://a.example/2', 'https://c.example/2'])
    await knife(['https://b.example/3'])
    checkedYesterday()
    roundEvery(6)
    const ids = sourceIds()
    const { worker, pending, finish, advance, now } = harness()
    const start = now()
    worker.start({ scheduled: true })
    await worker.pass()
    // One knife's stores, and the next knife's store nobody else uses.
    expect(lanesOf(pending, ids)).toEqual([
      'a.example',
      'b.example',
      'c.example',
    ])
    expect(new Set(pending.map((check) => check.trigger))).toEqual(
      new Set(['scheduled']),
    )
    expect(new Set(pending.map((check) => check.mode))).toEqual(
      new Set(['read']),
    )
    await finish()
    await finish()
    await finish()
    expect(buildQueueSnapshot(now()).cycle).toMatchObject({
      trigger: 'scheduled',
      knives: 3,
      wishlist: { links: 5, done: 3 },
      deferred: 0,
      problems: 0,
    })

    // A store's next request waits its gap (1 minute); others do not wait.
    advance(MIN - 1000)
    await worker.pass()
    expect(pending).toHaveLength(0)
    advance(1000)
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['a.example', 'b.example'])
    await finish()
    await finish()
    expect(buildQueueSnapshot(now()).cycle).toMatchObject({
      wishlist: { links: 5, done: 5 },
      endsAt: new Date(start + 6 * HOUR).toISOString(),
    })

    // The next cycle starts 6 hours after this one began.
    advance(start + 6 * HOUR - now() - MIN)
    await worker.pass()
    expect(pending).toHaveLength(0)
    advance(MIN)
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual([
      'a.example',
      'b.example',
      'c.example',
    ])
  })

  it('runs at most seven checks at once', async () => {
    for (let index = 0; index < 9; index += 1)
      await knife([`https://shop${index}.example/p`])
    checkedYesterday()
    const { worker, pending, finish } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending).toHaveLength(7)
    await finish()
    expect(pending).toHaveLength(7)
  })

  it('tries a store that could not answer again 10–15 minutes later, then leaves it to AI', async () => {
    await knife(['https://shop.example/1'])
    await knife(['https://other.example/2'])
    checkedYesterday()
    roundEvery(6)
    const ids = sourceIds()
    const shop = ids.get('https://shop.example/1')!
    const other = ids.get('https://other.example/2')!
    const { worker, pending, finish, advance, now } = harness({
      random: () => 0.5,
    })
    worker.start({ scheduled: true })
    await worker.pass()
    const timeout = {
      outcome: 'failed' as const,
      laneOutcome: 'failed' as const,
      errorCode: 'timeout',
    }
    await finish(
      pending.findIndex((check) => check.sourceId === shop),
      timeout,
    )
    // A page without a price is a problem right away: no retries.
    await finish(0, {
      outcome: 'no_price',
      laneOutcome: 'neutral',
      errorCode: 'no_price',
    })
    expect(retryKeys()).toEqual(
      [`check:${other}:no_price`, `check:${shop}:failed`].sort(),
    )
    const deferred = () =>
      readRetryTasks(getLocalDb()).find((task) => task.sourceId === shop)!
    expect(deferred()).toMatchObject({ attempts: 1 })
    expect(deferred().dueAt).toBe(now() + 12.5 * MIN)
    expect(
      readRetryTasks(getLocalDb()).find((task) => task.sourceId === other),
    ).toMatchObject({ dueAt: null })
    expect(buildQueueSnapshot(now()).cycle).toMatchObject({
      deferred: 1,
      problems: 1,
    })

    // Its time comes: tried again, still without AI.
    for (const attempt of [2, 3]) {
      advance(deferred().dueAt! - now() - 1000)
      await worker.pass()
      expect(pending).toHaveLength(0)
      advance(1000)
      await worker.pass()
      expect(pending.map((check) => [check.sourceId, check.trigger])).toEqual([
        [shop, 'retry'],
      ])
      expect(pending[0].mode).toBe('read')
      await finish(0, timeout)
      expect(deferred()).toMatchObject({ attempts: attempt })
    }
    // The third failure in this cycle: a problem for AI (none here).
    expect(deferred().dueAt).toBeNull()
    advance(HOUR)
    await worker.pass()
    expect(pending).toHaveLength(0)
  })

  it('lets AI work on problems one at a time once every link was checked', async () => {
    await knife(['https://a.example/1'])
    await knife(['https://b.example/2'])
    await knife(['https://c.example/3'])
    checkedYesterday()
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        ai: {
          ...DEFAULT_PRICE_MONITORING.ai,
          enabled: true,
          baseUrl: 'http://localhost:11434/v1',
          model: 'test-model',
        },
      },
    })
    const ids = sourceIds()
    const [a, b, c] = [
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ].map((url) => ids.get(url)!)
    const noPrice = {
      outcome: 'no_price' as const,
      laneOutcome: 'neutral' as const,
      errorCode: 'no_price',
    }
    const { worker, pending, finish, advance } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    const at = (sourceId: number) =>
      pending.findIndex((check) => check.sourceId === sourceId)
    await finish(at(a), noPrice)
    await finish(at(b))
    // C is still being read: AI waits for the prices.
    expect(pending.map((check) => check.sourceId)).toEqual([c])
    await finish(0, noPrice)

    // Every link was checked: AI takes the first problem, one at a time.
    advance(MIN)
    await worker.pass()
    expect(
      pending.map((check) => [check.sourceId, check.trigger, check.mode]),
    ).toEqual([[a, 'retry', 'fix']])
    await finish()
    expect(retryKeys()).toEqual([`check:${c}:no_price`])
    await worker.pass()
    expect(
      pending.map((check) => [check.sourceId, check.trigger, check.mode]),
    ).toEqual([[c, 'retry', 'fix']])
    await finish(0, noPrice)

    // One try per page and cycle: what AI could not fix waits.
    advance(MIN)
    await worker.pass()
    expect(pending).toHaveLength(0)
    expect(retryKeys()).toEqual([`check:${c}:no_price`])
  })

  it('carries on where the cycle was after a restart', async () => {
    await knife(['https://a.example/1'])
    await knife(['https://a.example/2'])
    checkedYesterday()
    const ids = sourceIds()
    const first = harness()
    first.worker.start({ scheduled: true })
    await first.worker.pass()
    expect(first.pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://a.example/1'),
    ])
    await first.finish()
    await first.worker.stop()

    const second = harness()
    second.advance(2 * MIN)
    second.worker.start({ scheduled: true })
    await second.worker.pass()
    expect(second.pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://a.example/2'),
    ])
    expect(buildQueueSnapshot(second.now()).cycle).toMatchObject({
      knives: 2,
      wishlist: { links: 2, done: 1 },
    })
  })

  it('starts a new cycle with Check all now, also where checks are not scheduled', async () => {
    await knife(['https://a.example/1'])
    await knife(['https://b.example/2'])
    checkedYesterday()
    const ids = sourceIds()
    const { worker, pending, finish } = harness()
    worker.start({ scheduled: false })
    await worker.pass()
    expect(pending).toHaveLength(0)

    const cycle = await worker.startCycleNow()
    expect(cycle).toMatchObject({ trigger: 'manual' })
    expect(cycle.knifeIds).toHaveLength(2)
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['a.example', 'b.example'])
    // Pressed again: a new cycle replaces it.
    const again = await worker.startCycleNow()
    expect(again.id).toBeGreaterThan(cycle.id)
    await finish()
    await finish()
    // Without scheduled checks it ends once every link was checked.
    await worker.pass()
    expect(readCurrentRound(getLocalDb())).toBeNull()
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

  it('skips stores in advised quiet hours or pauses; Check now still runs', async () => {
    await knife(['https://a.example/p'])
    await knife(['https://b.example/p'])
    await knife(['https://c.example/p'])
    checkedYesterday()
    const ids = sourceIds()
    const { worker, pending, now, advance } = harness()
    const hour = new Date(now()).getHours()
    const createdAt = new Date(now()).toISOString()
    const expiresAt = new Date(now() + 48 * HOUR).toISOString()
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
            pauseUntil: new Date(now() + HOUR).toISOString(),
          },
        ],
      },
    })
    worker.start({ scheduled: true })
    await worker.pass()
    // Stores do not wait for each other: C runs, A and B are held.
    expect(pending.map((check) => [check.sourceId, check.trigger])).toEqual([
      [ids.get('https://c.example/p'), 'scheduled'],
    ])

    await requestSourceChecks([ids.get('https://a.example/p')!])
    await worker.pass()
    expect(pending.map((check) => [check.sourceId, check.trigger])).toEqual([
      [ids.get('https://c.example/p'), 'scheduled'],
      [ids.get('https://a.example/p'), 'manual'],
    ])
    advance(MIN)
    await worker.pass()
    expect(pending).toHaveLength(2)
    expect(retryKeys()).toEqual([])
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

  it('searches a knife at every store without a listing, between the stores’ checks', async () => {
    const own = await knife(['https://maker.example/a'])
    const atBladeHq = await knife([
      'https://www.bladehq.com/item--Test-Knife--2',
    ])
    checkedYesterday()
    otherStores({ bladehq: true, smkw: true, amazon: true })
    const ids = sourceIds()
    const { calls, discover } = searches()
    const { worker, pending, finish, advance } = harness({ discover })
    worker.start({ scheduled: true })
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['maker.example'])
    // Every store at once; What to monitor's order decides the knife.
    expect(calls.map((call) => [call.knifeId, call.store]).sort()).toEqual(
      [
        [own, 'bladehq'],
        [own, 'smkw'],
        [own, 'amazon'],
      ].sort(),
    )
    expect([...worker.searches.keys()].sort()).toEqual([
      'amazon',
      'bladehq.com',
      'smkw.com',
    ])
    await finish()
    for (const call of calls.splice(0)) call.resolve(notFound)
    await worker.idle()
    await worker.pass()

    // A store with a listing is checked, never searched. (Five minutes on,
    // so the other stores' search gap is over too.)
    advance(5 * MIN)
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['www.bladehq.com'])
    expect(calls.map((call) => [call.knifeId, call.store]).sort()).toEqual(
      [
        [atBladeHq, 'smkw'],
        [atBladeHq, 'amazon'],
      ].sort(),
    )
  })

  it('checks a listing the search just found at the store’s next turn', async () => {
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
    await worker.pass()
    // Its first price follows the search at the store's minimum gap.
    advance(MIN)
    await worker.pass()
    expect(pending.map((check) => [check.sourceId, check.trigger])).toEqual([
      [found, 'scheduled'],
    ])
  })

  it('waits out a store’s search gap before its next search', async () => {
    const first = await knife([])
    const second = await knife([])
    otherStores({ knifejoy: true })
    const { calls, discover } = searches()
    const { worker, advance } = harness({ discover })
    worker.start({ scheduled: true })
    await worker.pass()
    expect(calls.map((call) => call.knifeId)).toEqual([first])
    calls[0].resolve(notFound)
    await worker.idle()
    await worker.pass()

    // KnifeJoy allows one search every 15 minutes.
    advance(14 * MIN)
    await worker.pass()
    expect(calls).toHaveLength(1)
    advance(MIN)
    await worker.pass()
    expect(calls.map((call) => call.knifeId)).toEqual([first, second])
    calls[1].resolve(notFound)
    await worker.idle()
    expect(retryKeys()).toEqual([])
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

/** What to monitor is the Wishlist; the rest of the collection is on too. */
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

describe('the rest of the collection', () => {
  it('comes after What to monitor, spread evenly over the cycle', async () => {
    const wished = await knife(['https://a.example/1'])
    await knife(['https://a.example/2'])
    await knife(['https://a.example/3'])
    checkedYesterday()
    roundEvery(6)
    wishlistWithCollectionPass([wished])
    const ids = sourceIds()
    const { worker, pending, finish, advance, now } = harness()
    const start = now()
    worker.start({ scheduled: true })

    // The Wishlist first.
    await worker.pass()
    expect(pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://a.example/1'),
    ])
    await finish()
    expect(buildQueueSnapshot(now()).cycle).toMatchObject({
      knives: 3,
      wishlist: { links: 1, done: 1 },
      collection: { links: 2, done: 0 },
    })

    // Then the rest, one link now and the last one spread to the cycle's
    // last tenth (5.4 hours in).
    advance(MIN)
    await worker.pass()
    expect(pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://a.example/2'),
    ])
    await finish()
    advance(HOUR)
    await worker.pass()
    expect(pending).toHaveLength(0)
    advance(start + 5.4 * HOUR - now())
    await worker.pass()
    expect(pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://a.example/3'),
    ])
    await finish()

    // The next cycle starts with the Wishlist again.
    advance(start + 6 * HOUR - now())
    await worker.pass()
    expect(pending.map((check) => check.sourceId)).toEqual([
      ids.get('https://a.example/1'),
    ])
  })

  it('starts at every store at once, and is left out when switched off', async () => {
    const wished = await knife(['https://a.example/1'])
    await knife(['https://b.example/2'])
    checkedYesterday()
    wishlistWithCollectionPass([wished])
    const ids = sourceIds()
    const { worker, pending, now } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(lanesOf(pending, ids)).toEqual(['a.example', 'b.example'])

    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        collectionPass: { enabled: false, superSalePercent: 50 },
      },
    })
    expect(buildQueueSnapshot(now()).cycle).toMatchObject({
      wishlist: { links: 1 },
      collection: { links: 0 },
    })
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
  it('reports Check now requests and the cycle', async () => {
    await knife(['https://shop.example/a', 'https://shop.example/b'])
    checkedYesterday(Date.now())
    roundEvery(12)
    const ids = sourceIds()
    expect(buildQueueSnapshot()).toMatchObject({
      waiting: 0,
      cycle: null,
      frequencyMs: 12 * HOUR,
    })
    await requestSourceChecks([ids.get('https://shop.example/a')!])
    const snapshot = buildQueueSnapshot()
    expect(snapshot.waiting).toBe(1)
    expect(snapshot.lanes[0]).toMatchObject({
      laneKey: 'shop.example',
      sources: 2,
      manual: 1,
      gapMs: MIN,
      retries: 0,
    })
  })

  it('checks a sold-out official link every cycle, also with its alerts quieted', async () => {
    await knife(['https://maker.example/1'])
    await knife(['https://shop.example/2'])
    checkedYesterday()
    roundEvery(12)
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
    const { worker, pending, finish, advance, now } = harness()
    const start = now()

    for (const cycleStart of [start, start + 12 * HOUR]) {
      advance(cycleStart - now())
      if (cycleStart === start) worker.start({ scheduled: true })
      await worker.pass()
      expect(lanesOf(pending, ids)).toEqual(['maker.example', 'shop.example'])
      await finish()
      await finish()
      expect(buildQueueSnapshot(now()).cycle).toMatchObject({
        wishlist: { links: 2, done: 2 },
      })
    }
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
