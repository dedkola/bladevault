import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import { getLocalDb } from '@/lib/local-db'
import type { CheckSummary } from '@/lib/price-monitor/engine'
import { requestSourceChecks } from '@/lib/price-monitor/store'
import {
  buildQueueSnapshot,
  PriceMonitorWorker,
  type WorkerDeps,
} from '@/lib/price-monitor/worker'
import { saveSettings } from '@/lib/settings'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const MIN = 60_000
let vault: TempVault | null = null
let workers: PriceMonitorWorker[] = []

beforeEach(async () => {
  vault = await createTempVault()
})
afterEach(async () => {
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
function harness() {
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
  }
  const worker = new PriceMonitorWorker(deps)
  workers.push(worker)
  return {
    worker,
    pending,
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
  it('starts with one check per store and at most three stores, no burst', async () => {
    await knife(['https://kizer.example/a', 'https://kizer.example/b'])
    await knife(['https://vosteed.com/a', 'https://vosteed.com/b'])
    await knife([
      'https://www.amazon.com/dp/B000000001',
      'https://www.amazon.com/dp/B000000002',
    ])
    await knife(['https://bladehq.com/a'])
    const ids = sourceIds()
    const { worker, pending, finish } = harness()
    worker.start({ scheduled: true })
    await worker.pass()

    expect(pending).toHaveLength(3)
    expect(new Set(lanesOf(pending, ids)).size).toBe(3)

    // A finished store waits for its gap; the fourth store takes the slot.
    const firstHost = lanesOf([pending[0]], ids)[0]
    await finish(0)
    expect(pending).toHaveLength(3)
    expect(new Set(lanesOf(pending, ids)).size).toBe(3)
    expect(lanesOf(pending, ids)).not.toContain(firstHost)
    expect(lanesOf(pending, ids)).toContain('bladehq.com')
  })

  it('spreads a store over the day and records its pace', async () => {
    await knife([
      'https://kizer.example/a',
      'https://kizer.example/b',
      'https://kizer.example/c',
    ])
    const { worker, pending, finish, advance } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending).toHaveLength(1)
    await finish()
    expect(pending).toHaveLength(0)

    // Three products a day: 24 h × 0.8 / 3 = 6.4 h, capped at 2 h.
    const lane = getLocalDb()
      .prepare(
        "SELECT ready_at, last_request_at FROM price_host_state WHERE lane_key = 'kizer.example'",
      )
      .get() as { ready_at: string; last_request_at: string }
    expect(Date.parse(lane.ready_at) - Date.parse(lane.last_request_at)).toBe(
      2 * 60 * MIN,
    )
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
})
