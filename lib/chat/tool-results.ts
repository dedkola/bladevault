import type { Knife } from '@/lib/data'
import { getStorage } from '@/lib/storage'
import type {
  ChatKnifeCard,
  ChatMoney,
  ChatPriceChangeRow,
  ChatPriceWatchRow,
  ChatToolStep,
  ChatToolUi,
} from '@/lib/chat/shared'

/**
 * Turns a tool's result into two things: the text the model reads (trimmed
 * to a few KB) and the step the page draws (label, summary, knife cards and
 * price tables built from the stored records, so the page never depends on
 * the model repeating numbers correctly).
 */

/** The most a tool result may add to the model's context. */
export const MODEL_RESULT_MAX_CHARS = 8000
/** The most cards or rows one step draws. */
const UI_MAX_ROWS = 60

type Json = Record<string, unknown>

const asRecord = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {}
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : []
const asString = (value: unknown): string =>
  typeof value === 'string' ? value : ''
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

function quoted(value: unknown): string {
  const text = asString(value).trim()
  return text ? `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”` : ''
}

/** The chip text for a tool call, before it runs. */
export function describeToolCall(name: string, rawArgs: unknown): string {
  const args = asRecord(rawArgs)
  switch (name) {
    case 'search_knives': {
      const filters = asArray(args.filters)
        .map((filter) => {
          const entry = asRecord(filter)
          return `${asString(entry.field)}: ${String(entry.value ?? '')}`
        })
        .filter((text) => text !== ': ')
      const what = [quoted(args.query), ...filters].filter(Boolean).join(', ')
      return what ? `Searched knives: ${what}` : 'Listed knives'
    }
    case 'get_knife':
      return 'Opened a knife'
    case 'get_collection_stats':
      return 'Read collection statistics'
    case 'get_achievements':
      return 'Read achievements'
    case 'find_missing_fields':
      return `Found knives missing ${asArray(args.fields).map(String).join(', ') || 'fields'}`
    case 'find_duplicates':
      return 'Looked for duplicates'
    case 'get_knife_maintenance':
      return 'Read maintenance history'
    case 'list_price_watches':
      return asString(args.state)
        ? `Listed price watches: ${asString(args.state).replace(/_/g, ' ')}`
        : 'Listed price watches'
    case 'list_price_changes': {
      const kinds = asArray(args.kinds).map((kind) =>
        String(kind).replace(/_/g, ' '),
      )
      const days = asNumber(args.days) ?? 30
      return `Listed ${kinds.length ? kinds.join(', ') : 'price changes'} · last ${days} ${days === 1 ? 'day' : 'days'}`
    }
    case 'get_price_history':
      return 'Read price history'
    case 'get_price_watch':
      return 'Read price monitoring setup'
    case 'get_price_attention':
      return 'Checked what needs attention'
    default:
      return `Ran ${name}`
  }
}

// ------------------------------------------------------------ model text

function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0
}

/** The longest array within the value (by JSON size), with its parent. */
function largestArray(
  value: unknown,
  depth = 0,
): { parent: Json; key: string; size: number } | null {
  if (depth > 4 || !value || typeof value !== 'object') return null
  let best: { parent: Json; key: string; size: number } | null = null
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Json)
  for (const [key, child] of entries) {
    if (Array.isArray(child) && child.length > 1) {
      const size = jsonLength(child)
      if (!best || size > best.size) best = { parent: value as Json, key, size }
    }
    const nested = largestArray(child, depth + 1)
    if (nested && (!best || nested.size > best.size)) best = nested
  }
  return best
}

/**
 * The result as compact JSON of at most `maxChars`: the largest lists are
 * cut (noting how many were left out) until it fits.
 */
export function toModelContent(
  name: string,
  result: Json,
  maxChars = MODEL_RESULT_MAX_CHARS,
): string {
  const copy = structuredClone(result) as Json
  // Image paths mean nothing to the model.
  if (name === 'get_knife') {
    const knife = asRecord(copy.knife)
    delete knife.images
    delete knife.webpageScreenshot
  }
  // Per list name: how many items it had and how many are left.
  const cut = new Map<string, { from: number; kept: number }>()
  // Leave room for the note on what was cut.
  const target = jsonLength(copy) > maxChars ? maxChars - 300 : maxChars
  for (let round = 0; round < 12 && jsonLength(copy) > target; round++) {
    const largest = largestArray(copy)
    if (!largest) break
    const list = largest.parent[largest.key] as unknown[]
    const keep = Math.max(1, Math.floor(list.length / 2))
    const seen = cut.get(largest.key)
    cut.set(largest.key, { from: seen?.from ?? list.length, kept: keep })
    largest.parent[largest.key] = list.slice(0, keep)
  }
  if (cut.size)
    copy._truncated = `${[...cut]
      .map(([key, { from, kept }]) => `${key}: showing ${kept} of ${from}`)
      .join(
        '; ',
      )}. Ask with a smaller limit, an offset or a narrower filter for the rest.`
  const text = JSON.stringify(copy)
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}… (cut: the result was too long)`
    : text
}

// --------------------------------------------------------------- page UI

async function knifeIndex(): Promise<Map<string, Knife>> {
  const knives = await getStorage().getAllKnives()
  return new Map(knives.map((knife) => [knife.id, knife]))
}

function card(
  index: Map<string, Knife>,
  id: string,
  fallback: { name?: string; brand?: string } = {},
): ChatKnifeCard {
  const knife = index.get(id)
  if (!knife)
    return {
      id,
      name: fallback.name || id,
      brand: fallback.brand ?? '',
      image: null,
      subtitle: null,
      price: null,
      sold: false,
    }
  const subtitle = [
    knife.specs.bladeMaterial,
    knife.specs.bladeLength,
    knife.specs.modelNumber,
  ]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' · ')
  return {
    id: knife.id,
    name: knife.name,
    brand: knife.brand,
    image: knife.images[0] ?? null,
    subtitle: subtitle || null,
    price: knife.specs.price?.trim() || null,
    sold: knife.sold,
  }
}

function moneyOf(value: unknown): ChatMoney | null {
  const record = asRecord(value)
  const amount = asNumber(record.amount)
  const minor = asNumber(record.minor)
  const currency = asString(record.currency)
  return amount !== null && minor !== null && currency
    ? { amount, minor, currency }
    : null
}

const CHANGE_KINDS = new Set([
  'drop',
  'increase',
  'out_of_stock',
  'back_in_stock',
])

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

/** The step the page draws for a finished tool call. */
export async function buildToolStep(
  name: string,
  rawArgs: unknown,
  result: Json,
): Promise<ChatToolStep> {
  const label = describeToolCall(name, rawArgs)
  const args = asRecord(rawArgs)
  let ui: ChatToolUi | null = null
  let summary = 'Done'

  const knivesUi = async (
    ids: Array<{ id: string; name?: string; brand?: string }>,
    total: number,
  ): Promise<ChatToolUi> => {
    const index = await knifeIndex()
    const seen = new Set<string>()
    const knives: ChatKnifeCard[] = []
    for (const entry of ids) {
      if (!entry.id || seen.has(entry.id)) continue
      seen.add(entry.id)
      knives.push(card(index, entry.id, entry))
      if (knives.length >= UI_MAX_ROWS) break
    }
    return { kind: 'knives', knives, total }
  }
  const summaries = (
    list: unknown,
  ): Array<{ id: string; name: string; brand: string }> =>
    asArray(list).map((item) => {
      const entry = asRecord(item)
      return {
        id: asString(entry.id),
        name: asString(entry.name),
        brand: asString(entry.brand),
      }
    })

  switch (name) {
    case 'search_knives': {
      const total = asNumber(result.total) ?? asArray(result.knives).length
      summary = plural(total, 'result')
      ui = total ? await knivesUi(summaries(result.knives), total) : null
      break
    }
    case 'find_missing_fields': {
      const fields = asArray(result.fields).map(asRecord)
      const total = fields.reduce(
        (sum, field) => sum + (asNumber(field.total) ?? 0),
        0,
      )
      summary = fields
        .map(
          (field) => `${asString(field.field)}: ${asNumber(field.total) ?? 0}`,
        )
        .join(' · ')
      const ids = fields.flatMap((field) => summaries(field.knives))
      ui = ids.length ? await knivesUi(ids, total) : null
      break
    }
    case 'find_duplicates': {
      const candidates = asArray(result.candidates)
      summary = plural(
        asNumber(result.total) ?? candidates.length,
        'possible pair',
      )
      const ids = candidates.flatMap((candidate) =>
        summaries(asRecord(candidate).knives),
      )
      ui = ids.length ? await knivesUi(ids, ids.length) : null
      break
    }
    case 'get_knife': {
      const knife = asRecord(result.knife)
      const id = asString(knife.id)
      summary = [asString(knife.brand), asString(knife.name)]
        .filter(Boolean)
        .join(' ')
      ui = id ? await knivesUi([{ id }], 1) : null
      break
    }
    case 'get_price_history':
    case 'get_price_watch':
    case 'get_knife_maintenance': {
      const id = asString(args.knife_id)
      ui = id ? await knivesUi([{ id }], 1) : null
      const card = ui?.kind === 'knives' ? ui.knives[0] : null
      summary = card
        ? [card.brand, card.name].filter(Boolean).join(' ')
        : 'Done'
      break
    }
    case 'list_price_changes': {
      const events = asArray(result.events).map(asRecord)
      summary = plural(events.length, 'change')
      if (events.length) {
        const index = await knifeIndex()
        const rows: ChatPriceChangeRow[] = events
          .filter((event) => CHANGE_KINDS.has(asString(event.kind)))
          .slice(0, UI_MAX_ROWS)
          .map((event) => ({
            kind: asString(event.kind) as ChatPriceChangeRow['kind'],
            knife: card(index, asString(event.knifeId), {
              name: asString(event.knife),
            }),
            storeName: asString(event.storeName),
            price: moneyOf(event.price),
            previousPrice: moneyOf(event.previousPrice),
            deltaPct: asNumber(event.deltaPct),
            occurredAt: asString(event.occurredAt),
          }))
        ui = { kind: 'priceChanges', rows, total: events.length }
      }
      break
    }
    case 'list_price_watches': {
      const knives = asArray(result.knives).map(asRecord)
      const total = asNumber(result.total) ?? knives.length
      summary = plural(total, 'knife', 'knives')
      if (knives.length) {
        const index = await knifeIndex()
        const rows: ChatPriceWatchRow[] = knives
          .slice(0, UI_MAX_ROWS)
          .map((entry) => ({
            knife: card(index, asString(entry.knifeId), {
              name: asString(entry.knife),
            }),
            state: asString(entry.state),
            bestPrice: moneyOf(entry.bestPrice),
            paid: moneyOf(entry.paid),
            outOfStock: entry.outOfStock === true,
            lastCheckedAt: asString(entry.lastCheckedAt) || null,
          }))
        ui = { kind: 'priceWatches', rows, total }
      }
      break
    }
    default:
      break
  }
  return { name, label, summary: summary || 'Done', ok: true, ui }
}

/** The step for a tool call that failed (bad arguments, unknown knife, …). */
export function failedToolStep(
  name: string,
  rawArgs: unknown,
  message: string,
): ChatToolStep {
  return {
    name,
    label: describeToolCall(name, rawArgs),
    summary: message.length > 160 ? `${message.slice(0, 159)}…` : message,
    ok: false,
    ui: null,
  }
}
