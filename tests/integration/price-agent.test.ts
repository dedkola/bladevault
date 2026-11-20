import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as agentRoute from '@/app/api/prices/agent/route'
import * as watchRoute from '@/app/api/knives/[id]/price-watch/route'
import * as messagesRoute from '@/app/api/system-messages/route'
import { getLocalDb } from '@/lib/local-db'
import {
  agentModelInput,
  buildAgentSnapshot,
  readAgentRuns,
  runPriceAgent,
} from '@/lib/price-monitor/agent'
import {
  readActiveSources,
  readQueueCandidates,
  syncAutoSource,
} from '@/lib/price-monitor/store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { getSettings, saveSettings } from '@/lib/settings'
import {
  DEFAULT_PRICE_MONITORING,
  type PriceAgentMode,
} from '@/lib/settings-shared'
import { getStorage } from '@/lib/storage'
import type { SystemMessage } from '@/lib/system-messages'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault
let aiFetch: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(async () => {
  vault = await createTempVault()
  aiFetch = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', aiFetch)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await getPriceMonitorWorker().stop()
  await vault.cleanup()
})

function enableAgent(agentMode: PriceAgentMode) {
  saveSettings({
    priceMonitoring: {
      ...getSettings().priceMonitoring,
      ai: {
        ...DEFAULT_PRICE_MONITORING.ai,
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        model: 'test-model',
        agentMode,
      },
    },
  })
}

async function createKnife(name: string, sourceUrl: string) {
  const response = await knivesRoute.POST(
    new Request('http://localhost/api/knives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        brand: 'Kizer',
        specs: { price: '129.00 USD' },
        sourceUrl,
      }),
    }),
  )
  const id = ((await response.json()) as { knife: { id: string } }).knife.id
  await syncAutoSource((await getStorage().getKnifeById(id))!)
  return { id, source: readActiveSources(getLocalDb(), id)[0] }
}

function planResponse(plan: unknown) {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(plan) } }],
  })
}

const row = (id: number) =>
  getLocalDb()
    .prepare(
      'SELECT priority, enabled, fetch_override, last_ai_at, next_check_at FROM price_sources WHERE id = ?',
    )
    .get(id) as {
    priority: number
    enabled: number
    fetch_override: string
    last_ai_at: string | null
    next_check_at: string | null
  }

describe('AI supervisor', () => {
  it('shows the model the state without URLs and applies valid actions in Act mode', async () => {
    enableAgent('act')
    const fresh = await createKnife('Drop Bear', 'https://kizer.example/drop')
    const failing = await createKnife('Begleiter', 'https://kizer.example/beg')
    const gone = await createKnife('Bone', 'https://other.example/bone')
    const stale = await createKnife('Mini', 'https://kizer.example/mini')
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString()
    getLocalDb()
      .prepare(
        `UPDATE price_sources SET status = 'ok', last_checked_at = ?,
           next_check_at = ?, priority = 0 WHERE id = ?`,
      )
      .run(old, old, stale.source.id)
    getLocalDb()
      .prepare(
        `UPDATE price_sources SET status = 'failed', consecutive_failures = 2,
           last_checked_at = ?, last_ai_at = ?, priority = 0 WHERE id = ?`,
      )
      .run(old, old, failing.source.id)
    getLocalDb()
      .prepare(
        `UPDATE price_sources SET status = 'failed', consecutive_failures = 7,
           last_error_code = 'not_found', last_checked_at = ?, priority = 0
         WHERE id = ?`,
      )
      .run(old, gone.source.id)

    const snapshot = buildAgentSnapshot({
      database: getLocalDb(),
      settings: getSettings().priceMonitoring,
      mode: 'act',
      now: Date.now(),
    })
    expect(snapshot.coverage).toMatchObject({
      monitored: 4,
      neverChecked: 1,
      failed: 2,
    })
    expect(snapshot.sources[0].id).toBe(fresh.source.id)
    // Prices, the regular price included, but never a link.
    const input = agentModelInput(snapshot)
    expect(input).not.toContain('https://')
    expect(JSON.parse(input).knives[0]).toMatchObject({
      knifeId: fresh.id,
      regular: '129.00 USD',
      sources: [expect.objectContaining({ id: fresh.source.id })],
    })
    expect(JSON.parse(input).knives[0].sources[0]).not.toHaveProperty('knife')

    aiFetch.mockResolvedValueOnce(
      planResponse({
        summary: 'One new product, two failing.',
        check: [
          { sourceId: stale.source.id, reason: 'stale' },
          { sourceId: fresh.source.id, reason: 'never checked' },
        ],
        retryWithAi: [{ sourceId: failing.source.id, reason: 'no price' }],
        fetchMode: [
          { sourceId: failing.source.id, mode: 'browser', reason: 'scripts' },
        ],
        pause: [
          { sourceId: gone.source.id, reason: 'page gone' },
          { sourceId: failing.source.id, reason: 'too early' },
        ],
        searchOtherStore: [],
      }),
    )
    const result = await runPriceAgent({ trigger: 'manual' })
    expect(result.status).toBe('done')
    if (result.status !== 'done') return
    expect(result.run.ok).toBe(true)
    expect(
      result.run.actions.map((action) => [action.kind, action.status]),
    ).toEqual([
      ['check', 'applied'],
      ['check', 'refused'],
      ['retryWithAi', 'applied'],
      ['fetchMode', 'applied'],
      ['pause', 'applied'],
      ['pause', 'refused'],
    ])
    const sent = JSON.parse(String(aiFetch.mock.calls[0][1]?.body))
    expect(sent.messages[1].content).not.toContain('https://')
    expect(sent.messages[1].content).toContain('"regular":"129.00 USD"')

    expect(row(stale.source.id).priority).toBe(1)
    expect(Date.parse(row(stale.source.id).next_check_at!)).toBeLessThanOrEqual(
      Date.now(),
    )
    expect(row(failing.source.id)).toMatchObject({
      priority: 1,
      last_ai_at: null,
      fetch_override: 'browser',
      enabled: 1,
    })
    expect(
      Date.parse(row(failing.source.id).next_check_at!),
    ).toBeLessThanOrEqual(Date.now())
    expect(row(gone.source.id).enabled).toBe(0)

    const runs = readAgentRuns(getLocalDb())
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      trigger: 'manual',
      mode: 'act',
      ok: true,
      summary: 'One new product, two failing.',
    })
    // The next snapshot shows the model what it did last time.
    expect(
      buildAgentSnapshot({
        database: getLocalDb(),
        settings: getSettings().priceMonitoring,
        mode: 'act',
        now: Date.now(),
      }).recentRuns[0].actions,
    ).toHaveLength(6)
  })

  it('only records proposals in Observe mode and journals AI failures', async () => {
    enableAgent('observe')
    const { source } = await createKnife('Drop Bear', 'https://kizer.example/d')
    // Not due yet: a check would read it sooner.
    getLocalDb()
      .prepare(
        `UPDATE price_sources SET last_checked_at = '2026-01-01T00:00:00.000Z',
           next_check_at = ?, priority = 0 WHERE id = ?`,
      )
      .run(new Date(Date.now() + 3_600_000).toISOString(), source.id)
    const before = row(source.id)
    aiFetch.mockResolvedValueOnce(
      planResponse({
        summary: 'Would check it.',
        check: [{ sourceId: source.id, reason: 'stale' }],
        retryWithAi: [],
        fetchMode: [{ sourceId: source.id, mode: 'http', reason: 'fast' }],
        pause: [],
        searchOtherStore: [],
      }),
    )
    const observed = await runPriceAgent({ trigger: 'scheduled' })
    expect(observed.status === 'done' && observed.run.actions).toEqual([
      expect.objectContaining({ kind: 'check', status: 'proposed' }),
      expect.objectContaining({ kind: 'fetchMode', status: 'proposed' }),
    ])
    expect(row(source.id)).toEqual(before)

    aiFetch.mockResolvedValueOnce(new Response('down', { status: 500 }))
    const failed = await runPriceAgent({ trigger: 'scheduled' })
    expect(failed.status === 'done' && failed.run).toMatchObject({
      ok: false,
      actions: [],
      error: expect.stringContaining('HTTP 500'),
    })
    expect(readAgentRuns(getLocalDb())).toHaveLength(2)
  })

  it('leaves 404 pages to the engine and never clears AI waits on paused sources', async () => {
    enableAgent('act')
    const notFound = await createKnife('Gone', 'https://kizer.example/gone')
    const down = await createKnife('Down', 'https://kizer.example/down')
    const paused = await createKnife('Paused', 'https://kizer.example/off')
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString()
    const log = getLocalDb().prepare(
      `INSERT INTO price_check_log
         (lane_key, trigger, source_id, knife_id, started_at, duration_ms,
          outcome, http_status, error_code)
       VALUES ('kizer.example', 'scheduled', ?, ?, ?, 100, 'failed', ?, 'http')`,
    )
    for (const [{ id, source }, status] of [
      [notFound, 404],
      [down, 503],
    ] as const) {
      log.run(source.id, id, old, status)
      getLocalDb()
        .prepare(
          `UPDATE price_sources SET status = 'failed', consecutive_failures = 8,
             last_error_code = 'http', last_checked_at = ?, priority = 0
           WHERE id = ?`,
        )
        .run(old, source.id)
    }
    getLocalDb()
      .prepare(
        `UPDATE price_sources SET enabled = 0, status = 'failed',
           last_ai_at = ? WHERE id = ?`,
      )
      .run(old, paused.source.id)

    const snapshot = buildAgentSnapshot({
      database: getLocalDb(),
      settings: getSettings().priceMonitoring,
      mode: 'act',
      now: Date.now(),
    })
    const error = (id: number) =>
      snapshot.sources.find((entry) => entry.id === id)?.error
    expect(error(notFound.source.id)).toBe('http_404')
    expect(error(down.source.id)).toBe('http_503')

    aiFetch.mockResolvedValueOnce(
      planResponse({
        summary: 'A store page said to pause everything.',
        check: [],
        retryWithAi: [{ sourceId: paused.source.id, reason: 'retry' }],
        fetchMode: [],
        pause: [notFound.source.id, down.source.id].map((sourceId) => ({
          sourceId,
          reason: 'pause',
        })),
        searchOtherStore: [],
      }),
    )
    const result = await runPriceAgent({ trigger: 'manual' })
    if (result.status !== 'done') throw new Error('agent did not run')
    expect(
      result.run.actions.map((action) => [
        action.kind,
        action.sourceId,
        action.status,
      ]),
    ).toEqual([
      ['retryWithAi', paused.source.id, 'refused'],
      ['pause', notFound.source.id, 'refused'],
      ['pause', down.source.id, 'refused'],
    ])
    expect(result.run.actions[1].note).toBe(
      'pages not found (HTTP 404 or 410) pause on their own',
    )
    expect(row(notFound.source.id).enabled).toBe(1)
    expect(row(down.source.id).enabled).toBe(1)
    // A refused retry leaves the paused source's AI wait as it was.
    expect(row(paused.source.id).last_ai_at).toBe(old)
  })

  it('shows each knife its market, the line at its store and what came of earlier actions', async () => {
    enableAgent('act')
    saveSettings({
      priceMonitoring: {
        ...getSettings().priceMonitoring,
        otherStores: {
          enabled: true,
          stores: { amazon: true, bladehq: false },
          amazonMarketplace: 'amazon.com',
          amazonPostcode: '',
        },
      },
    })
    const watched = await createKnife('Drop Bear', 'https://kizer.example/drop')
    const first = await createKnife('Mini', 'https://kizer.example/mini')
    const database = getLocalDb()
    const ago = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString()
    const setState = database.prepare(
      `UPDATE price_sources SET status = 'ok', priority = 0,
         last_checked_at = ?, next_check_at = ?, last_price_minor = ?,
         last_currency = 'USD', last_availability = 'in_stock' WHERE id = ?`,
    )
    // Both due at one store: the more overdue Mini goes first.
    setState.run(ago(1), ago(0.05), 9900, watched.source.id)
    setState.run(ago(1), ago(0.2), 5000, first.source.id)
    const snapshotRow = database.prepare(
      `INSERT INTO price_snapshots
         (knife_id, source_id, price_minor, currency, availability,
          extraction_status, extraction_method, observed_at, last_seen_at,
          ai_review)
       VALUES (?, ?, ?, 'USD', 'in_stock', 'ok', 'json_ld', ?, ?, ?)`,
    )
    const { id, source } = watched
    snapshotRow.run(id, source.id, 8900, ago(200), ago(150), null)
    snapshotRow.run(id, source.id, 12900, ago(150), ago(30), null)
    snapshotRow.run(id, source.id, 9900, ago(30), ago(0), null)
    // A reading AI did not confirm never counts as a low.
    snapshotRow.run(id, source.id, 1000, ago(10), ago(10), 'unconfirmed')
    database
      .prepare(
        `INSERT INTO price_change_events
           (knife_id, source_id, direction, previous_price_minor, price_minor,
            currency, delta_minor, delta_pct, availability, from_snapshot_id,
            to_snapshot_id, source_url, store_name, extraction_method,
            occurred_at)
         VALUES (?, ?, 'drop', 12900, 9900, 'USD', -3000, -23.26, 'in_stock',
                 2, 3, 'https://kizer.example/drop', 'Kizer', 'json_ld', ?)`,
      )
      .run(id, source.id, ago(2))
    database
      .prepare(
        `INSERT INTO price_watch
           (knife_id, mode, updated_at, target_price_minor, target_currency)
         VALUES (?, 'auto', ?, 10000, 'USD')
         ON CONFLICT (knife_id) DO UPDATE SET
           target_price_minor = excluded.target_price_minor,
           target_currency = excluded.target_currency`,
      )
      .run(id, ago(0))
    database
      .prepare(
        `INSERT INTO price_discovery
           (knife_id, store, marketplace, status, attempts, last_attempt_at,
            next_attempt_at)
         VALUES (?, 'amazon', 'amazon.com', 'not_found', 1, ?, ?)`,
      )
      .run(id, ago(10), new Date(Date.now() + 20 * 86_400_000).toISOString())

    const snapshot = buildAgentSnapshot({
      database,
      settings: getSettings().priceMonitoring,
      mode: 'act',
      now: Date.now(),
    })
    const sourceOf = (sourceId: number) =>
      snapshot.sources.find((entry) => entry.id === sourceId)
    expect(sourceOf(first.source.id)?.ahead).toBe(0)
    expect(sourceOf(source.id)).toMatchObject({
      ahead: 1,
      price: '99.00 USD',
      stock: 'in_stock',
      outOfStockDays: null,
    })
    expect(snapshot.localTime).toMatch(/\d{4}/)
    expect(snapshot.knives.find((knife) => knife.knifeId === id)).toEqual({
      knifeId: id,
      knife: 'Kizer Drop Bear',
      regular: '129.00 USD',
      target: '100.00 USD',
      muted: false,
      best: '99.00 USD',
      bestStore: sourceOf(source.id)?.store,
      low: '89.00 USD',
      low90d: '99.00 USD',
      high90d: '129.00 USD',
      lastPriceChange: {
        direction: 'drop',
        from: '129.00 USD',
        to: '99.00 USD',
        pct: -23.3,
        store: 'Kizer',
        daysAgo: 2,
      },
      lastStockChange: null,
      search: [
        {
          store: 'Amazon',
          status: 'not_found',
          nextInDays: expect.any(Number),
        },
      ],
      watching: null,
    })

    aiFetch.mockResolvedValueOnce(
      planResponse({
        summary: 'Drop Bear is below its target.',
        check: [
          { sourceId: first.source.id, reason: 'overdue' },
          { sourceId: source.id, reason: 'below target' },
        ],
        retryWithAi: [],
        fetchMode: [],
        pause: [],
        searchOtherStore: [{ knifeId: id, reason: 'single store' }],
      }),
    )
    const result = await runPriceAgent({ trigger: 'manual' })
    if (result.status !== 'done') throw new Error('agent did not run')
    expect(
      result.run.actions.map((action) => [action.kind, action.note]),
    ).toEqual([
      ['check', 'already next at its store'],
      ['check', null],
      ['searchOtherStore', null],
    ])
    // The next check and the search came back.
    const later = new Date(Date.now() + 60_000).toISOString()
    database
      .prepare(
        `INSERT INTO price_check_log
           (lane_key, trigger, source_id, knife_id, started_at, duration_ms,
            outcome)
         VALUES ('kizer.example', 'scheduled', ?, ?, ?, 100, 'ok')`,
      )
      .run(source.id, id, later)
    database
      .prepare(
        `UPDATE price_discovery SET status = 'found', last_attempt_at = ?
         WHERE knife_id = ?`,
      )
      .run(later, id)
    const next = buildAgentSnapshot({
      database,
      settings: getSettings().priceMonitoring,
      mode: 'act',
      now: Date.now(),
    })
    expect(next.recentRuns[0].actions).toEqual([
      {
        kind: 'check',
        target: `source ${first.source.id}`,
        status: 'refused',
        note: 'already next at its store',
        outcome: undefined,
      },
      {
        kind: 'check',
        target: `source ${source.id}`,
        status: 'applied',
        note: undefined,
        outcome: expect.stringMatching(/^next check: ok, \d+ min later$/),
      },
      {
        kind: 'searchOtherStore',
        target: `knife ${id}`,
        status: 'applied',
        note: undefined,
        outcome: 'searched: amazon found',
      },
    ])
  })

  it('watches a knife closely until it ends or is stopped, and cross-checks its stores', async () => {
    enableAgent('act')
    const watched = await createKnife('Drop Bear', 'https://kizer.example/drop')
    const other = await createKnife('Mini', 'https://kizer.example/mini')
    const db = getLocalDb()
    // A second store for the watched knife, and a blocked third.
    const params = { params: Promise.resolve({ id: watched.id }) }
    const added = await watchRoute.PUT(
      new Request(`http://localhost/api/knives/${watched.id}/price-watch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          add: [
            { url: 'https://blade.example/drop' },
            { url: 'https://shy.example/drop' },
          ],
        }),
      }),
      params,
    )
    expect(added.status).toBe(200)
    const [, second, blocked] = readActiveSources(db, watched.id).map(
      (source) => source.id,
    )
    const now = Date.now()
    const iso = (offset: number) => new Date(now + offset).toISOString()
    const later = iso(5 * 3_600_000)
    db.prepare(
      `UPDATE price_sources SET status = 'ok', last_checked_at = ?,
         next_check_at = ?, priority = 0 WHERE id IN (?, ?, ?)`,
    ).run(
      iso(-3 * 3_600_000),
      later,
      watched.source.id,
      other.source.id,
      second,
    )
    db.prepare(
      `UPDATE price_sources SET status = 'blocked', last_checked_at = ?,
         next_check_at = ?, priority = 0 WHERE id = ?`,
    ).run(iso(-3 * 3_600_000), later, blocked)

    aiFetch.mockResolvedValueOnce(
      planResponse({
        summary: 'Drop Bear fell at Kizer.',
        check: [],
        retryWithAi: [],
        fetchMode: [],
        pause: [],
        searchOtherStore: [],
        watchClosely: [
          {
            knifeId: watched.id,
            hours: 24,
            everyHours: 1,
            reason: 'Fresh drop, may go lower.',
          },
          { knifeId: other.id, hours: 24, everyHours: 500, reason: '' },
        ],
        crossCheck: [{ knifeId: watched.id, reason: 'Kizer moved.' }],
      }),
    )
    const result = await runPriceAgent({ trigger: 'manual' })
    expect(result.status === 'done' && result.run.actions).toEqual([
      expect.objectContaining({ kind: 'watchClosely', status: 'applied' }),
      expect.objectContaining({
        kind: 'watchClosely',
        status: 'refused',
        note: expect.stringContaining('not more often than the schedule'),
      }),
      expect.objectContaining({
        kind: 'crossCheck',
        status: 'applied',
        sourceIds: [watched.source.id, second],
      }),
    ])
    // Cross-check: both readable stores due now; the blocked one waits.
    expect(row(watched.source.id).priority).toBe(1)
    expect(row(second).priority).toBe(1)
    expect(row(blocked)).toMatchObject({ priority: 0, next_check_at: later })
    expect(row(other.source.id).next_check_at).toBe(later)

    // The schedule uses the watch's interval while it lasts.
    const candidates = readQueueCandidates(
      db,
      getSettings().priceMonitoring,
      now,
    )
    expect(
      candidates.find((candidate) => candidate.sourceId === second)
        ?.focusIntervalMs,
    ).toBe(3_600_000)
    expect(
      candidates.find((candidate) => candidate.sourceId === other.source.id)
        ?.focusIntervalMs,
    ).toBeNull()
    const snapshot = buildAgentSnapshot({
      database: db,
      settings: getSettings().priceMonitoring,
      mode: 'act',
      now,
    })
    expect(
      snapshot.knives.find((knife) => knife.knifeId === watched.id)?.watching,
    ).toEqual({
      everyHours: 1,
      endsInHours: 24,
      reason: 'Fresh drop, may go lower.',
    })
    expect(
      readQueueCandidates(
        db,
        getSettings().priceMonitoring,
        now + 25 * 3_600_000,
      ).find((candidate) => candidate.sourceId === second)?.focusIntervalMs,
    ).toBeNull()

    // Manage sources shows the watch and stops it.
    const view = await watchRoute.GET(
      new Request(`http://localhost/api/knives/${watched.id}/price-watch`),
      params,
    )
    expect(
      ((await view.json()) as { watch: { focus: unknown } }).watch.focus,
    ).toEqual({
      until: expect.any(String),
      intervalMs: 3_600_000,
      reason: 'Fresh drop, may go lower.',
    })
    const stopped = await watchRoute.PUT(
      new Request(`http://localhost/api/knives/${watched.id}/price-watch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stopWatching: true }),
      }),
      params,
    )
    expect(stopped.status).toBe(200)
    expect(
      ((await stopped.json()) as { watch: { focus: unknown } }).watch.focus,
    ).toBeNull()
    expect(
      readQueueCandidates(db, getSettings().priceMonitoring, now).find(
        (candidate) => candidate.sourceId === second,
      )?.focusIntervalMs,
    ).toBeNull()
  })

  it('leaves advice and questions in the Inbox and acts on the answers', async () => {
    enableAgent('act')
    const drop = await createKnife('Drop Bear', 'https://kizer.example/drop')
    const mini = await createKnife('Mini', 'https://kizer.example/mini')
    const db = getLocalDb()
    // Mini also has an Amazon listing that Other stores found.
    const params = (id: string) => ({ params: Promise.resolve({ id }) })
    await watchRoute.PUT(
      new Request(`http://localhost/api/knives/${mini.id}/price-watch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add: [{ url: 'https://amazon.com/dp/mini' }] }),
      }),
      params(mini.id),
    )
    const listing = readActiveSources(db, mini.id)[1].id
    db.prepare(
      `INSERT INTO price_discovery
         (knife_id, store, marketplace, status, source_id, attempts,
          last_attempt_at)
       VALUES (?, 'amazon', 'amazon.com', 'found', ?, 1, ?)`,
    ).run(mini.id, listing, new Date().toISOString())
    db.prepare(
      `UPDATE price_sources SET status = 'ok', last_price_minor = 9900,
         last_currency = 'USD', last_availability = 'in_stock',
         last_checked_at = ?, next_check_at = ?, priority = 0
       WHERE knife_id IN (?, ?)`,
    ).run(
      new Date().toISOString(),
      new Date(Date.now() + 3_600_000).toISOString(),
      drop.id,
      mini.id,
    )

    const question = (knifeId: string, patch: Record<string, unknown>) => ({
      knifeId,
      question: 'Is that right?',
      price: null,
      sourceId: null,
      hours: null,
      everyHours: null,
      ...patch,
    })
    aiFetch.mockResolvedValueOnce(
      planResponse({
        summary: 'Drop Bear is cheap.',
        check: [],
        retryWithAi: [],
        fetchMode: [],
        pause: [],
        searchOtherStore: [],
        watchClosely: [],
        crossCheck: [],
        advise: [
          {
            knifeId: drop.id,
            topic: 'deal',
            title: 'Drop Bear is 23% below regular',
            detail: 'Kizer has it for 99.00 USD.',
          },
          {
            knifeId: mini.id,
            topic: 'deal',
            title: 'Mini for 49.00 USD',
            detail: 'Invented.',
          },
        ],
        ask: [
          question(drop.id, {
            ask: 'set_target',
            price: '95.00 USD',
            question: 'Get an alert when it reaches 95.00 USD?',
          }),
          question(mini.id, { ask: 'keep_listing', sourceId: listing }),
        ],
      }),
    )
    const result = await runPriceAgent({ trigger: 'manual' })
    expect(
      result.status === 'done' &&
        result.run.actions.map((action) => [action.kind, action.note]),
    ).toEqual([
      ['advise', null],
      ['advise', 'quotes a price not in the data (49)'],
      ['ask', null],
      ['ask', null],
    ])

    const listMessages = async () =>
      (
        (await (
          await messagesRoute.GET(
            new Request('http://localhost/api/system-messages'),
          )
        ).json()) as { messages: SystemMessage[] }
      ).messages
    const messages = await listMessages()
    expect(messages.map((message) => [message.kind, message.title])).toEqual([
      ['price-advice', 'Drop Bear is 23% below regular'],
      ['price-question', 'Set a 95.00 USD target for Kizer Drop Bear?'],
      ['price-question', 'Is the amazon.com listing the right Kizer Mini?'],
    ])
    const [, target, keep] = messages
    expect(target.payload).toEqual({
      type: 'question',
      knifeId: drop.id,
      ask: 'set_target',
      priceMinor: 9500,
      currency: 'USD',
    })

    const answer = (id: number, value: string) =>
      messagesRoute.PATCH(
        new Request('http://localhost/api/system-messages', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'answer', id, answer: value }),
        }),
      )
    const yes = await answer(target.id, 'yes')
    expect(yes.status).toBe(200)
    const view = await watchRoute.GET(
      new Request(`http://localhost/api/knives/${drop.id}/price-watch`),
      params(drop.id),
    )
    expect(
      ((await view.json()) as { watch: { alerts: { targetPrice: unknown } } })
        .watch.alerts.targetPrice,
    ).toEqual({ minor: 9500, currency: 'USD' })
    const again = await answer(target.id, 'no')
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toBe(
      'This question was already answered.',
    )

    expect((await answer(keep.id, 'no')).status).toBe(200)
    expect(row(listing).enabled).toBe(0)
    expect(row(mini.source.id).enabled).toBe(1)

    // The next run sees what came of its notes and questions.
    const snapshot = buildAgentSnapshot({
      database: db,
      settings: getSettings().priceMonitoring,
      mode: 'act',
      now: Date.now(),
    })
    expect(snapshot.inbox.questions).toEqual(
      expect.arrayContaining([
        { knifeId: drop.id, ask: 'set_target', daysAgo: 0, status: 'yes' },
        { knifeId: mini.id, ask: 'keep_listing', daysAgo: 0, status: 'no' },
      ]),
    )
    expect(snapshot.inbox.advice).toEqual([
      { knifeId: drop.id, topic: 'deal', hoursAgo: 0, status: 'unread' },
    ])
    expect(
      snapshot.recentRuns[0].actions.map((action) => action.outcome),
    ).toEqual(['unread', undefined, 'answered yes', 'answered no'])

    // A week without an answer closes a question on the next Act run.
    db.prepare(
      `UPDATE system_messages SET created_at = ?, resolved_at = NULL,
         answer = NULL
       WHERE id = ?`,
    ).run(new Date(Date.now() - 8 * 86_400_000).toISOString(), keep.id)
    aiFetch.mockResolvedValueOnce(planResponse({ summary: 'Quiet.' }))
    await runPriceAgent({ trigger: 'manual' })
    const expired = (await listMessages()).find((row) => row.id === keep.id)
    expect(expired).toMatchObject({
      answer: null,
      resolvedAt: expect.any(String),
    })

    // Observe only proposes: nothing new in the Inbox.
    enableAgent('observe')
    aiFetch.mockResolvedValueOnce(
      planResponse({
        summary: '',
        advise: [
          {
            knifeId: mini.id,
            topic: 'restock',
            title: 'Mini is in stock',
            detail: '',
          },
        ],
      }),
    )
    const observed = await runPriceAgent({ trigger: 'manual' })
    expect(observed.status === 'done' && observed.run.actions).toEqual([
      expect.objectContaining({ kind: 'advise', status: 'proposed' }),
    ])
    expect(await listMessages()).toHaveLength(3)
  })

  it('serves knife labels, blocked stores and switches the mode', async () => {
    enableAgent('observe')
    const { id, source } = await createKnife(
      'Drop Bear',
      'https://kizer.example/drop',
    )
    getLocalDb()
      .prepare(
        `UPDATE price_sources SET status = 'blocked', store_name = 'Kizer',
           last_checked_at = '2026-01-01T00:00:00.000Z', priority = 0
         WHERE id = ?`,
      )
      .run(source.id)
    aiFetch.mockResolvedValueOnce(
      planResponse({
        summary: 'Kizer is blocked.',
        check: [{ sourceId: source.id, reason: 'stale' }],
        retryWithAi: [],
        fetchMode: [],
        pause: [],
        searchOtherStore: [],
      }),
    )
    const ran = await agentRoute.POST(
      new Request('http://localhost/api/prices/agent', { method: 'POST' }),
    )
    expect(ran.status).toBe(200)
    const state = (await ran.json()) as {
      blockedStores: string[]
      labels: { sources: Record<string, { knifeId: string; knife: string }> }
      runs: unknown[]
      nextRunAt: string | null
    }
    expect(state.blockedStores).toEqual(['Kizer'])
    expect(state.labels.sources[String(source.id)]).toEqual({
      knifeId: id,
      knife: 'Kizer Drop Bear',
      store: 'Kizer',
    })
    expect(state.runs).toHaveLength(1)
    expect(state.nextRunAt).toEqual(expect.any(String))

    const patch = (mode: unknown) =>
      agentRoute.PATCH(
        new Request('http://localhost/api/prices/agent', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        }),
      )
    expect((await patch('turbo')).status).toBe(400)
    const switched = await patch('act')
    expect(switched.status).toBe(200)
    expect(((await switched.json()) as { mode: string }).mode).toBe('act')
    expect(getSettings().priceMonitoring.ai.agentMode).toBe('act')
  })

  it('serves runs and refuses Run now while off', async () => {
    const off = await agentRoute.POST(
      new Request('http://localhost/api/prices/agent', { method: 'POST' }),
    )
    expect(off.status).toBe(409)
    const list = await agentRoute.GET(
      new Request('http://localhost/api/prices/agent'),
    )
    expect(await list.json()).toMatchObject({
      mode: 'off',
      active: false,
      runs: [],
    })
    expect(aiFetch).not.toHaveBeenCalled()
  })
})
