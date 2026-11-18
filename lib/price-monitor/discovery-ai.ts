import * as cheerio from 'cheerio'
import {
  requestJsonCompletion,
  type AiEndpoint,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import type { Knife } from '@/lib/data'
import type { AmazonMarketplace } from '@/lib/settings-shared'

/**
 * Other stores, the AI part: AI picks the monitored knife out of a store's
 * search results and then confirms it on the product page. BladeVault only
 * fetches the pages and validates the answers; the matching is the model's.
 */
export const DISCOVERY_MIN_CONFIDENCE = 0.75
export const DISCOVERY_AI_TIMEOUT_MS = 30_000
export const MAX_SEARCH_CANDIDATES = 12

const TITLE_MAX = 250
const PRODUCT_DETAILS_MAX = 2500

const clean = (value: string) =>
  value.replace(/[‎‏ ]/g, ' ').replace(/\s+/g, ' ').trim()

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value

/** What AI is told about the knife: identity and specs, never notes or prices paid. */
export type KnifeIdentity = {
  brand: string
  name: string
  modelNumber?: string
  designer?: string
  bladeLength?: string
  bladeMaterial?: string
  bladeStyle?: string
  handleMaterial?: string
  lockingMechanism?: string
  overallLength?: string
}

export function knifeIdentity(knife: Knife): KnifeIdentity {
  const identity: KnifeIdentity = {
    brand: clean(knife.brand),
    name: clean(knife.name),
  }
  const optional: Array<[keyof KnifeIdentity, string | undefined]> = [
    ['modelNumber', knife.specs.modelNumber],
    ['designer', knife.specs.designer],
    ['bladeLength', knife.specs.bladeLength],
    ['bladeMaterial', knife.specs.bladeMaterial],
    ['bladeStyle', knife.bladeStyle],
    ['handleMaterial', knife.handleMaterial],
    ['lockingMechanism', knife.specs.lockingMechanism],
    ['overallLength', knife.specs.overallLength],
  ]
  for (const [key, value] of optional) {
    const text = clean(value ?? '')
    if (text) identity[key] = truncate(text, 120)
  }
  return identity
}

/**
 * The search words: brand, name and model number without repeated words,
 * e.g. "Spyderco Para 3 C223GP" for name "Para 3" and brand "Spyderco".
 */
export function buildSearchQuery(identity: KnifeIdentity): string {
  const words: string[] = []
  const seen = new Set<string>()
  for (const part of [identity.brand, identity.name, identity.modelNumber]) {
    for (const word of clean(part ?? '').split(' ')) {
      const key = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      if (!word || (key && seen.has(key))) continue
      if (key) seen.add(key)
      words.push(word)
    }
  }
  return truncate(words.join(' '), 150)
}

export function amazonSearchUrl(
  marketplace: AmazonMarketplace,
  query: string,
): string {
  const url = new URL(`https://www.${marketplace}/s`)
  url.searchParams.set('k', query)
  return url.toString()
}

export function amazonProductUrl(
  marketplace: AmazonMarketplace,
  asin: string,
): string {
  return `https://www.${marketplace}/dp/${asin}`
}

export type SearchCandidate = {
  /** 1-based position in what AI sees. */
  id: number
  asin: string
  title: string
  price: string | null
  sponsored: boolean
}

const ASIN = /^[A-Z0-9]{10}$/

/**
 * Products on an Amazon search results page: ASIN, title, shown price and
 * whether it is an ad. Falls back to product links when the result blocks
 * are missing (other layouts).
 */
export function parseAmazonSearchResults(html: string): SearchCandidate[] {
  const $ = cheerio.load(html)
  const found: Omit<SearchCandidate, 'id'>[] = []
  const seen = new Set<string>()
  $('[data-component-type="s-search-result"][data-asin]').each((_, el) => {
    const block = $(el)
    const asin = (block.attr('data-asin') ?? '').trim().toUpperCase()
    if (!ASIN.test(asin) || seen.has(asin)) return
    const title = clean(
      block.find('h2').first().text() ||
        block.find('[data-cy="title-recipe"]').first().text(),
    )
    if (!title) return
    const price = clean(
      block.find('.a-price:not(.a-text-price) .a-offscreen').first().text(),
    )
    seen.add(asin)
    found.push({
      asin,
      title: truncate(title, TITLE_MAX),
      price: price || null,
      sponsored:
        /\bSponsored\b|\bGesponsert\b|\bSponsorisé\b|\bPatrocinado\b/i.test(
          clean(
            block
              .find(
                '.puis-label-popover, .s-label-popover-default, .a-color-secondary',
              )
              .text(),
          ),
        ),
    })
  })
  if (!found.length) {
    $('a[href*="/dp/"]').each((_, el) => {
      const href = $(el).attr('href') ?? ''
      const asin = href
        .match(/\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]
        ?.toUpperCase()
      const title = clean($(el).text())
      if (!asin || seen.has(asin) || title.length < 12) return
      seen.add(asin)
      found.push({
        asin,
        title: truncate(title, TITLE_MAX),
        price: null,
        sponsored: false,
      })
    })
  }
  return found
    .slice(0, MAX_SEARCH_CANDIDATES)
    .map((candidate, index) => ({ ...candidate, id: index + 1 }))
}

export type AiDecision = {
  accepted: boolean
  confidence: number
  reason: string
}

function readConfidence(value: unknown): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0
}

function readReason(value: unknown): string {
  return typeof value === 'string' ? truncate(clean(value), 200) : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The candidate AI chose, only when it is one of the listed ones and AI is sure. */
export function parseMatchAnswer(
  answer: unknown,
  candidates: readonly SearchCandidate[],
): AiDecision & { candidate: SearchCandidate | null } {
  const record = asRecord(answer)
  const confidence = readConfidence(record.confidence)
  const reason = readReason(record.reason)
  const id =
    typeof record.match === 'number'
      ? record.match
      : typeof record.match === 'string' && /^\d+$/.test(record.match.trim())
        ? Number(record.match.trim())
        : null
  const candidate =
    id === null ? null : (candidates.find((item) => item.id === id) ?? null)
  const accepted = Boolean(candidate) && confidence >= DISCOVERY_MIN_CONFIDENCE
  return {
    accepted,
    confidence,
    reason,
    candidate: accepted ? candidate : null,
  }
}

export function parseVerifyAnswer(answer: unknown): AiDecision {
  const record = asRecord(answer)
  const confidence = readConfidence(record.confidence)
  return {
    accepted:
      record.same_product === true && confidence >= DISCOVERY_MIN_CONFIDENCE,
    confidence,
    reason: readReason(record.reason),
  }
}

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['match', 'confidence', 'reason'],
  properties: {
    match: {
      type: ['integer', 'null'],
      description: 'The id of the matching search result, or null.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', description: 'One short sentence.' },
  },
} as const

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['same_product', 'confidence', 'reason'],
  properties: {
    same_product: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', description: 'One short sentence.' },
  },
} as const

const MATCHING_RULES = [
  'The same knife means the same maker and the same model.',
  'A different blade steel, blade length, blade shape or lock is a different knife.',
  'A different handle colour or finish of the same model counts as the same knife only when the collection knife does not name its handle or finish.',
  'Never match sheaths, cases, sharpeners, replacement parts, scales, clips, lots of several knives, knock-offs, "compatible with" items, or a different model of the same maker.',
].join('\n')

const MATCH_SYSTEM = [
  'You find a knife from a collector’s collection in a store’s search results.',
  MATCHING_RULES,
  'Sponsored results are ads; they can still be the right product.',
  'Answer with JSON only: {"match", "confidence", "reason"}.',
  'match: the id of the result that sells exactly this knife, or null when none does.',
  'confidence: 0 to 1, how sure you are. reason: one short sentence.',
].join('\n')

const VERIFY_SYSTEM = [
  'You check whether a store’s product page sells a specific knife from a collector’s collection.',
  MATCHING_RULES,
  'Answer with JSON only: {"same_product", "confidence", "reason"}.',
  'same_product: true only when the page sells exactly this knife.',
  'confidence: 0 to 1, how sure you are. reason: one short sentence.',
].join('\n')

type AiCall = {
  endpoint: AiEndpoint
  model: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

/** Asks AI which search result is the knife. Throws AiClientError. */
export async function matchSearchResults(
  input: AiCall & {
    knife: KnifeIdentity
    candidates: readonly SearchCandidate[]
  },
) {
  const answer = await requestJsonCompletion(
    input.endpoint,
    {
      model: input.model,
      system: MATCH_SYSTEM,
      user: JSON.stringify({
        knife: input.knife,
        results: input.candidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          price: candidate.price,
          sponsored: candidate.sponsored,
        })),
      }),
      schemaName: 'search_match',
      schema: MATCH_SCHEMA,
      maxTokens: 200,
    },
    {
      timeoutMs: DISCOVERY_AI_TIMEOUT_MS,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    },
  )
  return parseMatchAnswer(answer, input.candidates)
}

export type ProductPageDetails = {
  title: string
  details: string
}

/** Asks AI whether the product page sells the knife. Throws AiClientError. */
export async function verifyProductPage(
  input: AiCall & { knife: KnifeIdentity; page: ProductPageDetails },
): Promise<AiDecision> {
  const answer = await requestJsonCompletion(
    input.endpoint,
    {
      model: input.model,
      system: VERIFY_SYSTEM,
      user: JSON.stringify({
        knife: input.knife,
        product_page: {
          title: truncate(input.page.title, TITLE_MAX),
          details: truncate(input.page.details, PRODUCT_DETAILS_MAX),
        },
      }),
      schemaName: 'product_check',
      schema: VERIFY_SCHEMA,
      maxTokens: 200,
    },
    {
      timeoutMs: DISCOVERY_AI_TIMEOUT_MS,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    },
  )
  return parseVerifyAnswer(answer)
}
