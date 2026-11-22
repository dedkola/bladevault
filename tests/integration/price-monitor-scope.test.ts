import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import { createKnife } from '@/tests/fixtures/knife'
import { LocalStorage } from '@/lib/storage/local'
import { getLocalDb } from '@/lib/local-db'
import { mutateComparison } from '@/lib/comparison-storage'
import type { EligibilitySettings } from '@/lib/price-monitor/eligibility'
import {
  readMonitorScopeKnifeIds,
  withMonitorScope,
} from '@/lib/price-monitor/scope'
import {
  DEFAULT_PRICE_MONITOR_SCOPE,
  normalizePriceMonitorScope,
  normalizePriceMonitoring,
} from '@/lib/settings-shared'

let vault: TempVault
beforeEach(async () => {
  vault = await createTempVault()
  const storage = new LocalStorage()
  for (const id of ['first', 'second', 'third'])
    await storage.migrateKnife(createKnife({ id, name: id }), [])
})
afterEach(async () => {
  await vault.cleanup()
})

function createList(name: string, ids: string[]) {
  const result = mutateComparison({ action: 'create', name, ids })
  return result.listId!
}

describe('monitoring scope', () => {
  it('covers the whole collection by default', () => {
    expect(readMonitorScopeKnifeIds(getLocalDb(), undefined)).toBeNull()
    expect(
      readMonitorScopeKnifeIds(getLocalDb(), DEFAULT_PRICE_MONITOR_SCOPE),
    ).toBeNull()
  })

  it('uses the selected knives, and an empty selection covers nothing', () => {
    const db = getLocalDb()
    expect(
      readMonitorScopeKnifeIds(db, {
        kind: 'selected',
        knifeIds: ['first'],
        comparisonIds: ['ignored'],
      }),
    ).toEqual(new Set(['first']))
    expect(
      readMonitorScopeKnifeIds(db, {
        kind: 'selected',
        knifeIds: [],
        comparisonIds: [],
      }),
    ).toEqual(new Set())
  })

  it('follows compare lists live and skips deleted ones', () => {
    const db = getLocalDb()
    const edc = createList('EDC', ['first'])
    const big = createList('Big', ['first', 'second'])
    const scope = {
      kind: 'compare' as const,
      knifeIds: [],
      comparisonIds: [edc, big, 'deleted-list'],
    }
    expect(readMonitorScopeKnifeIds(db, scope)).toEqual(
      new Set(['first', 'second']),
    )
    mutateComparison({ action: 'add', id: edc, ids: ['third'] })
    expect(readMonitorScopeKnifeIds(db, scope)).toEqual(
      new Set(['first', 'second', 'third']),
    )
    expect(
      readMonitorScopeKnifeIds(db, { ...scope, comparisonIds: [] }),
    ).toEqual(new Set())
  })

  it('resolves once and keeps an already resolved scope', () => {
    const db = getLocalDb()
    const settings: EligibilitySettings = {
      skipSoldKnives: true,
      scope: { kind: 'selected', knifeIds: ['second'], comparisonIds: [] },
    }
    const resolved = withMonitorScope(db, settings)
    expect(resolved.scopeKnifeIds).toEqual(new Set(['second']))
    expect(withMonitorScope(db, resolved)).toBe(resolved)
  })
})

describe('normalizePriceMonitorScope', () => {
  it('keeps old settings on the whole collection', () => {
    expect(normalizePriceMonitoring({}).scope).toEqual(
      DEFAULT_PRICE_MONITOR_SCOPE,
    )
  })

  it('cleans kinds and ids', () => {
    expect(
      normalizePriceMonitorScope({
        kind: 'everything',
        knifeIds: [' a ', 'a', 3, '', 'b'],
        comparisonIds: 'nope',
      }),
    ).toEqual({ kind: 'all', knifeIds: ['a', 'b'], comparisonIds: [] })
  })

  it('merges a partial update over the current settings', () => {
    const current = normalizePriceMonitoring({
      scope: { kind: 'compare', comparisonIds: ['x'] },
    })
    expect(current.scope).toEqual({
      kind: 'compare',
      knifeIds: [],
      comparisonIds: ['x'],
    })
    const next = normalizePriceMonitoring(
      { scope: { kind: 'selected', knifeIds: [] } },
      current,
    )
    expect(next.scope).toEqual({
      kind: 'selected',
      knifeIds: [],
      comparisonIds: ['x'],
    })
    expect(next.enabled).toBe(current.enabled)
  })
})
