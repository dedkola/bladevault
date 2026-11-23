import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import { createKnife } from '@/tests/fixtures/knife'
import { LocalStorage } from '@/lib/storage/local'
import { getLocalDb } from '@/lib/local-db'
import { mutateWishlist } from '@/lib/wishlist-storage'
import type { EligibilitySettings } from '@/lib/price-monitor/eligibility'
import {
  readMonitorScopeKnifeIds,
  withMonitorScope,
} from '@/lib/price-monitor/scope'
import { readAgentNotes, readBlockedStores } from '@/lib/price-monitor/agent'
import { readDigestData } from '@/lib/price-monitor/digest'
import { insertSource, readCoveredKnifeIds } from '@/lib/price-monitor/store'
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

describe('monitoring scope', () => {
  it('defaults to the Wishlist; no scope or all covers everything', () => {
    const db = getLocalDb()
    expect(DEFAULT_PRICE_MONITOR_SCOPE.kind).toBe('wishlist')
    expect(readMonitorScopeKnifeIds(db, DEFAULT_PRICE_MONITOR_SCOPE)).toEqual(
      new Set(),
    )
    expect(readMonitorScopeKnifeIds(db, undefined)).toBeNull()
    expect(
      readMonitorScopeKnifeIds(db, { kind: 'all', knifeIds: [] }),
    ).toBeNull()
  })

  it('uses the selected knives, and an empty selection covers nothing', () => {
    const db = getLocalDb()
    expect(
      readMonitorScopeKnifeIds(db, {
        kind: 'selected',
        knifeIds: ['first'],
      }),
    ).toEqual(new Set(['first']))
    expect(
      readMonitorScopeKnifeIds(db, {
        kind: 'selected',
        knifeIds: [],
      }),
    ).toEqual(new Set())
  })

  it('follows the Wishlist live', () => {
    const db = getLocalDb()
    const scope = { kind: 'wishlist' as const, knifeIds: ['ignored'] }
    expect(readMonitorScopeKnifeIds(db, scope)).toEqual(new Set())
    mutateWishlist({
      action: 'add',
      knifeIds: ['first', 'second'],
      lane: 'next',
    })
    expect(readMonitorScopeKnifeIds(db, scope)).toEqual(
      new Set(['first', 'second']),
    )
    mutateWishlist({ action: 'remove', knifeIds: ['first'] })
    mutateWishlist({ action: 'add', knifeIds: ['third'], lane: 'someday' })
    expect(readMonitorScopeKnifeIds(db, scope)).toEqual(
      new Set(['second', 'third']),
    )
  })

  it('resolves once and keeps an already resolved scope', () => {
    const db = getLocalDb()
    const settings: EligibilitySettings = {
      skipSoldKnives: true,
      scope: { kind: 'selected', knifeIds: ['second'] },
    }
    const resolved = withMonitorScope(db, settings)
    expect(resolved.scopeKnifeIds).toEqual(new Set(['second']))
    expect(withMonitorScope(db, resolved)).toBe(resolved)
  })
})

describe('knives outside the scope on Price Drops', () => {
  it('hides their notes, bot checks and digest lines, and keeps the data', () => {
    const db = getLocalDb()
    const now = new Date().toISOString()
    const later = new Date(Date.now() + 7 * 86_400_000).toISOString()
    for (const [knifeId, store] of [
      ['first', 'https://kizer.example/first'],
      ['second', 'https://sog.example/second'],
    ])
      insertSource(db, knifeId, store, 'manual', undefined, now)
    db.prepare(
      `UPDATE price_sources SET enabled = 1, status = 'blocked',
         last_price_minor = 10000, last_currency = 'USD'`,
    ).run()
    const note = db.prepare(
      `INSERT INTO price_agent_notes (knife_id, note, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    note.run('first', 'Watching first.', now, later)
    note.run('second', 'Watching second.', now, later)
    note.run(null, 'A general note.', now, later)

    const settings: EligibilitySettings = {
      skipSoldKnives: true,
      scope: { kind: 'selected', knifeIds: ['first'] },
    }
    const covered = readCoveredKnifeIds(db, settings)
    expect(covered).toEqual(new Set(['first']))
    expect(
      readAgentNotes(db, Date.now(), covered).map((row) => row.note),
    ).toEqual(['Watching first.', 'A general note.'])
    expect(readBlockedStores(db, settings)).toEqual(['kizer.example'])
    const digest = readDigestData(db, Date.now(), settings)
    expect(digest.monitoredSources).toBe(1)
    expect(digest.needAttention.map((row) => row.knife)).toEqual([
      'Benchmade first',
    ])

    // Nothing is deleted: back in scope, everything shows again.
    expect(readAgentNotes(db, Date.now())).toHaveLength(3)
    expect(readBlockedStores(db, { ...settings, scope: undefined })).toEqual([
      'kizer.example',
      'sog.example',
    ])
  })
})

describe('normalizePriceMonitorScope', () => {
  it('puts settings without a scope on the Wishlist', () => {
    expect(normalizePriceMonitoring({}).scope).toEqual({
      kind: 'wishlist',
      knifeIds: [],
    })
  })

  it('cleans kinds and ids', () => {
    expect(
      normalizePriceMonitorScope({
        kind: 'everything',
        knifeIds: [' a ', 'a', 3, '', 'b'],
      }),
    ).toEqual({ kind: 'wishlist', knifeIds: ['a', 'b'] })
    // Compare lists were dropped as a scope; such settings fall back.
    expect(
      normalizePriceMonitorScope({ kind: 'compare', comparisonIds: ['x'] }),
    ).toEqual({ kind: 'wishlist', knifeIds: [] })
  })

  it('merges a partial update over the current settings', () => {
    const current = normalizePriceMonitoring({
      scope: { kind: 'selected', knifeIds: ['x'] },
    })
    expect(current.scope).toEqual({ kind: 'selected', knifeIds: ['x'] })
    const next = normalizePriceMonitoring(
      { scope: { kind: 'wishlist' } },
      current,
    )
    expect(next.scope).toEqual({ kind: 'wishlist', knifeIds: ['x'] })
    expect(next.enabled).toBe(current.enabled)
  })
})
