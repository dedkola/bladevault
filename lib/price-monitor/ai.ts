import * as cheerio from 'cheerio'
import {
  AiClientError,
  requestJsonCompletion,
  type AiEndpoint,
  type AiPurpose,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import { MAX_PRICE_MAJOR } from '@/lib/price-monitor/detect'
import {
  normalizeCurrencyCode,
  parseMoneyText,
} from '@/lib/price-monitor/money'
import {
  normalizeAvailability,
  OFFER_AVAILABILITIES,
  type ExtractedOffer,
  type OfferAvailability,
} from '@/lib/scrape-offer'
import type { PriceAiSettings } from '@/lib/settings-shared'

/**
 * AI extraction fallback: when the page parsers find no price, a trimmed
 * fragment of the page (title, JSON-LD, price-like elements) is sent to an
 * OpenAI-compatible model. The answer must quote the price exactly as it
 * appears in the fragment and be confident, and then goes through the same
 * validation as any other reading.
 */
export const AI_FRAGMENT_MAX_BYTES = 8 * 1024
export const AI_EXTRACTION_TIMEOUT_MS = 20_000
/** Extra time per 10 KB of page sent, for large-context models. */
const AI_TIMEOUT_PER_10KB_MS = 2_000
export const AI_MIN_CONFIDENCE = 0.7
/** Unlimited mode: the wait for a source that keeps failing. */
export const AI_SOURCE_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** Unlimited mode: failed checks in a row before a source waits for AI. */
export const AI_FAILURES_BEFORE_COOLDOWN = 3

const HINT_PATTERN = /price|offer|availability|stock|cart/i
const CHUNK_MAX_BYTES = 1500
const JSON_LD_MAX_BYTES = 3000
const MAX_MATCHES = 60
const KEPT_ATTRIBUTES = new Set([
  'class',
  'id',
  'itemprop',
  'itemtype',
  'content',
  'value',
  'aria-label',
])

/** The parts of a parsed DOM node this module reads (domhandler's shape). */
type DomNode = {
  type: string
  name?: string
  parent: DomNode | null
  attribs?: Record<string, string>
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/** Cuts text to at most `max` UTF-8 bytes without splitting a character. */
function truncateBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text
  let result = text.slice(0, max)
  while (bytes(result) > max) result = result.slice(0, -1)
  return result
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

function hintAttributes(element: DomNode): boolean {
  const attributes = element.attribs ?? {}
  return ['class', 'id', 'itemprop', 'data-testid'].some((name) =>
    HINT_PATTERN.test(attributes[name] ?? ''),
  )
}

/**
 * The page reduced to what can hold the product's price: title and main
 * heading, price/availability meta tags, JSON-LD blocks and elements whose
 * class, id or itemprop mention price, offer, availability, stock or cart
 * (with their parent for context). Scripts, styles and most attributes are
 * removed. At most `maxBytes` UTF-8 bytes.
 *
 * With a budget above AI_FRAGMENT_MAX_BYTES (large-context models) the
 * price elements may be larger and come first, followed by the rest of the
 * cleaned page (`Page:`) until the budget is used.
 */
export function buildPriceFragment(
  html: string,
  maxBytes = AI_FRAGMENT_MAX_BYTES,
): string {
  const large = maxBytes > AI_FRAGMENT_MAX_BYTES
  const chunkMax = large
    ? Math.max(CHUNK_MAX_BYTES, Math.floor(maxBytes / 16))
    : CHUNK_MAX_BYTES
  const jsonLdMax = large
    ? Math.max(JSON_LD_MAX_BYTES, Math.floor(maxBytes / 8))
    : JSON_LD_MAX_BYTES
  const maxMatches = large ? MAX_MATCHES * 4 : MAX_MATCHES
  const $ = cheerio.load(html)
  const parts: string[] = []
  let used = 0
  const push = (text: string, limit = chunkMax) => {
    const chunk = truncateBytes(squash(text), limit)
    if (!chunk) return
    const cost = bytes(chunk) + 1
    if (used + cost > maxBytes) {
      const room = maxBytes - used - 1
      if (room > 40) {
        parts.push(truncateBytes(chunk, room))
        used = maxBytes
      }
      return
    }
    parts.push(chunk)
    used += cost
  }

  const title = squash($('title').first().text())
  if (title) push(`Title: ${title}`, 300)
  const heading = squash($('h1').first().text())
  if (heading && heading !== title) push(`Heading: ${heading}`, 300)

  $('meta').each((_, element) => {
    const attributes = (element as unknown as DomNode).attribs ?? {}
    const name =
      attributes.property ?? attributes.name ?? attributes.itemprop ?? ''
    const content = attributes.content ?? ''
    if (/price|currency|availability/i.test(name) && content)
      push(`<meta ${name}="${content}">`, 200)
  })

  $('script[type="application/ld+json"]').each((_, element) => {
    const text = $(element).text()
    if (/offer|price/i.test(text)) push(`JSON-LD: ${text}`, jsonLdMax)
  })

  $('script, style, noscript, svg, iframe, template, link, meta').remove()

  const html$ = (node: DomNode) => $.html(node as never) ?? ''
  const chosen: DomNode[] = []
  const isInside = (node: DomNode) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (chosen.includes(parent)) return true
    return false
  }
  const matches = ($('body *').toArray() as unknown as DomNode[])
    .filter(hintAttributes)
    .slice(0, maxMatches)
  for (const element of matches) {
    if (chosen.includes(element) || isInside(element)) continue
    const parent = element.parent
    // One parent of context, unless it is the page itself or too large.
    const context =
      parent &&
      parent.type === 'tag' &&
      parent.name !== 'body' &&
      !isInside(parent) &&
      bytes(html$(parent)) <= chunkMax * 2
        ? parent
        : element
    if (chosen.includes(context)) continue
    // A wider context replaces matches already inside it.
    for (let index = chosen.length - 1; index >= 0; index--) {
      let node = chosen[index].parent
      while (node && node !== context) node = node.parent
      if (node === context) chosen.splice(index, 1)
    }
    chosen.push(context)
  }
  for (const element of chosen) {
    $(element as never)
      .find('*')
      .addBack()
      .each((_, node) => {
        const attributes = (node as unknown as DomNode).attribs
        if (!attributes) return
        for (const name of Object.keys(attributes))
          if (!KEPT_ATTRIBUTES.has(name) && !/^data-.*price/i.test(name))
            delete attributes[name]
      })
    push(html$(element))
    if (used >= maxBytes) break
  }

  // Large budgets: the rest of the page, without comments and attributes
  // that cannot hold a price.
  if (large && used < maxBytes) {
    $('*')
      .contents()
      .filter((_, node) => (node as unknown as DomNode).type === 'comment')
      .remove()
    $('body')
      .find('*')
      .each((_, node) => {
        const attributes = (node as unknown as DomNode).attribs
        if (!attributes) return
        for (const name of Object.keys(attributes))
          if (!KEPT_ATTRIBUTES.has(name) && !/^data-.*price/i.test(name))
            delete attributes[name]
      })
    const body = $('body').html() ?? ''
    push(`Page: ${body}`, maxBytes)
  }
  return parts.join('\n')
}

/** A price string that appears in the fragment as written, not inside a longer number. */
export function appearsLiterally(price: string, fragment: string): boolean {
  const normalize = (text: string) =>
    text.replace(/[   ]/g, ' ').replace(/\s+/g, ' ')
  const needle = normalize(price).trim()
  if (!needle || !/\d/.test(needle)) return false
  const haystack = normalize(fragment)
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    const before = haystack[index - 1] ?? ''
    const after = haystack[index + needle.length] ?? ''
    const digitBefore =
      /^\d/.test(needle) &&
      (/\d/.test(before) ||
        // "129.00" must not match "1,129.00".
        (/[.,]/.test(before) && /\d/.test(haystack[index - 2] ?? '')))
    const digitAfter =
      /\d/.test(after) ||
      // "129" must not match "129.99" or "129,99".
      (/\d$/.test(needle) &&
        /[.,]/.test(after) &&
        /\d/.test(haystack[index + needle.length + 1] ?? ''))
    if (!digitBefore && !digitAfter) return true
    index = haystack.indexOf(needle, index + 1)
  }
  return false
}

export type AiAnswerRejection =
  'not_found' | 'low_confidence' | 'not_in_page' | 'invalid_price'

export type AiAnswerResult =
  | { status: 'ok'; offer: ExtractedOffer; confidence: number }
  | { status: 'rejected'; reason: AiAnswerRejection }

function toAvailability(value: unknown): OfferAvailability {
  if (
    typeof value === 'string' &&
    (OFFER_AVAILABILITIES as readonly string[]).includes(value)
  )
    return value as OfferAvailability
  return normalizeAvailability(value)
}

/**
 * Validates the model's answer against the fragment it was given: a price
 * is required, must appear literally, must parse to a sane amount, and the
 * confidence must be at least 0.7.
 */
export function parseAiOfferAnswer(
  answer: unknown,
  fragment: string,
  currencyHint = '',
): AiAnswerResult {
  const record =
    answer && typeof answer === 'object' && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)
      : {}
  const rawPrice =
    typeof record.price === 'number' && Number.isFinite(record.price)
      ? String(record.price)
      : typeof record.price === 'string'
        ? record.price.trim()
        : ''
  if (!rawPrice || rawPrice.length > 40)
    return { status: 'rejected', reason: 'not_found' }
  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? record.confidence
      : typeof record.confidence === 'string'
        ? Number(record.confidence)
        : Number.NaN
  if (!(confidence >= AI_MIN_CONFIDENCE))
    return { status: 'rejected', reason: 'low_confidence' }
  if (!appearsLiterally(rawPrice, fragment))
    return { status: 'rejected', reason: 'not_in_page' }
  const answeredCurrency = normalizeCurrencyCode(record.currency)
  const parsed = parseMoneyText(rawPrice, answeredCurrency)
  if (
    !parsed ||
    !Number.isFinite(parsed.amount) ||
    parsed.amount <= 0 ||
    parsed.amount >= MAX_PRICE_MAJOR
  )
    return { status: 'rejected', reason: 'invalid_price' }
  return {
    status: 'ok',
    confidence: Math.min(1, confidence),
    offer: {
      amount: parsed.amount,
      currency:
        normalizeCurrencyCode(parsed.currency) ||
        normalizeCurrencyCode(currencyHint),
      availability: toAvailability(record.availability),
      method: 'ai',
    },
  }
}

export const AI_OFFER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['price', 'currency', 'availability', 'confidence'],
  properties: {
    price: {
      type: ['string', 'null'],
      description:
        'The current selling price exactly as written in the page text, or null.',
    },
    currency: {
      type: ['string', 'null'],
      description: 'ISO 4217 code such as USD or EUR, or null.',
    },
    availability: {
      type: 'string',
      enum: [...OFFER_AVAILABILITIES],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const

const SYSTEM_PROMPT = [
  'You read the current selling price of the one product a store page sells.',
  'The input is a trimmed fragment of the page.',
  'Answer with JSON only: {"price", "currency", "availability", "confidence"}.',
  'price: the price copied exactly as it is written in the fragment (for example "$129.99" or "129,99 €"), or null when there is none.',
  'Ignore crossed-out or list prices, prices of other or related products, shipping costs and instalments.',
  'currency: ISO 4217 code or null. availability: in_stock, limited, preorder, out_of_stock or unknown.',
  'confidence: 0 to 1, how sure you are that this is the current price of the main product.',
].join('\n')

export type AiExtractionResult =
  | (AiAnswerResult & { fragmentBytes: number })
  | { status: 'skipped'; reason: 'empty_page' }

/**
 * Asks the model for the price on a page. Throws AiClientError for
 * configuration, network and endpoint problems.
 */
export async function extractOfferWithAi(input: {
  html: string
  endpoint: AiEndpoint
  model: string
  currencyHint?: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Recorded in the AI call journal; scheduled checks use 'extraction'. */
  purpose?: AiPurpose
  /** How much of the page to send (settings' maxPageKb); 8 KB by default. */
  maxFragmentBytes?: number
}): Promise<AiExtractionResult> {
  const fragment = buildPriceFragment(
    input.html,
    input.maxFragmentBytes ?? AI_FRAGMENT_MAX_BYTES,
  )
  if (!fragment.trim()) return { status: 'skipped', reason: 'empty_page' }
  const answer = await requestJsonCompletion(
    input.endpoint,
    {
      model: input.model,
      system: SYSTEM_PROMPT,
      user: `Page fragment:\n${fragment}`,
      schemaName: 'product_offer',
      purpose: input.purpose ?? 'extraction',
      schema: AI_OFFER_SCHEMA,
      maxTokens: 200,
    },
    {
      timeoutMs:
        input.timeoutMs ??
        AI_EXTRACTION_TIMEOUT_MS +
          Math.ceil(Buffer.byteLength(fragment, 'utf8') / 10_240) *
            AI_TIMEOUT_PER_10KB_MS,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    },
  )
  return {
    ...parseAiOfferAnswer(answer, fragment, input.currencyHint),
    fragmentBytes: Buffer.byteLength(fragment, 'utf8'),
  }
}

/** AI is configured enough to try (the key is checked separately). */
export function aiConfigured(settings: PriceAiSettings): boolean {
  return Boolean(settings.enabled && settings.baseUrl && settings.model)
}

/**
 * How long a source waits between AI attempts. Limited: the configured
 * hours. Unlimited: no wait, unless the source failed several checks in a
 * row (then a day, so AI does not spend itself on a page that is gone).
 */
export function aiSourceCooldownMs(
  settings: PriceAiSettings,
  consecutiveFailures = 0,
): number {
  if (settings.usage.mode === 'unlimited')
    return consecutiveFailures >= AI_FAILURES_BEFORE_COOLDOWN
      ? AI_SOURCE_COOLDOWN_MS
      : 0
  return settings.usage.sourceCooldownHours * 60 * 60 * 1000
}

/** Whether a source's wait since its last AI attempt is over. */
export function aiSourceReady(input: {
  settings: PriceAiSettings
  lastAiAt: string | null
  now: number
  consecutiveFailures?: number
}): boolean {
  if (!input.lastAiAt) return true
  const last = Date.parse(input.lastAiAt)
  return (
    !Number.isFinite(last) ||
    input.now - last >=
      aiSourceCooldownMs(input.settings, input.consecutiveFailures)
  )
}

/** Whether a source may use the AI fallback now. */
export function aiFallbackAllowed(input: {
  settings: PriceAiSettings
  lastAiAt: string | null
  now: number
  consecutiveFailures?: number
}): boolean {
  if (!aiConfigured(input.settings) || !input.settings.extractionFallback)
    return false
  return aiSourceReady(input)
}

export { AiClientError }
