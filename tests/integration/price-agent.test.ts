import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knivesRoute from '@/app/api/knives/route'
import * as agentRoute from '@/app/api/prices/agent/route'
import { getLocalDb } from '@/lib/local-db'
import {
  buildAgentSnapshot,
  readAgentRuns,
  runPriceAgent,
} from '@/lib/price-monitor/agent'
import { readActiveSources, syncAutoSource } from '@/lib/price-monitor/store'
import { getPriceMonitorWorker } from '@/lib/price-monitor/worker'
import { getSettings, saveSettings } from '@/lib/settings'
import {
  DEFAULT_PRICE_MONITORING,
  type PriceAgentMode,
} from '@/lib/settings-shared'
import { getStorage } from '@/lib/storage'
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
    expect(JSON.stringify(snapshot)).not.toContain('https://')
    expect(JSON.stringify(snapshot)).not.toContain('129.00')

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
    getLocalDb()
      .prepare(
        `UPDATE price_sources SET last_checked_at = '2026-01-01T00:00:00.000Z',
           priority = 0 WHERE id = ?`,
      )
      .run(source.id)
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
