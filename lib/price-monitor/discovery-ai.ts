import * as cheerio from 'cheerio'
import {
  requestJsonCompletion,
  type AiEndpoint,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import { UNTRUSTED_CONTENT_RULE } from '@/lib/price-monitor/ai'
import type { Knife } from '@/lib/data'
import type { AmazonMarketplace } from '@/lib/settings-shared'

/**
 * Other stores, the AI part: AI picks the monitored knife out of a store's
 * search results and then confirms it on the product page. BladeVault only
 * fetches the pages and validates the answers; the matching is the model's.
 */
export const DISCOVERY_MIN_CONFIDENCE = 0.75
export const DISCOVERY_AI_TIMEOUT_MS = 30_000
export const MAX_SEARCH_CANDIDATES = 20

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
export function buildSearchQuery(
  identity: KnifeIdentity,
  options: { modelNumber?: boolean } = {},
): string {
  const words: string[] = []
  const seen = new Set<string>()
  const parts = [identity.brand, identity.name]
  if (options.modelNumber !== false) parts.push(identity.modelNumber ?? '')
  for (const part of parts) {
    for (const word of clean(part ?? '').split(' ')) {
      const key = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      if (!word || (key && seen.has(key))) continue
      if (key) seen.add(key)
      words.push(word)
    }
  }
  return truncate(words.join(' '), 150)
}

/**
 * The searches to try in order: with the model number first, then brand and
 * name only, because store listings often leave the maker's model number out.
 */
export function buildSearchQueries(identity: KnifeIdentity): string[] {
  const queries = [
    buildSearchQuery(identity),
    buildSearchQuery(identity, { modelNumber: false }),
  ].filter(Boolean)
  return [...new Set(queries)]
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

/** One search result as AI sees it. */
export type MatchCandidate = {
  /** 1-based position in what AI sees. */
  id: number
  title: string
  price: string | null
  sponsored: boolean
}

export type SearchCandidate = MatchCandidate & { asin: string }

const ASIN = /^[A-Z0-9]{10}$/
/** Amazon puts the ad label in the title heading: "Sponsored Ad - Corgi V…". */
const SPONSORED_PREFIX = /^Sponsored Ad\s*[-–—]\s*/i

/**
 * A search result's title. Amazon often shows the brand in its own heading
 * ("KIZER") above the product title heading, so every heading is read: the
 * longest one is the title, and the brand goes in front when it is missing.
 */
function amazonResultTitle(
  $: cheerio.CheerioAPI,
  block: ReturnType<cheerio.CheerioAPI>,
): string {
  const headings = block
    .find('h2')
    .toArray()
    .map((el) =>
      clean($(el).attr('aria-label') || $(el).text()).replace(
        SPONSORED_PREFIX,
        '',
      ),
    )
    .filter(Boolean)
  const title = headings.reduce(
    (longest, text) => (text.length > longest.length ? text : longest),
    '',
  )
  if (!title) {
    return clean(
      block.find('[data-cy="title-recipe"]').first().text() ||
        block.find('img.s-image').first().attr('alt') ||
        '',
    )
  }
  const lower = title.toLowerCase()
  const brand = headings.find(
    (text) =>
      text !== title &&
      text.length <= 40 &&
      !lower.includes(text.toLowerCase()),
  )
  return brand ? `${brand} ${title}` : title
}

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
    const title = amazonResultTitle($, block)
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
        ) ||
        block
          .find('h2')
          .toArray()
          .some((el) =>
            SPONSORED_PREFIX.test(
              clean($(el).attr('aria-label') || $(el).text()),
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

/**
 * Why a search page gave AI nothing to read. 'empty': the store's own
 * result list with no products in it, so the store has nothing for the
 * search. 'unreadable': not a result list (a bot check, a sign-in, error or
 * location page) or product cards BladeVault could not read. Only an empty
 * page means the knife is not there.
 */
export type EmptySearchKind = 'empty' | 'unreadable'

/**
 * Amazon's search page keeps its result list when nothing matches ("No
 * results for your search query") and shows products as cards with an
 * ASIN. Other boxes in the list, such as Shop Direct offers from the
 * maker's own site, are not cards.
 */
export function amazonEmptySearchKind(html: string): EmptySearchKind {
  const $ = cheerio.load(html)
  const list = $('[data-component-type="s-search-results"]')
  if (!list.length) return 'unreadable'
  const cards = list
    .find('[data-component-type="s-search-result"], .s-main-slot > [data-asin]')
    .toArray()
    .some((el) => ASIN.test(($(el).attr('data-asin') ?? '').trim()))
  return cards ? 'unreadable' : 'empty'
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
export function parseMatchAnswer<C extends MatchCandidate>(
  answer: unknown,
  candidates: readonly C[],
): AiDecision & { candidate: C | null } {
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

/**
 * The maker's model numbers in a knife's model number field: one or more
 * codes such as "A3105" or "C223GP / C223GPBK". Codes without a digit or
 * shorter than three characters are names, not codes, and are left out.
 */
export function modelNumberCodes(modelNumber: string | undefined): string[] {
  return (modelNumber ?? '')
    .split(/\s*(?:[,;/|]|\bor\b)\s*/i)
    .map((part) => part.trim())
    .filter(
      (part) =>
        /\d/.test(part) && part.replace(/[^\p{L}\p{N}]/gu, '').length >= 3,
    )
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when the page text shows one of the knife's model numbers as a whole
 * code. Spaces, dashes and dots inside the code are ignored ("A-3105" is
 * A3105), but a longer code is another variant: "C223GPBK" is not "C223GP",
 * "SP223GP" is not "C223GP".
 */
export function pageShowsModelNumber(
  modelNumber: string | undefined,
  pageText: string,
): boolean {
  const codes = modelNumberCodes(modelNumber)
  if (!codes.length) return true
  return codes.some((code) => {
    const chars = [...code.replace(/[^\p{L}\p{N}]/gu, '')]
    const pattern = chars.map(escapeRegExp).join('[\\s.\\-]?')
    return new RegExp(
      `(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`,
      'iu',
    ).test(pageText)
  })
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
  'Store titles often leave out the maker’s model number and some specs: a title with the same maker and model name is a match unless it names a different steel, size, lock or version.',
  'Never match sheaths, cases, sharpeners, replacement parts, scales, clips, lots of several knives, knock-offs, "compatible with" items, or a different model of the same maker.',
  UNTRUSTED_CONTENT_RULE,
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
  'When the collection knife has a modelNumber, the product page must show that exact model number (in the title, the details or the item model number). Makers use a different code for each steel, handle and colour variant: a page showing another code, or no code at all, is not the same product.',
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
export async function matchSearchResults<C extends MatchCandidate>(
  input: AiCall & {
    knife: KnifeIdentity
    candidates: readonly C[]
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
      purpose: 'discovery_search',
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
      purpose: 'discovery_verify',
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
