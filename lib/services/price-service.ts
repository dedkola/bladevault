import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Knife } from '@/lib/data'
import { getLocalDb } from '@/lib/local-db'
import {
  buildKnifeHistory,
  buildKnifeSummaries,
  buildPriceOverview,
  listChangeEvents,
  readOutOfStockSources,
  type ChangeEvent,
  type HistoryRange,
  type MonitoredSource,
} from '@/lib/price-monitor/insights'
import { laneAvailability } from '@/lib/price-monitor/lanes'
import { fromMinorUnits } from '@/lib/price-monitor/money'
import { frequencyMs } from '@/lib/price-monitor/schedule'
import {
  MAX_PRICE_SOURCES_PER_KNIFE,
  normalizeSourceUrl,
  type EligibilityReason,
  type PriceSourceStatus,
  type PriceWatchMode,
  type PriceWatchUpdate,
} from '@/lib/price-monitor/shared'
import {
  applyPriceWatchUpdate,
  buildPriceWatchView,
  readActiveSources,
  readLaneStates,
  readQueueCandidates,
  readWatchMode,
  requestSourceChecks,
  syncAutoSource,
  type SourceRow,
} from '@/lib/price-monitor/store'
import { getSettings } from '@/lib/settings'
import { getStorage } from '@/lib/storage'
import { getVaultAccessState, withVaultWrite } from '@/lib/vault-access'

/**
 * Price monitoring for MCP clients. Everything here reads the stored history
 * and read models; it never returns AI keys, custom headers, store cookies,
 * page content or free-text check messages (which can quote a page), only
 * fixed problem descriptions keyed by error code.
 */

const DAY_MS = 24 * 60 * 60 * 1000

type Money = { amount: number; minor: number; currency: string }

function money(minor: number | null, currency: string | null): Money | null {
  if (minor === null || !currency) return null
  return { amount: fromMinorUnits(minor, currency), minor, currency }
}

function knifeLabel(knife: { name: string; brand: string }) {
  return [knife.brand, knife.name].filter(Boolean).join(' ')
}

async function requireKnife(knifeId: string): Promise<Knife> {
  const knife = await getStorage().getKnifeById(knifeId)
  if (!knife) throw new Error(`Knife with id "${knifeId}" not found`)
  return knife
}

function priceSettings() {
  return getSettings().priceMonitoring
}

// ------------------------------------------------------------- problems

const PROBLEM_BY_CODE: Record<string, string> = {
  challenge: 'The store showed a bot check; solve it in BladeVault.',
  network: 'Could not reach the store.',
  timeout: 'The page took too long to load.',
  redirect: 'The store redirected somewhere BladeVault cannot follow.',
  browser: 'The monitoring browser could not start.',
  invalid_url: 'This URL cannot be checked.',
  blocked_url: 'Private or internal addresses cannot be checked.',
  invalid_response: 'The store sent a response BladeVault could not read.',
  not_found: 'No price or stock status found on the page.',
  no_currency: 'A price was found, but not its currency.',
  wrong_currency: 'The store shows prices in another currency.',
  invalid_price: 'The price on the page is not a valid amount.',
  implausible: 'The price changed too much to trust from one reading.',
  moved: 'The product link leads to another page: the product moved.',
  soft_missing: 'The store says this product page is gone.',
  delivery_location: 'Amazon showed no price for a US delivery address.',
  wrong_variant: 'The page shows another variant than the tracked one.',
  cancelled: 'The check was cancelled.',
}

const PROBLEM_BY_STATUS: Partial<Record<PriceSourceStatus, string>> = {
  blocked: 'The store blocked the check with a bot check.',
  failed: 'The last check failed.',
  price_unavailable: 'The page loaded but showed no price.',
  needs_review: 'AI doubts the price read from the page.',
}

/** A fixed description of a source's problem; never stored page text. */
function problemFor(
  status: PriceSourceStatus,
  errorCode: string | null,
): string | null {
  if (!PROBLEM_BY_STATUS[status]) return null
  return (
    (errorCode ? PROBLEM_BY_CODE[errorCode] : undefined) ??
    PROBLEM_BY_STATUS[status]!
  )
}

const ELIGIBILITY_TEXT: Record<EligibilityReason, string> = {
  monitored_auto: 'Monitored: Auto mode and a store URL.',
  monitored_forced: 'Monitored: Always monitor is on.',
  monitored_collection:
    'Monitored with the rest of the collection: outside What to monitor, checked in free time at most once a day, and notifies only about a super sale.',
  off: 'Not monitored: monitoring is off for this knife.',
  sold: 'Not monitored: the knife is sold and Auto mode skips sold knives.',
  no_source: 'Not monitored: no active store URL.',
  out_of_scope:
    'Not monitored: the knife is outside What to monitor in the price settings.',
}

// --------------------------------------------------------------- events

function toEventOutput(event: ChangeEvent) {
  return {
    kind: event.kind,
    knifeId: event.knife.id,
    knife: knifeLabel(event.knife),
    sourceId: event.sourceId,
    storeName: event.storeName,
    url: event.sourceUrl,
    price: money(event.priceMinor, event.currency),
    previousPrice: money(event.previousPriceMinor, event.currency),
    deltaPct: event.deltaPct,
    occurredAt: event.occurredAt,
  }
}

// ---------------------------------------------------------- reads: list

export const PRICE_WATCH_STATES = [
  'attention',
  'drop',
  'increase',
  'out_of_stock',
  'same',
  'pending',
  'not_monitored',
] as const
export type PriceWatchState = (typeof PRICE_WATCH_STATES)[number]

/** The most notable result among a knife's monitored sources. */
function knifeState(
  monitored: boolean,
  sources: readonly MonitoredSource[],
): PriceWatchState {
  if (!monitored) return 'not_monitored'
  const results = new Set<string>(sources.map((source) => source.result))
  for (const state of PRICE_WATCH_STATES) if (results.has(state)) return state
  return 'same'
}

export async function listPriceWatches(input: {
  monitoredOnly?: boolean
  state?: PriceWatchState
  limit?: number
  offset?: number
}) {
  const settings = priceSettings()
  const overview = buildPriceOverview(getLocalDb(), settings, {
    windowDays: 30,
    frequencyMs: frequencyMs(settings.schedule),
  })
  const sourcesByKnife = new Map<string, MonitoredSource[]>()
  for (const source of overview.monitored) {
    const list = sourcesByKnife.get(source.knife.id) ?? []
    list.push(source)
    sourcesByKnife.set(source.knife.id, list)
  }

  const knives = buildKnifeSummaries(getLocalDb(), settings)
    .filter((summary) => !(input.monitoredOnly ?? true) || summary.monitored)
    .map((summary) => {
      const state = knifeState(
        summary.monitored,
        sourcesByKnife.get(summary.knife.id) ?? [],
      )
      const best = money(summary.bestPriceMinor, summary.currency)
      const paid = money(summary.paidMinor, summary.currency)
      return {
        knifeId: summary.knife.id,
        knife: knifeLabel(summary.knife),
        monitored: summary.monitored,
        state,
        sources: summary.sources,
        bestPrice: best,
        paid,
        vsPaidPct:
          best && paid && paid.minor > 0
            ? Math.round(((best.minor - paid.minor) / paid.minor) * 1000) / 10
            : null,
        outOfStock: summary.outOfStock,
        lastChange: summary.lastChange
          ? toEventOutput(summary.lastChange)
          : null,
        lastCheckedAt: summary.lastCheckedAt,
      }
    })
    .filter((item) => !input.state || item.state === input.state)
    .sort((a, b) => a.knife.localeCompare(b.knife))

  const offset = input.offset ?? 0
  const limit = input.limit ?? 100
  return {
    total: knives.length,
    offset,
    knives: knives.slice(offset, offset + limit),
  }
}

// ------------------------------------------------------- reads: changes

export const PRICE_CHANGE_KINDS = [
  'drop',
  'increase',
  'back_in_stock',
  'out_of_stock',
] as const

export async function listPriceChanges(input: {
  days?: number
  kinds?: Array<(typeof PRICE_CHANGE_KINDS)[number]>
  limit?: number
  now?: number
}) {
  const days = input.days ?? 30
  const now = input.now ?? Date.now()
  const since = new Date(now - days * DAY_MS).toISOString()
  const database = getLocalDb()
  // Counts cover the whole window; the event list honours kinds and limit.
  const windowEvents = listChangeEvents(database, { since, limit: 10_000 })
  const counts = Object.fromEntries(
    PRICE_CHANGE_KINDS.map((kind) => [
      kind,
      windowEvents.filter((event) => event.kind === kind).length,
    ]),
  )
  const kinds = input.kinds?.length ? new Set<string>(input.kinds) : null
  const events = windowEvents
    .filter((event) => !kinds || kinds.has(event.kind))
    .slice(0, input.limit ?? 50)
  return {
    days,
    since,
    counts,
    events: events.map(toEventOutput),
    outOfStockNow: readOutOfStockSources(database, priceSettings()).map(
      (source) => ({
        knifeId: source.knife.id,
        knife: knifeLabel(source.knife),
        sourceId: source.sourceId,
        storeName: source.storeName,
        url: source.url,
        since: source.since,
        lastCheckedAt: source.lastCheckedAt,
      }),
    ),
  }
}

// ------------------------------------------------------- reads: history

export async function getPriceHistory(input: {
  knifeId: string
  range: HistoryRange
}) {
  await requireKnife(input.knifeId)
  const history = buildKnifeHistory(getLocalDb(), input.knifeId, input.range)
  if (!history) throw new Error(`Knife with id "${input.knifeId}" not found`)
  return {
    knifeId: history.knife.id,
    knife: knifeLabel(history.knife),
    range: history.range,
    rangeStart: history.rangeStart,
    paid: history.paid,
    sources: history.sources.map((source) => {
      const priced = source.points.filter(
        (point) => point.priceMinor !== null && point.currency,
      )
      const latest = source.points.at(-1)
      const low = priced.reduce<(typeof priced)[number] | null>(
        (best, point) =>
          !best || point.priceMinor! < best.priceMinor! ? point : best,
        null,
      )
      const high = priced.reduce<(typeof priced)[number] | null>(
        (best, point) =>
          !best || point.priceMinor! > best.priceMinor! ? point : best,
        null,
      )
      return {
        sourceId: source.sourceId,
        storeName: source.storeName,
        url: source.url,
        removed: source.removed,
        match: source.variantTitle ? 'variant' : 'exact',
        ...(source.variantTitle ? { variantTitle: source.variantTitle } : {}),
        latest: latest
          ? {
              price: money(latest.priceMinor, latest.currency),
              availability: latest.availability,
              confirmedAt: latest.to,
            }
          : null,
        low: low ? money(low.priceMinor, low.currency) : null,
        high: high ? money(high.priceMinor, high.currency) : null,
        points: source.points.map((point) => ({
          from: point.from,
          to: point.to,
          price: money(point.priceMinor, point.currency),
          availability: point.availability,
        })),
      }
    }),
    events: history.events.map(toEventOutput),
  }
}

// --------------------------------------------------------- reads: watch

function readSourceErrorCodes(
  database: Database.Database,
  knifeId: string,
): Map<number, string | null> {
  return new Map(
    readActiveSources(database, knifeId).map((row) => [
      row.id,
      row.last_error_code,
    ]),
  )
}

export async function getPriceWatch(knifeId: string) {
  const knife = await requireKnife(knifeId)
  const view = buildPriceWatchView(knife, priceSettings())
  const errorCodes = readSourceErrorCodes(getLocalDb(), knife.id)
  const queued = new Set(view.queuedSourceIds)
  return {
    knifeId: knife.id,
    knife: knifeLabel(knife),
    mode: view.mode,
    monitored: view.eligibility.monitored,
    eligibility: view.eligibility.reason,
    eligibilityText: ELIGIBILITY_TEXT[view.eligibility.reason],
    maxSources: view.maxSources,
    // Listings of other variants are outside the limit.
    remainingSlots: Math.max(
      0,
      view.maxSources -
        view.sources.filter((source) => !source.variantTitle).length,
    ),
    sources: view.sources.map((source) => ({
      sourceId: source.id,
      url: source.url,
      storeName: source.storeName,
      origin: source.origin,
      foundByAi: source.foundByAi ?? false,
      // exact: the knife itself; variant: the same model in another
      // variant (Other stores), never its price or alerts.
      match: source.variantTitle ? 'variant' : 'exact',
      ...(source.variantTitle ? { variantTitle: source.variantTitle } : {}),
      paused: !source.enabled,
      status: source.status,
      problem: problemFor(source.status, errorCodes.get(source.id) ?? null),
      price: money(source.lastPriceMinor, source.lastCurrency),
      availability: source.lastAvailability,
      lastCheckedAt: source.lastCheckedAt,
      lastSuccessAt: source.lastSuccessAt,
      consecutiveFailures: source.consecutiveFailures,
      checkQueued: queued.has(source.id),
    })),
  }
}

// ----------------------------------------------------- reads: attention

type AttentionSourceRow = {
  id: number
  knife_id: string
  brand: string
  name: string
  store_name: string
  lane_key: string
  url: string
  status: PriceSourceStatus
  last_error_code: string | null
  last_checked_at: string | null
  consecutive_failures: number
}

const ATTENTION_GROUPS = {
  blocked: 'blocked',
  failed: 'failed',
  price_unavailable: 'unavailable',
  needs_review: 'needsReview',
} as const

export async function getPriceAttention(now = Date.now()) {
  const database = getLocalDb()
  const settings = priceSettings()
  const overview = buildPriceOverview(database, settings, {
    now,
    windowDays: 1,
    frequencyMs: frequencyMs(settings.schedule),
  })
  // Sources scheduled monitoring covers; the rest are listed as not
  // monitored and left out of the counts.
  const covered = new Set(
    readQueueCandidates(database, settings)
      .filter((candidate) => candidate.covered)
      .map((candidate) => candidate.sourceId),
  )
  const rows = database
    .prepare(
      `SELECT s.id, s.knife_id, k.brand, k.name, s.store_name, s.lane_key,
              s.url, s.status, s.last_error_code, s.last_checked_at,
              s.consecutive_failures
       FROM price_sources s JOIN knives k ON k.id = s.knife_id
       WHERE s.removed_at IS NULL AND s.enabled = 1
         AND s.variant_search IS NULL
         AND s.status IN ('failed', 'blocked', 'price_unavailable',
                          'needs_review')
       ORDER BY s.last_checked_at DESC, s.id DESC`,
    )
    .all() as AttentionSourceRow[]

  const groups: Record<
    (typeof ATTENTION_GROUPS)[keyof typeof ATTENTION_GROUPS],
    Array<Record<string, unknown>>
  > = { blocked: [], failed: [], unavailable: [], needsReview: [] }
  for (const row of rows) {
    const group = ATTENTION_GROUPS[row.status as keyof typeof ATTENTION_GROUPS]
    if (!group) continue
    groups[group].push({
      knifeId: row.knife_id,
      knife: knifeLabel(row),
      sourceId: row.id,
      storeName: row.store_name,
      url: row.url,
      monitored: covered.has(row.id),
      problem: problemFor(row.status, row.last_error_code),
      consecutiveFailures: row.consecutive_failures,
      lastCheckedAt: row.last_checked_at,
    })
  }

  const pausedStores = [...readLaneStates(database).values()]
    .map((lane) => ({ lane, availability: laneAvailability(lane, now) }))
    .filter(({ availability }) => availability.state === 'cooling')
    .map(({ lane, availability }) => ({
      store: lane.laneKey,
      pausedUntil:
        availability.state === 'cooling'
          ? new Date(availability.until).toISOString()
          : null,
    }))

  return {
    monitoringEnabled: settings.enabled,
    monitoredKnives: overview.kpis.monitoredKnives,
    sources: overview.kpis.sources,
    lastSuccessAt: overview.kpis.lastSuccessAt,
    failedChecks24h: overview.round.failed24h,
    oldestCheckAt: overview.round.oldestCheckAt,
    needsAttention: rows.filter((row) => covered.has(row.id)).length,
    notMonitored: rows.filter((row) => !covered.has(row.id)).length,
    ...groups,
    pausedStores,
  }
}

// ------------------------------------------------------------- writes

export type PriceWatchChangeInput = {
  knifeId: string
  mode?: PriceWatchMode
  add?: Array<{ url: string; storeName?: string }>
  pause?: number[]
  resume?: number[]
  remove?: number[]
}

function stateFingerprint(
  database: Database.Database,
  knife: Knife,
  sources: readonly SourceRow[],
) {
  return {
    mode: readWatchMode(database, knife.id),
    sourceUrl: knife.sourceUrl ?? '',
    sources: sources.map((source) => [
      source.id,
      source.enabled,
      source.updated_at,
    ]),
  }
}

function cleanStoreName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const name = value.trim().replace(/\s+/g, ' ')
  if (name.length > 80) throw new Error('Store name is too long')
  return name || undefined
}

async function validatePriceWatchChange(input: PriceWatchChangeInput) {
  const knife = await requireKnife(input.knifeId)
  const database = getLocalDb()
  const active = readActiveSources(database, knife.id)
  const byId = new Map(active.map((source) => [source.id, source]))
  const errors: string[] = []
  const changes: Array<Record<string, unknown>> = []
  const update: PriceWatchUpdate = {}

  const currentMode = readWatchMode(database, knife.id)
  if (input.mode && input.mode !== currentMode) {
    update.mode = input.mode
    changes.push({ action: 'set_mode', from: currentMode, to: input.mode })
  }

  const touched = new Set<number>()
  const lookup = (id: number, action: string) => {
    if (touched.has(id)) {
      errors.push(`Source ${id} appears in more than one change`)
      return null
    }
    touched.add(id)
    const source = byId.get(id)
    if (!source) errors.push(`${action}: source ${id} is not on this knife`)
    return source ?? null
  }

  const removeIds: number[] = []
  for (const id of input.remove ?? []) {
    const source = lookup(id, 'remove')
    if (!source) continue
    if (source.origin === 'auto') {
      errors.push(
        `remove: source ${id} comes from the knife's product link and can only be paused`,
      )
      continue
    }
    removeIds.push(id)
    changes.push({ action: 'remove', sourceId: id, url: source.url })
  }

  const toggles: NonNullable<PriceWatchUpdate['update']> = []
  for (const [list, enabled, action] of [
    [input.pause ?? [], false, 'pause'],
    [input.resume ?? [], true, 'resume'],
  ] as const) {
    for (const id of list) {
      const source = lookup(id, action)
      if (!source) continue
      if ((source.enabled === 1) === enabled) {
        changes.push({ action, sourceId: id, url: source.url, noOp: true })
        continue
      }
      toggles.push({ id, enabled })
      changes.push({ action, sourceId: id, url: source.url })
    }
  }

  const adds: NonNullable<PriceWatchUpdate['add']> = []
  // A variant listing's link may be added: it becomes the knife's own.
  const known = new Set(
    active
      .filter(
        (source) =>
          !removeIds.includes(source.id) && source.variant_search === null,
      )
      .map((source) => source.normalized_url),
  )
  for (const item of input.add ?? []) {
    const url = item.url.trim()
    const normalized = normalizeSourceUrl(url)
    if (!normalized) {
      errors.push(
        `add: "${url}" is not a valid product URL starting with http:// or https://`,
      )
      continue
    }
    if (known.has(normalized)) {
      errors.push(`add: "${url}" is already monitored for this knife`)
      continue
    }
    let storeName: string | undefined
    try {
      storeName = cleanStoreName(item.storeName)
    } catch (error) {
      errors.push(`add: ${(error as Error).message}`)
      continue
    }
    known.add(normalized)
    adds.push({ url, ...(storeName ? { storeName } : {}) })
    changes.push({ action: 'add', url, normalizedUrl: normalized, storeName })
  }

  const ownIds = new Set(
    active
      .filter((source) => source.variant_search === null)
      .map((source) => source.id),
  )
  // An added variant link turns into one of the knife's own sources.
  const finalCount =
    ownIds.size - removeIds.filter((id) => ownIds.has(id)).length + adds.length
  if (finalCount > MAX_PRICE_SOURCES_PER_KNIFE)
    errors.push(
      `A knife can have at most ${MAX_PRICE_SOURCES_PER_KNIFE} price sources (this change would leave ${finalCount})`,
    )

  if (adds.length) update.add = adds
  if (toggles.length) update.update = toggles
  if (removeIds.length) update.remove = removeIds

  const previewHash = createHash('sha256')
    .update(
      JSON.stringify({
        knifeId: knife.id,
        state: stateFingerprint(database, knife, active),
        update,
      }),
    )
    .digest('hex')

  return { knife, update, changes, errors, previewHash, finalCount }
}

/**
 * Preview (default) or apply a change to a knife's price monitoring. Apply
 * needs the preview_hash of a fresh preview of the same change; the hash
 * covers the knife's current sources, so edits made in between make it stale.
 */
export async function updatePriceWatch(
  input: PriceWatchChangeInput & { apply?: boolean; previewHash?: string },
) {
  const run = async () => {
    const validation = await validatePriceWatchChange(input)
    const hasChanges = Boolean(
      validation.update.mode ||
      validation.update.add ||
      validation.update.update ||
      validation.update.remove,
    )
    if (!input.apply) {
      return {
        applied: false,
        valid: validation.errors.length === 0,
        errors: validation.errors,
        noOp: !hasChanges,
        previewHash: validation.previewHash,
        sourceCountAfter: validation.finalCount,
        changes: validation.changes,
      }
    }
    if (validation.errors.length)
      throw new Error(
        `Price watch change was not applied: ${validation.errors.join('; ')}`,
      )
    if (!input.previewHash || input.previewHash !== validation.previewHash)
      throw new Error(
        'Price watch preview is missing or stale; preview the exact change again',
      )
    if (!hasChanges)
      return {
        applied: false,
        noOp: true,
        watch: await getPriceWatch(input.knifeId),
      }
    await applyPriceWatchUpdate(validation.knife, validation.update)
    return {
      applied: true,
      changes: validation.changes.filter((change) => !change.noOp),
      watch: await getPriceWatch(input.knifeId),
    }
  }
  return input.apply ? withVaultWrite(run) : run()
}

/**
 * Check now for one knife: marks its active sources for the paced queue,
 * which runs them at each store's next free slot and keeps every bot-check
 * pause. `startChecks` lets the in-app server wake its worker; the stdio
 * process only marks the sources for the running app to pick up.
 */
export async function requestKnifePriceCheck(input: {
  knifeId: string
  startChecks?: (sourceIds: readonly number[]) => Promise<number[]>
  now?: number
}) {
  if (getVaultAccessState().readOnly)
    throw new Error('The vault is read-only while a restore runs.')
  const knife = await requireKnife(input.knifeId)
  await syncAutoSource(knife)
  const database = getLocalDb()
  const active = readActiveSources(database, knife.id)
  if (!active.length)
    throw new Error('This knife has no store URL to check. Add one first.')
  const ids = active.map((source) => source.id)
  const queued = input.startChecks
    ? await input.startChecks(ids)
    : await requestSourceChecks(ids)

  const now = input.now ?? Date.now()
  const lanes = readLaneStates(database)
  return {
    knifeId: knife.id,
    queued: active
      .filter((source) => queued.includes(source.id))
      .map((source) => {
        const lane = lanes.get(source.lane_key)
        const availability = lane ? laneAvailability(lane, now) : null
        return {
          sourceId: source.id,
          storeName: source.store_name,
          paused: source.enabled !== 1,
          storePausedUntil:
            availability?.state === 'cooling'
              ? new Date(availability.until).toISOString()
              : null,
        }
      }),
    note: input.startChecks
      ? 'Checks run at each store’s normal pace; stores paused after a bot check wait for their cooldown. Read get_price_watch later for results.'
      : 'Sources are marked for Check now. The running BladeVault app checks them at each store’s normal pace; read get_price_watch later for results.',
  }
}
