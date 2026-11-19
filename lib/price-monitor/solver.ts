import * as cheerio from 'cheerio'
import type { Page } from 'playwright'
import {
  requestJsonCompletion,
  type AiEndpoint,
  type FetchLike,
} from '@/lib/price-monitor/ai-client'
import {
  AI_OFFER_SCHEMA,
  AI_SOURCE_COOLDOWN_MS,
  aiConfigured,
  buildPriceFragment,
  parseAiOfferAnswer,
} from '@/lib/price-monitor/ai'
import { extractOfferFromHtml } from '@/lib/price-monitor/fetch'
import { normalizeCurrencyCode } from '@/lib/price-monitor/money'
import { MONITOR_CURRENCY } from '@/lib/price-monitor/region'
import { isSecurityChallengePage, isShopifyProductPage } from '@/lib/scrape'
import {
  extractShopifyOffer,
  getShopifyProductJsUrl,
  OFFER_AVAILABILITIES,
  type ExtractedOffer,
} from '@/lib/scrape-offer'
import type { PriceAiSettings } from '@/lib/settings-shared'

/**
 * The AI problem solver. When a check cannot read a price (no price, no
 * currency, an unusable amount, a slow page), the model works the product
 * page in the monitoring browser one step at a time, from a fixed set of
 * actions: wait, scroll, click or choose a page control (cookie banners,
 * age gates, pop-ups, variant and region pickers), press Escape, open the
 * same store's canonical, AMP, US-edition or Shopify product data, read the
 * price from the page, or (with a vision model) from a screenshot. Prices are
 * tracked in US dollars: a page in another currency is switched to the US
 * edition with the store's country or currency picker.
 *
 * Bounds: at most MAX_SOLVER_STEPS steps and one solver run per product per
 * 24 hours (shared with the other AI features). It never types, never
 * clicks purchase, account or bot-check controls, never leaves the store's
 * site, and stops at a bot check: those are for the user (Solve in browser).
 * A price the model reads must appear on the page as written, or come from
 * a screenshot with high confidence, and then passes the same checks as any
 * other reading. Steps that led the page parsers to a price are kept as a
 * recipe for the store and replayed first next time, without AI.
 */
export const MAX_SOLVER_STEPS = 6
export const SOLVER_BUDGET_MS = 90_000
export const SOLVER_STEP_TIMEOUT_MS = 20_000
export const VISION_MIN_CONFIDENCE = 0.9
export const MAX_RECIPE_STEPS = 6
const MAX_CANDIDATES = 40
const FRAGMENT_BYTES = 6 * 1024

/** Codes the solver may rescue: page-read problems and slow pages. */
export const SOLVER_CODES: ReadonlySet<string> = new Set([
  'not_found',
  'no_currency',
  'invalid_price',
  'timeout',
  'invalid_response',
  'wrong_currency',
])

/** Text of controls the solver must never use. */
const FORBIDDEN_CONTROL =
  /add to (cart|bag|basket)|buy|checkout|check out|purchase|order|pay\b|sign ?in|log ?in|log ?out|register|create account|subscribe|newsletter|wishlist|delete|remove|captcha|robot|verify (you|that you)|human/i
/** Submit buttons are allowed only for consent and age prompts. */
const ALLOWED_SUBMIT =
  /accept|agree|reject|decline|deny|close|continue|yes|enter|i am|i'm|over 1[89]|confirm/i

// ---------------------------------------------------------------- types

/** A replayable page action; recipes are lists of these. */
export type SolverAction =
  | { action: 'wait'; seconds: number }
  | { action: 'scroll' }
  | { action: 'click'; selector: string; label: string }
  | { action: 'select'; selector: string; value: string; label: string }
  | { action: 'escape' }
  | { action: 'open'; url: string }

export type SolverLogStep = { action: string; detail: string; result: string }

export type Candidate = {
  index: number
  tag: string
  text: string
  selector: string
  inDialog: boolean
  submit: boolean
  options?: string[]
}

export type SolverResult = {
  status: 'solved' | 'challenge' | 'gave_up' | 'failed'
  offer: ExtractedOffer | null
  /** The model read the price itself (text or screenshot). */
  readByAi: boolean
  /** Steps that led the parsers to the price; null when none apply. */
  recipe: SolverAction[] | null
  steps: SolverLogStep[]
  aiCalls: number
  note: string | null
}

/** The parts of a Playwright page the solver uses (fakes in tests). */
export type SolverPage = Pick<
  Page,
  | 'content'
  | 'url'
  | 'evaluate'
  | 'locator'
  | 'goto'
  | 'goBack'
  | 'waitForTimeout'
  | 'waitForLoadState'
  | 'screenshot'
  | 'keyboard'
>

// --------------------------------------------------------------- helpers

/** The same store: equal host names, ignoring a leading www. */
export function sameSite(a: string, b: string): boolean {
  try {
    const host = (value: string) =>
      new URL(value).hostname.toLowerCase().replace(/^www\./, '')
    const left = new URL(a)
    const right = new URL(b)
    return (
      ['http:', 'https:'].includes(right.protocol) &&
      host(left.href) === host(right.href)
    )
  } catch {
    return false
  }
}

export function controlAllowed(candidate: {
  text: string
  submit: boolean
}): boolean {
  if (!candidate.text.trim()) return false
  if (FORBIDDEN_CONTROL.test(candidate.text)) return false
  if (candidate.submit && !ALLOWED_SUBMIT.test(candidate.text)) return false
  return true
}

/** Same-site alternatives to the product page, from its HTML. */
export function findAlternatives(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html)
  const urls = new Set<string>()
  const add = (href: string | undefined) => {
    if (!href) return
    try {
      const url = new URL(href, pageUrl).href
      if (url !== pageUrl && sameSite(pageUrl, url)) urls.add(url)
    } catch {
      // Ignore broken links.
    }
  }
  // The store's own US edition first: prices are tracked in US dollars.
  $('link[rel="alternate"][hreflang]').each((_, element) => {
    if (/^[a-z]{2}-us$/i.test($(element).attr('hreflang')?.trim() ?? ''))
      add($(element).attr('href'))
  })
  add($('link[rel="canonical"]').attr('href'))
  add($('link[rel="amphtml"]').attr('href'))
  if (isShopifyProductPage(pageUrl, html)) add(getShopifyProductJsUrl(pageUrl))
  return [...urls].slice(0, 4)
}

/** Recipes from the store row; anything unexpected is dropped. */
export function parseRecipe(value: string | null): SolverAction[] | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const steps: SolverAction[] = []
  for (const item of parsed.slice(0, MAX_RECIPE_STEPS)) {
    const step = item as Record<string, unknown>
    const text = (key: string) =>
      typeof step[key] === 'string' ? (step[key] as string) : ''
    switch (step?.action) {
      case 'wait':
        steps.push({
          action: 'wait',
          seconds: Math.min(8, Math.max(1, Number(step.seconds) || 2)),
        })
        break
      case 'scroll':
      case 'escape':
        steps.push({ action: step.action })
        break
      case 'click':
        if (text('selector'))
          steps.push({
            action: 'click',
            selector: text('selector'),
            label: text('label'),
          })
        break
      case 'select':
        if (text('selector') && text('value'))
          steps.push({
            action: 'select',
            selector: text('selector'),
            value: text('value'),
            label: text('label'),
          })
        break
      case 'open':
        if (text('url')) steps.push({ action: 'open', url: text('url') })
        break
    }
  }
  return steps.length ? steps : null
}

/** Whether a page-read failure may start the solver now. */
export function solverAllowed(input: {
  settings: PriceAiSettings
  errorCode: string
  lastAiAt: string | null
  now: number
}): boolean {
  if (!aiConfigured(input.settings) || !input.settings.resolveErrors)
    return false
  if (!SOLVER_CODES.has(input.errorCode)) return false
  if (!input.lastAiAt) return true
  const last = Date.parse(input.lastAiAt)
  return !Number.isFinite(last) || input.now - last >= AI_SOURCE_COOLDOWN_MS
}

// ----------------------------------------------------------- page access

/** Visible controls, dialogs and likely blockers first. Runs in the page. */
function collectCandidates(max: number) {
  const KEY =
    /cookie|consent|accept|reject|agree|age|close|dismiss|variant|size|option|colou?r|currency|country|region|ship|price|continue|popup|modal/i
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    )
  }
  const simpleId = (value: string) => /^[A-Za-z][\w-]*$/.test(value)
  const selectorFor = (element: Element): string => {
    const parts: string[] = []
    let node: Element | null = element
    while (node && node !== document.body && parts.length < 8) {
      if (node.id && simpleId(node.id)) {
        parts.unshift(`#${node.id}`)
        return parts.join(' > ')
      }
      const tag = node.tagName.toLowerCase()
      const parent: Element | null = node.parentElement
      const current = node
      const same = parent
        ? Array.from(parent.children).filter(
            (c) => c.tagName === current.tagName,
          )
        : []
      parts.unshift(
        same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag,
      )
      node = parent
    }
    return `body > ${parts.join(' > ')}`
  }
  const inDialog = (element: Element) =>
    Boolean(
      element.closest(
        '[role="dialog"], [aria-modal="true"], dialog, [class*="cookie" i], [class*="consent" i], [class*="modal" i], [class*="popup" i], [id*="cookie" i], [id*="consent" i]',
      ),
    )
  const elements = Array.from(
    document.querySelectorAll(
      'button, [role="button"], select, input[type="radio"], input[type="checkbox"], input[type="submit"], label, [role="option"], [role="tab"], a[href]',
    ),
  ).filter(visible)
  const rows = elements
    .map((element) => {
      const tag = element.tagName.toLowerCase()
      if (
        tag === 'a' &&
        !inDialog(element) &&
        element.getAttribute('role') !== 'button'
      )
        return null
      const label =
        (element as HTMLElement).innerText ||
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        (element as HTMLInputElement).value ||
        ''
      const text = label.replace(/\s+/g, ' ').trim().slice(0, 80)
      const options =
        tag === 'select'
          ? Array.from((element as HTMLSelectElement).options)
              .slice(0, 15)
              .map((option) => option.text.trim().slice(0, 40))
          : undefined
      if (!text && !options) return null
      const dialog = inDialog(element)
      const submit =
        (element as HTMLButtonElement).type === 'submit' &&
        Boolean(element.closest('form'))
      const score =
        (dialog ? 2 : 0) +
        (KEY.test(`${text} ${element.className} ${element.id}`) ? 1 : 0)
      return {
        tag,
        text: text || (options ?? []).join(' / ').slice(0, 80),
        selector: selectorFor(element),
        inDialog: dialog,
        submit,
        options,
        score,
      }
    })
    .filter((row) => row !== null)
  rows.sort((a, b) => b.score - a.score)
  return rows.slice(0, max)
}

async function readCandidates(page: SolverPage): Promise<Candidate[]> {
  const rows = (await page
    .evaluate(collectCandidates, MAX_CANDIDATES * 2)
    .catch(() => [])) as Array<Omit<Candidate, 'index'> & { score?: number }>
  return rows
    .filter((row) => controlAllowed(row))
    .slice(0, MAX_CANDIDATES)
    .map((row, index) => ({
      index,
      tag: row.tag,
      text: row.text,
      selector: row.selector,
      inDialog: row.inDialog,
      submit: row.submit,
      ...(row.options ? { options: row.options } : {}),
    }))
}

type PageState =
  | { kind: 'challenge' }
  | { kind: 'html'; html: string; url: string; offer: ExtractedOffer | null }
  | { kind: 'json'; url: string; offer: ExtractedOffer | null }

/** Runs one action; returns a short result for the log. */
async function perform(
  page: SolverPage,
  step: SolverAction,
  context: { startUrl: string; currencyHint: string; json: { value: unknown } },
): Promise<string> {
  context.json.value = undefined
  switch (step.action) {
    case 'wait':
      await page
        .waitForLoadState('networkidle', { timeout: step.seconds * 1000 })
        .catch(() => {})
      await page.waitForTimeout(500)
      return 'waited'
    case 'scroll':
      await page.evaluate(async () => {
        const height = document.body.scrollHeight
        for (let y = 0; y <= height; y += Math.max(400, height / 6)) {
          window.scrollTo(0, y)
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        window.scrollTo(0, 0)
      })
      await page.waitForTimeout(500)
      return 'scrolled'
    case 'escape':
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      return 'pressed Escape'
    case 'click': {
      const target = page.locator(step.selector).first()
      const text = (await target.innerText({ timeout: 3000 }).catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim()
      if (FORBIDDEN_CONTROL.test(text)) return 'refused: not a safe control'
      await target.click({ timeout: 5000 })
      await page.waitForTimeout(1200)
      if (!sameSite(context.startUrl, page.url())) {
        await page.goBack({ timeout: 10_000 }).catch(() => {})
        return 'went back: the click left the store'
      }
      return 'clicked'
    }
    case 'select': {
      const target = page.locator(step.selector).first()
      await target
        .selectOption({ label: step.value }, { timeout: 5000 })
        .catch(() => target.selectOption(step.value, { timeout: 5000 }))
      await page.waitForTimeout(1200)
      return 'selected'
    }
    case 'open': {
      if (!sameSite(context.startUrl, step.url)) return 'refused: another site'
      const response = await page.goto(step.url, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      })
      const type = response?.headers()['content-type'] ?? ''
      if (/json|javascript/i.test(type) || /\.js(on)?(\?|$)/.test(step.url)) {
        try {
          context.json.value = JSON.parse((await response?.text()) ?? '')
        } catch {
          return 'opened, but it was not product data'
        }
      }
      await page.waitForTimeout(800)
      return response && !response.ok()
        ? `opened: HTTP ${response.status()}`
        : 'opened'
    }
  }
}

async function readState(
  page: SolverPage,
  context: { currencyHint: string; json: { value: unknown } },
): Promise<PageState> {
  const url = page.url()
  if (context.json.value !== undefined) {
    // Shopify product data has amounts only; its cart names the currency.
    const cartCurrency = normalizeCurrencyCode(
      await page
        .evaluate(async () => {
          const response = await fetch('/cart.js', {
            headers: { Accept: 'application/json' },
          })
          return ((await response.json()) as { currency?: unknown })?.currency
        })
        .catch(() => null),
    )
    return {
      kind: 'json',
      url,
      offer: extractShopifyOffer(
        context.json.value,
        url,
        cartCurrency || context.currencyHint,
      ),
    }
  }
  const html = await page.content()
  if (isSecurityChallengePage(html)) return { kind: 'challenge' }
  return { kind: 'html', html, url, offer: extractOfferFromHtml(html, url) }
}

function describe(step: SolverAction): string {
  switch (step.action) {
    case 'wait':
      return `${step.seconds} s`
    case 'click':
      return step.label
    case 'select':
      return `${step.label}: ${step.value}`
    case 'open':
      return new URL(step.url).pathname
    default:
      return ''
  }
}

// ---------------------------------------------------------------- replay

/** Replays a store recipe on a page; no AI. Missing controls are skipped. */
export async function replayRecipe(
  page: SolverPage,
  recipe: readonly SolverAction[],
  input: { currencyHint: string },
): Promise<{ offer: ExtractedOffer | null; challenge: boolean }> {
  const context = {
    startUrl: page.url(),
    currencyHint: input.currencyHint,
    json: { value: undefined as unknown },
  }
  let offer: ExtractedOffer | null = null
  for (const step of recipe.slice(0, MAX_RECIPE_STEPS)) {
    try {
      await perform(page, step, context)
    } catch {
      continue
    }
    const state = await readState(page, context)
    if (state.kind === 'challenge') return { offer: null, challenge: true }
    offer = state.offer
    if (offer?.amount != null) break
  }
  return { offer, challenge: false }
}

// ----------------------------------------------------------------- model

export const SOLVER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'action',
    'target',
    'value',
    'seconds',
    'price',
    'currency',
    'availability',
    'confidence',
    'reason',
  ],
  properties: {
    action: {
      type: 'string',
      enum: [
        'wait',
        'scroll',
        'click',
        'select',
        'escape',
        'open',
        'read',
        'screenshot',
        'give_up',
      ],
    },
    target: { type: ['integer', 'null'] },
    value: { type: ['string', 'null'] },
    seconds: { type: ['number', 'null'] },
    price: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'] },
    availability: { type: 'string', enum: [...OFFER_AVAILABILITIES] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
} as const

const SOLVER_PROMPT = [
  'You operate a browser for a personal app that reads the current price and stock status of one product on a store page. The usual page parsers found no usable price, and you choose the next step.',
  'Each turn you get the problem, the page address, earlier steps and their results, the page controls you may use (by index), same-site alternatives (by index) and a trimmed fragment of the page.',
  'Answer with JSON: {"action", "target", "value", "seconds", "price", "currency", "availability", "confidence", "reason"}. Fields that do not apply are null (availability "unknown", confidence 0).',
  'Actions: "wait" (seconds 1-8) for content that is still loading; "scroll" to load lazy content; "click" a control by target index, for example to accept or reject cookies, confirm an age prompt, close a pop-up or pick a variant; "select" an option (value = option text) in a select control by target; "escape" to close an overlay; "open" a same-site alternative by target index (canonical page, AMP page, the store\'s US edition or product data); "read" when the fragment shows the price: price copied exactly as written, currency as ISO 4217, availability, confidence 0-1; "screenshot" to look at the page as an image when the price may be drawn as an image; "give_up" when nothing can work.',
  `The app tracks United States prices in US dollars (${MONITOR_CURRENCY}). When the page shows another country or currency, first switch to the United States or ${MONITOR_CURRENCY} with the store's country, region or currency picker, or "open" the US edition from the alternatives; read a price in another currency only when the store offers no ${MONITOR_CURRENCY}.`,
  'Never buy, sign in, subscribe or fill forms, and never try to solve or get around a CAPTCHA or bot check. Ignore crossed-out, list, shipping, instalment and related-product prices. reason: one short sentence.',
].join('\n')

const VISION_PROMPT = [
  'You read the current selling price of the one product on a store page from a screenshot.',
  'Answer with JSON only: {"price", "currency", "availability", "confidence"}. price exactly as shown, or null. Ignore crossed-out, list, shipping, instalment and related-product prices.',
].join('\n')

type ModelStep = {
  action: string
  target: number | null
  value: string | null
  seconds: number | null
  reason: string
  raw: Record<string, unknown>
}

function readModelStep(answer: unknown): ModelStep {
  const record =
    answer && typeof answer === 'object' && !Array.isArray(answer)
      ? (answer as Record<string, unknown>)
      : {}
  const target = Number(record.target)
  const seconds = Number(record.seconds)
  return {
    action: typeof record.action === 'string' ? record.action : 'give_up',
    target: Number.isInteger(target) ? target : null,
    value:
      typeof record.value === 'string'
        ? record.value.trim().slice(0, 80)
        : null,
    seconds: Number.isFinite(seconds) ? seconds : null,
    reason:
      typeof record.reason === 'string'
        ? record.reason.replace(/\s+/g, ' ').trim().slice(0, 160)
        : '',
    raw: record,
  }
}

/** The model's step as a page action, or why it cannot run. Pure. */
export function toSolverAction(
  step: ModelStep,
  candidates: readonly Candidate[],
  alternatives: readonly string[],
): SolverAction | string {
  switch (step.action) {
    case 'wait':
      return {
        action: 'wait',
        seconds: Math.min(8, Math.max(1, Math.round(step.seconds ?? 3))),
      }
    case 'scroll':
      return { action: 'scroll' }
    case 'escape':
      return { action: 'escape' }
    case 'click':
    case 'select': {
      const candidate = candidates.find((entry) => entry.index === step.target)
      if (!candidate) return 'refused: unknown control'
      if (step.action === 'click')
        return {
          action: 'click',
          selector: candidate.selector,
          label: candidate.text,
        }
      if (!candidate.options || !step.value)
        return 'refused: not a select control'
      const value = candidate.options.find(
        (option) => option.toLowerCase() === step.value!.toLowerCase(),
      )
      if (!value) return 'refused: unknown option'
      return {
        action: 'select',
        selector: candidate.selector,
        value,
        label: candidate.text,
      }
    }
    case 'open': {
      const url = step.target === null ? undefined : alternatives[step.target]
      return url ? { action: 'open', url } : 'refused: unknown alternative'
    }
    default:
      return `refused: unknown action ${step.action}`
  }
}

function pagePath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- runner

/**
 * Lets the model work the page until the parsers or the model find an
 * accepted price, a bot check appears, it gives up or steps run out.
 * `accept` applies the engine's validation (amount and currency).
 */
export async function solveOnPage(
  page: SolverPage,
  input: {
    problem: { code: string; message: string }
    currencyHint: string
    settings: PriceAiSettings
    endpoint: AiEndpoint
    accept: (offer: ExtractedOffer) => boolean
    signal?: AbortSignal
    fetchImpl?: FetchLike
    maxSteps?: number
  },
): Promise<SolverResult> {
  const steps: SolverLogStep[] = []
  const executed: SolverAction[] = []
  const context = {
    startUrl: page.url(),
    currencyHint: input.currencyHint,
    json: { value: undefined as unknown },
  }
  let aiCalls = 0
  const result = (
    status: SolverResult['status'],
    extra: Partial<SolverResult> = {},
  ): SolverResult => ({
    status,
    offer: null,
    readByAi: false,
    recipe: null,
    steps,
    aiCalls,
    note: null,
    ...extra,
  })
  const ask = (user: Parameters<typeof requestJsonCompletion>[1]['user']) => {
    aiCalls += 1
    return requestJsonCompletion(
      input.endpoint,
      {
        model: input.settings.model,
        system: SOLVER_PROMPT,
        user,
        schemaName: 'page_step',
        schema: SOLVER_SCHEMA,
        maxTokens: 300,
      },
      {
        timeoutMs: SOLVER_STEP_TIMEOUT_MS,
        signal: input.signal,
        fetchImpl: input.fetchImpl,
      },
    )
  }

  const run = async (): Promise<SolverResult> => {
    let state = await readState(page, context)
    for (let turn = 0; turn < (input.maxSteps ?? MAX_SOLVER_STEPS); turn++) {
      if (state.kind === 'challenge')
        return result('challenge', {
          note: 'The store showed a bot check while AI worked on the page.',
        })
      if (
        state.offer &&
        state.offer.amount !== null &&
        input.accept(state.offer)
      )
        return result('solved', {
          offer: state.offer,
          recipe: executed.length ? executed.slice(0, MAX_RECIPE_STEPS) : null,
        })

      const html = state.kind === 'html' ? state.html : ''
      const fragment = html ? buildPriceFragment(html, FRAGMENT_BYTES) : ''
      const candidates = html ? await readCandidates(page) : []
      const alternatives = html ? findAlternatives(html, state.url) : []
      const answer = readModelStep(
        await ask(
          JSON.stringify({
            problem: input.problem,
            page: pagePath(state.url),
            step: turn + 1,
            stepsLeft: (input.maxSteps ?? MAX_SOLVER_STEPS) - turn,
            visionAvailable: input.settings.vision,
            history: steps,
            controls: candidates.map(
              ({ index, tag, text, inDialog, options }) => ({
                index,
                tag,
                text,
                inDialog,
                ...(options ? { options } : {}),
              }),
            ),
            alternatives: alternatives.map((url, index) => ({
              index,
              page: pagePath(url),
            })),
            fragment,
          }),
        ),
      )

      if (answer.action === 'give_up') {
        steps.push({ action: 'give_up', detail: '', result: answer.reason })
        return result('gave_up', {
          note: answer.reason ? `AI gave up: ${answer.reason}` : null,
        })
      }

      if (answer.action === 'read') {
        const parsed = parseAiOfferAnswer(
          answer.raw,
          fragment,
          input.currencyHint,
        )
        if (parsed.status === 'ok' && input.accept(parsed.offer)) {
          steps.push({ action: 'read', detail: '', result: 'price read' })
          return result('solved', {
            offer: parsed.offer,
            readByAi: true,
            recipe: executed.length
              ? executed.slice(0, MAX_RECIPE_STEPS)
              : null,
          })
        }
        steps.push({
          action: 'read',
          detail: '',
          result:
            parsed.status === 'ok' ? 'rejected: unusable price' : parsed.reason,
        })
        continue
      }

      if (answer.action === 'screenshot') {
        if (!input.settings.vision) {
          steps.push({
            action: 'screenshot',
            detail: '',
            result: 'refused: the model is not set up to read images',
          })
          continue
        }
        const image = await page.screenshot({ type: 'jpeg', quality: 60 })
        aiCalls += 1
        const vision = await requestJsonCompletion(
          input.endpoint,
          {
            model: input.settings.model,
            system: VISION_PROMPT,
            user: [
              { type: 'text', text: 'Screenshot of the product page:' },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${Buffer.from(image).toString('base64')}`,
                },
              },
            ],
            schemaName: 'product_offer',
            schema: AI_OFFER_SCHEMA,
            maxTokens: 200,
          },
          {
            timeoutMs: SOLVER_STEP_TIMEOUT_MS,
            signal: input.signal,
            fetchImpl: input.fetchImpl,
          },
        )
        const pageText = html ? cheerio.load(html).root().text() : ''
        let parsed = parseAiOfferAnswer(vision, pageText, input.currencyHint)
        const confidence = Number(
          (vision as { confidence?: unknown })?.confidence,
        )
        // Drawn prices are not in the text: accept only very sure readings.
        if (
          parsed.status === 'rejected' &&
          parsed.reason === 'not_in_page' &&
          confidence >= VISION_MIN_CONFIDENCE
        )
          parsed = parseAiOfferAnswer(
            vision,
            String((vision as { price?: unknown }).price ?? ''),
            input.currencyHint,
          )
        if (parsed.status === 'ok' && input.accept(parsed.offer)) {
          steps.push({ action: 'screenshot', detail: '', result: 'price read' })
          return result('solved', {
            offer: parsed.offer,
            readByAi: true,
            recipe: null,
          })
        }
        steps.push({
          action: 'screenshot',
          detail: '',
          result:
            parsed.status === 'ok' ? 'rejected: unusable price' : parsed.reason,
        })
        continue
      }

      const action = toSolverAction(answer, candidates, alternatives)
      if (typeof action === 'string') {
        steps.push({ action: answer.action, detail: '', result: action })
        continue
      }
      let outcome: string
      try {
        outcome = await perform(page, action, context)
      } catch (error) {
        outcome = `failed: ${error instanceof Error ? error.message.split('\n')[0].slice(0, 120) : 'error'}`
      }
      steps.push({
        action: action.action,
        detail: describe(action),
        result: outcome,
      })
      if (!/^(refused|failed|went back)/.test(outcome)) executed.push(action)
      state = await readState(page, context)
    }
    if (state.kind === 'challenge')
      return result('challenge', {
        note: 'The store showed a bot check while AI worked on the page.',
      })
    if (state.offer && state.offer.amount !== null && input.accept(state.offer))
      return result('solved', {
        offer: state.offer,
        recipe: executed.length ? executed.slice(0, MAX_RECIPE_STEPS) : null,
      })
    return result('failed', { note: 'AI could not reach the price.' })
  }
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error && error.name === 'AiClientError')
      return result('failed', { note: `AI problem solver: ${error.message}` })
    throw error
  }
}

/** One line for the check log, e.g. "clicked Accept cookies → opened …". */
export function summarizeSteps(steps: readonly SolverLogStep[]): string {
  return steps
    .slice(0, MAX_SOLVER_STEPS + 2)
    .map((step) =>
      [step.action, step.detail && `"${step.detail}"`, `(${step.result})`]
        .filter(Boolean)
        .join(' '),
    )
    .join(' → ')
}
