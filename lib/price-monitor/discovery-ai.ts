import {
  requestJsonCompletion,
  type AiEndpoint,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import { UNTRUSTED_CONTENT_RULE } from '@/lib/price-monitor/ai'
import type { Knife } from '@/lib/data'

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

/** One search result as AI sees it. */
export type MatchCandidate = {
  /** 1-based position in what AI sees. */
  id: number
  title: string
  price: string | null
}

export type AiDecision = {
  accepted: boolean
  confidence: number
  reason: string
}

/** At most this many other variants are kept per knife and store. */
export const MAX_RELATED_VARIANTS = 5

/** What a product page sells, as AI reads it. */
export const PRODUCT_KINDS = ['knife', 'accessory', 'bundle', 'other'] as const
export type ProductKind = (typeof PRODUCT_KINDS)[number]

export type VerifyDecision = AiDecision & {
  /** Null when AI did not say (an older answer without the field). */
  kind: ProductKind | null
  /**
   * The same maker and model, possibly in another variant (steel, handle,
   * colour): a related listing, not the knife itself.
   */
  sameModel: boolean
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

function readCandidateId(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim()))
    return Number(value.trim())
  return null
}

/**
 * The candidate AI chose, only when it is one of the listed ones and AI is
 * sure, and the listed results AI named as other variants of the same model
 * (never the chosen one, at most MAX_RELATED_VARIANTS).
 */
export function parseMatchAnswer<C extends MatchCandidate>(
  answer: unknown,
  candidates: readonly C[],
): AiDecision & { candidate: C | null; variants: C[] } {
  const record = asRecord(answer)
  const confidence = readConfidence(record.confidence)
  const reason = readReason(record.reason)
  const id = readCandidateId(record.match)
  const candidate =
    id === null ? null : (candidates.find((item) => item.id === id) ?? null)
  const accepted = Boolean(candidate) && confidence >= DISCOVERY_MIN_CONFIDENCE
  const chosen = accepted ? candidate : null
  const variants: C[] = []
  for (const value of Array.isArray(record.variants) ? record.variants : []) {
    const variantId = readCandidateId(value)
    const variant = candidates.find((item) => item.id === variantId)
    if (!variant || variant === chosen || variants.includes(variant)) continue
    variants.push(variant)
    if (variants.length >= MAX_RELATED_VARIANTS) break
  }
  return { accepted, confidence, reason, candidate: chosen, variants }
}

export function parseVerifyAnswer(answer: unknown): VerifyDecision {
  const record = asRecord(answer)
  const confidence = readConfidence(record.confidence)
  const kind = PRODUCT_KINDS.find((item) => item === record.kind) ?? null
  return {
    accepted:
      record.same_product === true && confidence >= DISCOVERY_MIN_CONFIDENCE,
    confidence,
    reason: readReason(record.reason),
    kind,
    sameModel: record.same_model === true,
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

/** The knife has a maker's code, so the code on a page decides the match. */
export function hasModelNumberCode(identity: KnifeIdentity): boolean {
  return modelNumberCodes(identity.modelNumber).length > 0
}

/** Search results whose title shows the knife's exact model number. */
export function resultsShowingModelNumber<C extends MatchCandidate>(
  identity: KnifeIdentity,
  candidates: readonly C[],
): C[] {
  if (!hasModelNumberCode(identity)) return []
  return candidates.filter((candidate) =>
    pageShowsModelNumber(identity.modelNumber, candidate.title),
  )
}

/**
 * Whether a product page is the collection knife:
 * - With a model number, the exact code on the page decides: it is the knife
 *   unless AI says the page sells an accessory, a part or a bundle. AI's
 *   view of secondary specs (blade shape, handle) no longer vetoes it.
 * - Without a model number, AI's product check decides, as before.
 * A knife page of the same maker and model that is not the knife is a
 * related variant.
 */
export function judgeProductPage(
  identity: KnifeIdentity,
  pageText: string,
  verdict: VerifyDecision,
): 'match' | 'variant' | 'other' {
  const kind = verdict.kind ?? null
  if (kind !== null && kind !== 'knife') return 'other'
  if (hasModelNumberCode(identity)) {
    if (pageShowsModelNumber(identity.modelNumber, pageText))
      return kind === 'knife' || verdict.accepted ? 'match' : 'other'
  } else if (verdict.accepted) {
    return 'match'
  }
  return verdict.sameModel && kind === 'knife' ? 'variant' : 'other'
}

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['match', 'variants', 'confidence', 'reason'],
  properties: {
    match: {
      type: ['integer', 'null'],
      description: 'The id of the matching search result, or null.',
    },
    variants: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Ids of results that are the same maker and model in another variant (steel, handle, colour, finish); knives only.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', description: 'One short sentence.' },
  },
} as const

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['same_product', 'same_model', 'kind', 'confidence', 'reason'],
  properties: {
    same_product: { type: 'boolean' },
    same_model: { type: 'boolean' },
    kind: { type: 'string', enum: [...PRODUCT_KINDS] },
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
  'A result whose title shows the collection knife’s exact model number is this knife unless it is a sheath, part, accessory or bundle.',
  'Answer with JSON only: {"match", "variants", "confidence", "reason"}.',
  'match: the id of the result that sells exactly this knife, or null when none does.',
  'variants: ids of other results that sell the same maker’s same model in another variant (another steel, handle, colour, finish or model code); knives only, never the match itself. An empty list when there are none.',
  'confidence: 0 to 1, how sure you are. reason: one short sentence.',
].join('\n')

const VERIFY_SYSTEM = [
  'You check whether a store’s product page sells a specific knife from a collector’s collection.',
  MATCHING_RULES,
  'When the collection knife has a modelNumber, the product page must show that exact model number (in the title, the details or the item model number). Makers use a different code for each steel, handle and colour variant: a page showing another code, or no code at all, is not the same product. A page that shows the exact model number is the same product even when its description words a spec differently.',
  'Answer with JSON only: {"same_product", "same_model", "kind", "confidence", "reason"}.',
  'same_product: true only when the page sells exactly this knife.',
  'same_model: true when the page sells the same maker’s same model, also in another variant (steel, handle, colour, finish, model code).',
  'kind: what the page sells: "knife" (one knife), "accessory" (sheath, case, part, scales, clip, sharpener), "bundle" (several items or a set) or "other".',
  'confidence: 0 to 1, how sure you are about same_product. reason: one short sentence.',
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
        })),
      }),
      schemaName: 'search_match',
      purpose: 'discovery_search',
      schema: MATCH_SCHEMA,
      maxTokens: 300,
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
): Promise<VerifyDecision> {
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
      maxTokens: 300,
    },
    {
      timeoutMs: DISCOVERY_AI_TIMEOUT_MS,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    },
  )
  return parseVerifyAnswer(answer)
}
