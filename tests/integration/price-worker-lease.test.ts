import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as priceWatchRoute from '@/app/api/knives/[id]/price-watch/route'
import { getLocalDb } from '@/lib/local-db'
import type { CheckSummary } from '@/lib/price-monitor/engine'
import {
  acquireWorkerLease,
  compareBuilds,
  NEWER_BUILD_PRECEDENCE_MS,
  ownsWorkerLease,
  readQueueCandidates,
  releaseWorkerLease,
  WORKER_BUILD,
  WORKER_LEASE_STALE_MS,
} from '@/lib/price-monitor/store'
import {
  getPriceMonitorWorker,
  PriceMonitorWorker,
  type WorkerDeps,
} from '@/lib/price-monitor/worker'
import { createServerShutdown } from '@/lib/server-shutdown'
import { getSettings } from '@/lib/settings'
import { monitorWholeCollection } from '@/tests/helpers/monitor-whole-collection'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

const NOW = Date.UTC(2026, 10, 21, 12)
let vault: TempVault | null = null
let workers: PriceMonitorWorker[] = []

beforeEach(async () => {
  vault = await createTempVault()
  monitorWholeCollection()
})
afterEach(async () => {
  await getPriceMonitorWorker().stop()
  for (const worker of workers) await worker.stop({ timeoutMs: 50 })
  workers = []
  await vault?.cleanup()
  vault = null
})

function lease() {
  return getLocalDb()
    .prepare(
      'SELECT owner, build, released_at FROM price_worker_lease WHERE id = 1',
    )
    .get() as
    | { owner: string; build: string | null; released_at: string | null }
    | undefined
}

async function knifeWithSource(url: string): Promise<number> {
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Lease knife',
        brand: 'Test',
        specs: { price: '100 USD' },
        sourceUrl: url,
      }),
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  await priceWatchRoute.GET(new Request('http://localhost/x'), {
    params: Promise.resolve({ id }),
  })
  const row = getLocalDb()
    .prepare('SELECT id FROM price_sources WHERE knife_id = ?')
    .get(id) as { id: number }
  return row.id
}

/** A worker whose checks finish when the test says so. */
function harness(extra: Partial<WorkerDeps> = {}) {
  const now = NOW
  const pending: Array<(summary: CheckSummary) => void> = []
  const worker = new PriceMonitorWorker({
    now: () => now,
    setTimer: () => null,
    clearTimer: () => {},
    random: () => 0,
    // Ignores abort, like an AI request that cannot be cancelled.
    check: () => new Promise((resolve) => pending.push(resolve)),
    ...extra,
  })
  workers.push(worker)
  return { worker, pending }
}

const done: CheckSummary = {
  status: 'done',
  outcome: 'ok',
  detection: null,
  errorCode: null,
  laneOutcome: 'success',
  durationMs: 1000,
  retryAfterMs: null,
} as CheckSummary

describe('compareBuilds', () => {
  it('orders versions numerically, a missing one first', () => {
    expect(compareBuilds('2.5.11', '2.5.10')).toBe(1)
    expect(compareBuilds('2.5.9', '2.5.10')).toBe(-1)
    expect(compareBuilds('2.6.0', '2.6.0')).toBe(0)
    expect(compareBuilds('2.5.10', null)).toBe(1)
    expect(compareBuilds(null, '2.5.10')).toBe(-1)
  })
})

describe('price worker lease', () => {
  it('lets a newer build take over at once and holds an older one off', async () => {
    expect(await acquireWorkerLease('old', NOW, '2.5.10')).toBe(true)
    // Same build, fresh heartbeat: the second server waits.
    expect(await acquireWorkerLease('twin', NOW + 1000, '2.5.10')).toBe(false)
    // Newer build: takes it although the old heartbeat is fresh.
    expect(await acquireWorkerLease('new', NOW + 2000, '2.5.11')).toBe(true)
    expect(lease()).toMatchObject({ owner: 'new', build: '2.5.11' })
    // The old server's renewal fails, even once the lease is stale.
    expect(await acquireWorkerLease('old', NOW + 3000, '2.5.10')).toBe(false)
    expect(
      await acquireWorkerLease(
        'old',
        NOW + 2000 + WORKER_LEASE_STALE_MS + 1,
        '2.5.10',
      ),
    ).toBe(false)
    expect(ownsWorkerLease('old')).toBe(false)
    expect(ownsWorkerLease('new')).toBe(true)
  })

  it('keeps an older build off after the newer one released it', async () => {
    await acquireWorkerLease('new', NOW, '2.5.11')
    await releaseWorkerLease('new', NOW + 1000)
    expect(lease()).toMatchObject({ owner: 'new', build: '2.5.11' })
    expect(lease()?.released_at).not.toBeNull()
    expect(ownsWorkerLease('new')).toBe(false)

    expect(await acquireWorkerLease('old', NOW + 2000, '2.5.10')).toBe(false)
    // A same-version server takes a released lease without waiting.
    expect(await acquireWorkerLease('next', NOW + 2000, '2.5.11')).toBe(true)
    expect(lease()?.released_at).toBeNull()
    // A day after the newer build last held it, a downgrade runs again.
    expect(
      await acquireWorkerLease(
        'old',
        NOW + 2000 + NEWER_BUILD_PRECEDENCE_MS + 1,
        '2.5.10',
      ),
    ).toBe(true)
  })

  it('takes over a lease written before versions were stored', async () => {
    getLocalDb()
      .prepare(
        `INSERT INTO price_worker_lease (id, owner, heartbeat_at)
         VALUES (1, 'legacy', ?)`,
      )
      .run(new Date(NOW).toISOString())
    expect(await acquireWorkerLease('current', NOW + 1000)).toBe(true)
    expect(lease()).toMatchObject({ owner: 'current', build: WORKER_BUILD })
  })
})

describe('price worker ownership', () => {
  it('releases the lease on stop', async () => {
    const { worker } = harness()
    worker.start({ scheduled: false })
    await worker.pass()
    expect(ownsWorkerLease(worker.owner)).toBe(true)
    expect(worker.ownsLease()).toBe(true)
    await worker.stop()
    expect(ownsWorkerLease(worker.owner)).toBe(false)
    expect(worker.ownsLease()).toBe(false)
    expect(lease()?.released_at).not.toBeNull()
  })

  it('a bounded stop releases the lease while work is still running', async () => {
    await knifeWithSource('https://kizer.example/lease')
    const { worker, pending } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending).toHaveLength(1)
    await worker.stop({ timeoutMs: 20 })
    expect(ownsWorkerLease(worker.owner)).toBe(false)
    // The check finishes after shutdown: its lane state is not written.
    pending[0](done)
    await new Promise((resolve) => setImmediate(resolve))
    expect(
      getLocalDb().prepare('SELECT COUNT(*) AS n FROM price_host_state').get(),
    ).toEqual({ n: 0 })
  })

  it('writes nothing from a check that finishes after the lease moved', async () => {
    await knifeWithSource('https://kizer.example/moved')
    const { worker, pending } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    expect(pending).toHaveLength(1)
    // Another process (a newer build, or one that took over after sleep).
    expect(await acquireWorkerLease('other', NOW + 1000, '999.0.0')).toBe(true)
    pending[0](done)
    await vi.waitFor(() => expect(worker.inFlight.size).toBe(0))
    expect(worker.ownsLease()).toBe(false)
    expect(
      getLocalDb().prepare('SELECT COUNT(*) AS n FROM price_host_state').get(),
    ).toEqual({ n: 0 })
  })

  it('writes lane state while it still owns the lease', async () => {
    await knifeWithSource('https://kizer.example/owned')
    const { worker, pending } = harness()
    worker.start({ scheduled: true })
    await worker.pass()
    pending[0](done)
    await vi.waitFor(() => expect(worker.inFlight.size).toBe(0))
    await vi.waitFor(() =>
      expect(
        getLocalDb()
          .prepare('SELECT COUNT(*) AS n FROM price_host_state')
          .get(),
      ).toEqual({ n: 1 }),
    )
  })
})

describe('Amazon sources', () => {
  it('are queued like any store, on the shared Amazon lane', async () => {
    const id = await knifeWithSource('https://kizer.example/amazon')
    getLocalDb()
      .prepare(
        `UPDATE price_sources
         SET url = 'https://www.amazon.com/dp/B000', lane_key = 'amazon'
         WHERE id = ?`,
      )
      .run(id)
    const settings = getSettings().priceMonitoring
    expect(
      readQueueCandidates(getLocalDb(), settings, NOW).find(
        (row) => row.sourceId === id,
      ),
    ).toMatchObject({ laneKey: 'amazon' })
  })
})

describe('server shutdown', () => {
  it('stops the worker once, then exits with the signal code', async () => {
    const stopWorker = vi.fn(async () => {})
    const exit = vi.fn()
    const shutdown = createServerShutdown({
      stopWorker,
      exit,
      setTimer: (callback) => callback(),
      log: () => {},
    })
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')])
    expect(stopWorker).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(143)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('still exits when the worker cannot stop', async () => {
    const exit = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await createServerShutdown({
      stopWorker: async () => {
        throw new Error('vault closed')
      },
      exit,
      setTimer: (callback) => callback(),
      log: () => {},
    })('parent-exited')
    expect(exit).toHaveBeenCalledWith(0)
    error.mockRestore()
  })
})
