import type { Knife } from '@/lib/data'
import {
  requestJsonCompletion,
  type AiEndpoint,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import {
  aiConfigured,
  AI_FRAGMENT_MAX_BYTES,
  AI_EXTRACTION_TIMEOUT_MS,
  appearsLiterally,
  buildPriceFragment,
} from '@/lib/price-monitor/ai'
import {
  formatMoney,
  normalizeCurrencyCode,
  parseMoneyText,
  toMinorUnits,
} from '@/lib/price-monitor/money'
import type { Availability } from '@/lib/price-monitor/shared'
import type { PriceAiSettings } from '@/lib/settings-shared'

/**
 * AI as quality control: before a reading is trusted for a notification (or
 * an implausible jump is stored), and in Unlimited mode for spot checks of
 * the page parsers, AI looks at the cleaned page and says whether the
 * reading is the current price of exactly this product. AI never supplies
 * a price here: a price it quotes must appear on the page as written, and
 * it only ever explains a rejection.
 */
export const VERIFY_MIN_CONFIDENCE = 0.8
const VERIFY_TIMEOUT_PER_10KB_MS = 2_000
const REASON_MAX_LENGTH = 200

export const VERIFY_ISSUES = [
  'none',
  'different_price',
  'wrong_variant',
  'wrong_currency',
  'bundle',
  'accessory',
  'per_unit',
  'wrong_product',
  'not_current',
  'other',
] as const
export type VerifyIssue = (typeof VERIFY_ISSUES)[number]

/** Why the reading is being checked; changes nothing but the prompt. */
export type VerifyReason = 'notify' | 'implausible' | 'spot_check'

export type VerifyReading = {
  priceMinor: number
  currency: string
  availability: Availability
}

export type VerifyInput = {
  /** Brand, name and key specs; never the purchase price or notes. */
  product: VerifyProduct
  /** The store's host name, e.g. "example-knives.com". */
  host: string
  reading: VerifyReading
  previous: { priceMinor: number; currency: string } | null
  reason: VerifyReason
}

export type VerifyProduct = {
  brand: string
  name: string
  specs: Record<string, string>
}

export type VerifyVerdict =
  | { status: 'confirmed'; confidence: number }
  | {
      status: 'rejected'
      issue: VerifyIssue
      confidence: number
      reason: string
      /** The price AI read on the page, only when it is there as written. */
      pagePrice: string | null
    }
  | { status: 'unsure' }

/** Specs AI may see: what tells variants apart, nothing private. */
const PRODUCT_SPECS = [
  'bladeLength',
  'overallLength',
  'bladeMaterial',
  'bladeThickness',
  'bladeCoating',
  'lockingMechanism',
  'modelNumber',
  'designer',
  'hardness',
  'weight',
] as const

/** The knife as AI may see it: brand, name and key specs only. */
export function verifyProduct(knife: Knife): VerifyProduct {
  const specs: Record<string, string> = {}
  if (knife.bladeStyle?.trim()) specs.bladeStyle = knife.bladeStyle.trim()
  if (knife.handleMaterial?.trim())
    specs.handleMaterial = knife.handleMaterial.trim()
  for (const key of PRODUCT_SPECS) {
    const value = knife.specs[key]
    if (typeof value === 'string' && value.trim())
      specs[key] = value.trim().slice(0, 100)
  }
  return {
    brand: knife.brand.trim().slice(0, 100),
    name: knife.name.trim().slice(0, 200),
    specs,
  }
}

/** Whether AI should check readings before they notify. */
export function confirmChangesActive(settings: PriceAiSettings): boolean {
  return aiConfigured(settings) && settings.confirmChanges
}

/** Whether AI spot-checks the parsers' readings (Unlimited mode only). */
export function spotCheckActive(settings: PriceAiSettings): boolean {
  return (
    aiConfigured(settings) &&
    settings.spotCheck &&
    settings.usage.mode === 'unlimited'
  )
}

export const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'issue', 'pagePrice', 'confidence', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'rejected', 'unsure'] },
    issue: { type: 'string', enum: [...VERIFY_ISSUES] },
    pagePrice: {
      type: ['string', 'null'],
      description:
        'The current price of exactly this product copied as written in the page fragment, or null.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
} as const

const SYSTEM_PROMPT = [
  'You check a price that a personal price-tracking app read from an online store page.',
  'You get the product the user tracks (brand, name, key specs), the store host, the new reading, the previous reading, and a trimmed fragment of the page.',
  'Decide whether the new reading is the current selling price of exactly this product: the same model and variant (blade length, steel, finish, handle), in the stated currency, for one item.',
  'Reject it when the page shows a different current price for the product, when the price belongs to another variant, another product, an accessory, a bundle or set, a per-unit or instalment price, a crossed-out or list price, or when it is in another currency.',
  'Answer with JSON only: {"verdict", "issue", "pagePrice", "confidence", "reason"}.',
  'verdict: confirmed, rejected, or unsure when the page does not tell. issue: none when confirmed, otherwise the main problem (different_price, wrong_variant, wrong_currency, bundle, accessory, per_unit, wrong_product, not_current, other).',
  'pagePrice: the current price of exactly this product copied exactly as written in the fragment, or null. Never make up or compute a price.',
  'confidence: 0 to 1, how sure you are of the verdict. reason: one short sentence for the user.',
].join('\n')

function priceText(minor: number, currency: string): string {
  return formatMoney(minor, currency, 'en-US')
}

/** The user message: the product, the readings and the page fragment. */
export function buildVerifyPrompt(
  input: VerifyInput,
  fragment: string,
): string {
  const context = {
    task:
      input.reason === 'spot_check'
        ? 'spot check of the page parser'
        : input.reason === 'implausible'
          ? 'the price moved far more than usual'
          : 'a price change the user will be notified about',
    product: input.product,
    store: input.host,
    newReading: {
      price: priceText(input.reading.priceMinor, input.reading.currency),
      currency: input.reading.currency,
      availability: input.reading.availability,
    },
    previousReading: input.previous
      ? {
          price: priceText(input.previous.priceMinor, input.previous.currency),
          currency: input.previous.currency,
        }
      : null,
  }
  return `${JSON.stringify(context)}\n\nPage fragment:\n${fragment}`
}

const clean = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Validates the model's answer. Only a confident confirmation or rejection
 * counts; a quoted price must appear in the fragment as written, and a
 * "different price" claim needs such a price that really differs.
 */
export function parseVerifyAnswer(
  answer: unknown,
  fragment: string,
  reading: VerifyReading,
): VerifyVerdict {
  const record =
    answer && typeof answer === 'object' && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)
      : {}
  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? Math.min(1, record.confidence)
      : typeof record.confidence === 'string'
        ? Math.min(1, Number(record.confidence))
        : Number.NaN
  if (!(confidence >= VERIFY_MIN_CONFIDENCE)) return { status: 'unsure' }
  if (record.verdict === 'confirmed') return { status: 'confirmed', confidence }
  if (record.verdict !== 'rejected') return { status: 'unsure' }

  const issue: VerifyIssue = (VERIFY_ISSUES as readonly unknown[]).includes(
    record.issue,
  )
    ? (record.issue as VerifyIssue)
    : 'other'
  const rawPrice =
    typeof record.pagePrice === 'string'
      ? record.pagePrice.trim().slice(0, 40)
      : typeof record.pagePrice === 'number' &&
          Number.isFinite(record.pagePrice)
        ? String(record.pagePrice)
        : ''
  // A price AI quotes must be on the page; it is only ever shown, not stored.
  const pagePrice =
    rawPrice && appearsLiterally(rawPrice, fragment) ? rawPrice : null
  if (issue === 'different_price') {
    if (!pagePrice) return { status: 'unsure' }
    const parsed = parseMoneyText(pagePrice, reading.currency)
    const currency = normalizeCurrencyCode(parsed?.currency) || reading.currency
    if (
      parsed &&
      currency === reading.currency &&
      toMinorUnits(parsed.amount, currency) === reading.priceMinor
    )
      // It quotes the very price it calls wrong.
      return { status: 'unsure' }
  }
  const reason =
    typeof record.reason === 'string'
      ? clean(record.reason).slice(0, REASON_MAX_LENGTH)
      : ''
  return { status: 'rejected', issue, confidence, reason, pagePrice }
}

export type VerifyResult = VerifyVerdict & { fragmentBytes: number }

/**
 * Asks the model whether a reading is right. Throws AiClientError for
 * configuration, network and endpoint problems, and with code 'budget' when
 * the daily AI budget refuses the request.
 */
export async function verifyReadingWithAi(
  input: VerifyInput & {
    html: string
    endpoint: AiEndpoint
    model: string
    maxFragmentBytes?: number
    signal?: AbortSignal
    fetchImpl?: FetchLike
    timeoutMs?: number
  },
): Promise<VerifyResult> {
  const fragment = buildPriceFragment(
    input.html,
    input.maxFragmentBytes ?? AI_FRAGMENT_MAX_BYTES,
  )
  if (!fragment.trim()) return { status: 'unsure', fragmentBytes: 0 }
  const fragmentBytes = Buffer.byteLength(fragment, 'utf8')
  const answer = await requestJsonCompletion(
    input.endpoint,
    {
      model: input.model,
      system: SYSTEM_PROMPT,
      user: buildVerifyPrompt(input, fragment),
      schemaName: 'price_verification',
      purpose: 'verify',
      schema: VERIFY_SCHEMA,
      maxTokens: 300,
    },
    {
      timeoutMs:
        input.timeoutMs ??
        AI_EXTRACTION_TIMEOUT_MS +
          Math.ceil(fragmentBytes / 10_240) * VERIFY_TIMEOUT_PER_10KB_MS,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    },
  )
  return {
    ...parseVerifyAnswer(answer, fragment, input.reading),
    fragmentBytes,
  }
}

const ISSUE_TEXT: Record<VerifyIssue, string> = {
  none: 'the reading looks wrong',
  different_price: 'the page shows a different price',
  wrong_variant: 'the price belongs to another variant',
  wrong_currency: 'the price is in another currency',
  bundle: 'the price is for a bundle or set',
  accessory: 'the price is for an accessory or another item',
  per_unit: 'the price is per unit or an instalment',
  wrong_product: 'the page is for another product',
  not_current: 'the price is not the current one',
  other: 'the reading looks wrong',
}

/** One sentence for the check log about a rejection. */
export function describeRejection(
  verdict: Extract<VerifyVerdict, { status: 'rejected' }>,
): string {
  const parts = [ISSUE_TEXT[verdict.issue]]
  if (verdict.pagePrice) parts.push(`the page shows ${verdict.pagePrice}`)
  const summary = parts.join('; ')
  return verdict.reason ? `${summary} (${verdict.reason})` : summary
}
