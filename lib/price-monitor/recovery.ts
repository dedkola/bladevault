import * as cheerio from 'cheerio'
import type { Knife } from '@/lib/data'
import { getLocalDb } from '@/lib/local-db'
import type { AiEndpoint, FetchLike } from '@/lib/price-monitor/ai-client'
import {
  buildSearchQueries,
  knifeIdentity,
  modelNumberCodes,
  pageShowsModelNumber,
  verifyProductPage,
} from '@/lib/price-monitor/discovery-ai'
import { genericProductDetails } from '@/lib/price-monitor/discovery-stores'
import { normalizeSourceUrl } from '@/lib/price-monitor/shared'
import { relinkSourceRow, readSource } from '@/lib/price-monitor/store'
import type { SolverSearch } from '@/lib/price-monitor/solver'
import { getStorage } from '@/lib/storage'
import { reportSystemMessage } from '@/lib/system-message-store'
import { withVaultWrite } from '@/lib/vault-access'

/**
 * AI recovery for product pages that moved, are gone, or show another
 * variant. The pure helpers here decide what a page is; the engine decides
 * when AI may work on it (price-monitor/engine).
 *
 * Rules that never change: AI stays on the store's own site, never buys,
 * signs in or solves a bot check, and a new link is applied without asking
 * only when the collector allowed it and the page shows the knife's exact
 * model number. Every price it finds passes the usual checks.
 */

// ------------------------------------------------------------ page kinds

const PRODUCT_LD = /"@type"\s*:\s*(\[[^\]]*)?"Product"/i

/** The page describes one product (structured data or product markup). */
export function looksLikeProductPage(html: string): boolean {
  if (PRODUCT_LD.test(html)) return true
  const $ = cheerio.load(html)
  return Boolean(
    $('meta[property="og:type"]')
      .attr('content')
      ?.match(/product/i) ||
    $('[itemtype*="schema.org/Product" i]').length ||
    $('form[action*="/cart/add"]').length,
  )
}

function pathKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`
  } catch {
    return null
  }
}

/**
 * The store sent the product link somewhere else (a category, search or
 * home page) and no price could be read there: the product moved or was
 * renamed. A redirect to another product page is not reported here; the
 * usual checks read it.
 */
export function detectMovedPage(input: {
  sourceUrl: string
  finalUrl: string
  html: string | undefined
  hasPrice: boolean
}): boolean {
  if (input.hasPrice || !input.html) return false
  const from = pathKey(input.sourceUrl)
  const to = pathKey(input.finalUrl)
  if (!from || !to || from === to) return false
  return !looksLikeProductPage(input.html)
}

const MISSING_TEXT =
  /\b(page not found|404|not found|no longer available|is no longer (sold|carried|offered)|product (is )?(not|no longer) available|discontinued|could not be found|can(?:no|')t be found|does(?:n't| not) exist|page you requested)\b/i

/**
 * A page that loaded (HTTP 200) but says the product or page is gone, with
 * no price on it: a "soft 404".
 */
export function isSoftMissingPage(
  html: string | undefined,
  hasPrice: boolean,
): boolean {
  if (hasPrice || !html) return false
  const $ = cheerio.load(html)
  const heading = [
    $('title').first().text(),
    $('h1').first().text(),
    $('h2').first().text(),
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
  if (MISSING_TEXT.test(heading)) return true
  // A page with no product at all whose main text says it is gone.
  if (looksLikeProductPage(html)) return false
  const main = ($('main').text() || $('body').text())
    .replace(/\s+/g, ' ')
    .slice(0, 2000)
  return MISSING_TEXT.test(main)
}

// --------------------------------------------------------------- variants

/** The variant a source tracks: any of a store variant id, SKU or label. */
export type ExpectedVariant = {
  id?: string
  sku?: string
  label?: string
}

const cleanCode = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().slice(0, 80)
    : ''

function jsonLdNodes($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    nodes.push(record)
    if (record['@graph']) visit(record['@graph'])
  }
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      visit(JSON.parse($(element).text()))
    } catch {
      // Broken structured data is skipped.
    }
  })
  return nodes
}

function variantParam(url: string): string {
  try {
    return cleanCode(new URL(url).searchParams.get('variant') ?? '')
  } catch {
    return ''
  }
}

/**
 * The variant the page shows now: Shopify's selected variant id (from the
 * product form, else the link), and a SKU when the page names exactly one.
 */
export function readPageVariant(
  html: string,
  url: string,
): ExpectedVariant | null {
  const $ = cheerio.load(html)
  const variant: ExpectedVariant = {}
  const form = $('form[action*="/cart/add"]').first()
  const select = form.find('select[name="id"]').first()
  const selected = select.find('option[selected]').first()
  // What the page selected wins over the link: Shopify shows its default
  // variant when the link names one it no longer has.
  const id =
    cleanCode(selected.attr('value')) ||
    cleanCode(form.find('input[name="id"]').first().attr('value')) ||
    variantParam(url) ||
    cleanCode(select.find('option').first().attr('value'))
  if (id && /^\d+$/.test(id)) variant.id = id
  if (selected.length) {
    const label = selected.text().replace(/\s+/g, ' ').trim()
    if (label) variant.label = label.slice(0, 80)
  }

  const products = jsonLdNodes($).filter((node) =>
    [node['@type']].flat().some((type) => type === 'Product'),
  )
  if (products.length === 1) {
    const product = products[0]
    const offers = [product.offers]
      .flat()
      .filter((offer): offer is Record<string, unknown> =>
        Boolean(offer && typeof offer === 'object'),
      )
    const matching = id
      ? offers.find((offer) =>
          String(offer.url ?? '').includes(`variant=${id}`),
        )
      : undefined
    const sku =
      cleanCode(matching?.sku) ||
      (offers.length <= 1
        ? cleanCode(offers[0]?.sku) || cleanCode(product.sku)
        : '')
    if (sku) variant.sku = sku
  }
  if (!variant.sku) {
    const sku = $('[itemprop="sku"]')
    if (sku.length === 1)
      variant.sku = cleanCode(sku.attr('content') ?? sku.text())
  }
  if (!variant.sku) delete variant.sku
  return variant.id || variant.sku ? variant : null
}

/** A stored expected variant, or null when it is not one. */
export function parseExpectedVariant(
  value: string | null,
): ExpectedVariant | null {
  if (!value) return null
  try {
    const record = JSON.parse(value) as Record<string, unknown>
    const variant: ExpectedVariant = {}
    if (cleanCode(record.id)) variant.id = cleanCode(record.id)
    if (cleanCode(record.sku)) variant.sku = cleanCode(record.sku)
    if (typeof record.label === 'string' && record.label.trim())
      variant.label = record.label.trim().slice(0, 80)
    return variant.id || variant.sku ? variant : null
  } catch {
    return null
  }
}

/**
 * The variant a source should show: the one its link names (?variant=),
 * else the one learned on its first good reading.
 */
export function expectedVariantFor(source: {
  url: string
  expected_variant: string | null
}): ExpectedVariant | null {
  const stored = parseExpectedVariant(source.expected_variant)
  const id = variantParam(source.url)
  if (id && /^\d+$/.test(id)) return stored?.id === id ? stored : { id }
  return stored
}

const sameCode = (a: string, b: string) =>
  a.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() ===
  b.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

/**
 * True only when both sides name the same kind of identifier and it
 * differs: an unknown variant is never a mismatch.
 */
export function variantMismatch(
  expected: ExpectedVariant | null,
  seen: ExpectedVariant | null,
): boolean {
  if (!expected || !seen) return false
  if (expected.id && seen.id) return expected.id !== seen.id
  if (expected.sku && seen.sku) return !sameCode(expected.sku, seen.sku)
  return false
}

/** How the tracked variant is described to AI and in the check log. */
export function describeVariant(variant: ExpectedVariant): string {
  if (variant.label) return `"${variant.label}"`
  if (variant.sku) return `SKU ${variant.sku}`
  return `variant ${variant.id}`
}

// ------------------------------------------------------- finding the page

/** What the solver may search for: brand, name and model number. */
export function relinkSearch(knife: Knife): SolverSearch {
  const identity = knifeIdentity(knife)
  return {
    queries: buildSearchQueries(identity),
    product: [
      identity.brand,
      identity.name,
      identity.modelNumber && `model number ${identity.modelNumber}`,
      identity.bladeMaterial && `${identity.bladeMaterial} blade`,
      identity.bladeLength && `${identity.bladeLength} blade length`,
    ]
      .filter(Boolean)
      .join(', '),
  }
}

/** The page's own text, without navigation, header and footer. */
function mainText(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, noscript, nav, header, footer').remove()
  return ($('main').text() || $('body').text()).replace(/\s+/g, ' ').trim()
}

/** A product page (not the JSON data) of the same store, as its link. */
export function productPageUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.pathname = parsed.pathname.replace(/\.(js|json)$/i, '')
    parsed.hash = ''
    const variant = parsed.searchParams.get('variant')
    parsed.search = ''
    if (variant) parsed.searchParams.set('variant', variant)
    return parsed.href
  } catch {
    return url
  }
}

/**
 * Whether a page AI reached is the knife's product page: the knife's model
 * number on the page when it has one, and AI's product check. Throws
 * AiClientError when AI cannot be asked.
 */
export function productPageAcceptor(input: {
  knife: Knife
  endpoint: AiEndpoint
  model: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
  verify?: typeof verifyProductPage
}): (page: { url: string; html: string }) => Promise<boolean> {
  const identity = knifeIdentity(input.knife)
  const verify = input.verify ?? verifyProductPage
  return async ({ html }) => {
    if (!html || !looksLikeProductPage(html)) return false
    const details = genericProductDetails(html)
    if (!details) return false
    const text = `${details.title}\n${details.details}\n${mainText(html).slice(0, 4000)}`
    if (!pageShowsModelNumber(identity.modelNumber, text)) return false
    const verdict = await verify({
      endpoint: input.endpoint,
      model: input.model,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
      knife: identity,
      page: details,
    })
    return verdict.accepted
  }
}

/** A new link may be applied without asking: the exact model number shows. */
export function relinkSafeToApply(knife: Knife, html: string | null): boolean {
  if (!html || !modelNumberCodes(knife.specs.modelNumber).length) return false
  const details = genericProductDetails(html)
  return pageShowsModelNumber(
    knife.specs.modelNumber,
    `${details?.title ?? ''}\n${details?.details ?? ''}\n${mainText(html)}`,
  )
}

// --------------------------------------------------------------- relink

/**
 * Moves a source to its product's new link and keeps its price history.
 * For the knife's own product link source, the knife's product link moves
 * with it, so the link and the source stay one.
 */
export async function applyRelink(input: {
  sourceId: number
  url: string
}): Promise<boolean> {
  const before = readSource(getLocalDb(), input.sourceId)
  if (!before || before.removed_at) return false
  const knife =
    before.origin === 'auto'
      ? await getStorage().getKnifeById(before.knife_id)
      : undefined
  const moved = await withVaultWrite(async () => {
    const database = getLocalDb()
    return database.transaction(() =>
      relinkSourceRow(
        database,
        input.sourceId,
        input.url,
        new Date().toISOString(),
      ),
    )()
  })
  if (
    moved &&
    knife &&
    normalizeSourceUrl(knife.sourceUrl ?? '') === before.normalized_url
  ) {
    await getStorage().updateKnife(
      knife.id,
      { sourceUrl: input.url },
      { expectedUpdatedAt: knife.updatedAt },
    )
  }
  return moved
}

/** Asks the collector in the Inbox whether to use the new link AI found. */
export async function askToRelink(input: {
  knife: Knife
  sourceId: number
  store: string
  url: string
}): Promise<void> {
  const path = (() => {
    try {
      return new URL(input.url).pathname
    } catch {
      return input.url
    }
  })()
  await reportSystemMessage({
    kind: 'price-question',
    key: `relink:${input.sourceId}:${normalizeSourceUrl(input.url) ?? input.url}`,
    title: `${input.knife.brand} ${input.knife.name} moved on ${input.store}`,
    detail: `The saved product link no longer shows this knife. AI found it on the same store at ${path}. Use the new link? Its price history stays with the source.`,
    payload: {
      type: 'question',
      knifeId: input.knife.id,
      ask: 'relink',
      sourceId: input.sourceId,
      store: input.store,
      url: input.url,
    },
  })
}
