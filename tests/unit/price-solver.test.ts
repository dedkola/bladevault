import { describe, expect, it, vi } from 'vitest'
import {
  controlAllowed,
  findAlternatives,
  parseRecipe,
  replayRecipe,
  sameSite,
  solveOnPage,
  solverAllowed,
  summarizeSteps,
  type SolverPage,
} from '@/lib/price-monitor/solver'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const URL0 = 'https://shop.example/products/raccoon'
const NO_PRICE = `<html><head><title>Raccoon</title></head><body>
<h1>Raccoon</h1><div class="cookie-banner"><button id="accept">Accept cookies</button></div></body></html>`
const PRICED = `<html><head><title>Raccoon</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Raccoon","offers":{"@type":"Offer","price":"118.50","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
</head><body><h1>Raccoon</h1><span class="price">$118.50</span></body></html>`
const CHALLENGE = '<html><body>Verify you are human</body></html>'

const settings = {
  ...DEFAULT_PRICE_MONITORING.ai,
  enabled: true,
  baseUrl: 'http://localhost:11434/v1',
  model: 'm',
}
const endpoint = { baseUrl: settings.baseUrl, apiKey: null }

type Control = { tag: string; text: string; selector: string; submit?: boolean }

/** A page with named states; clicks move between them. */
function fakePage(input: {
  states: Record<string, string>
  controls?: Record<string, Control[]>
  clicks?: Record<string, string>
}) {
  let state = 'start'
  const url = URL0
  const clicked: string[] = []
  const page = {
    url: () => url,
    content: async () => input.states[state],
    evaluate: async (_fn: unknown, arg?: unknown) =>
      typeof arg === 'number'
        ? (input.controls?.[state] ?? []).map((control) => ({
            inDialog: true,
            submit: false,
            ...control,
          }))
        : undefined,
    locator: (selector: string) => ({
      first: () => ({
        innerText: async () =>
          Object.values(input.controls ?? {})
            .flat()
            .find((control) => control.selector === selector)?.text ?? '',
        click: async () => {
          clicked.push(selector)
          state = input.clicks?.[selector] ?? state
        },
        selectOption: async () => [],
      }),
    }),
    goto: async () => null,
    goBack: async () => null,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    screenshot: async () => Buffer.from('jpeg'),
    keyboard: { press: async () => {} },
  }
  return { page: page as unknown as SolverPage, clicked }
}

function modelAnswers(...answers: Array<Record<string, unknown>>) {
  const bodies: Array<{ messages: Array<{ content: unknown }> }> = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const next = answers.shift() ?? { action: 'give_up', reason: 'done' }
    return Response.json({
      choices: [{ message: { content: JSON.stringify(next) } }],
    })
  }) as unknown as typeof fetch
  return { fetchImpl, bodies }
}

const step = (patch: Record<string, unknown>) => ({
  target: null,
  value: null,
  seconds: null,
  price: null,
  currency: null,
  availability: 'unknown',
  confidence: 0,
  reason: 'test',
  ...patch,
})

const acceptAll = () => true

describe('solver helpers', () => {
  it('keeps the solver on the store site', () => {
    expect(sameSite(URL0, 'https://www.shop.example/x')).toBe(true)
    expect(sameSite(URL0, 'https://evil.example/x')).toBe(false)
    expect(sameSite(URL0, 'javascript:alert(1)')).toBe(false)
  })

  it('refuses purchase, account and bot-check controls', () => {
    for (const text of [
      'Add to cart',
      'Buy now',
      'Sign in',
      'Checkout',
      "I'm not a robot",
      'Subscribe',
    ])
      expect(controlAllowed({ text, submit: false })).toBe(false)
    expect(controlAllowed({ text: 'Accept cookies', submit: false })).toBe(true)
    expect(controlAllowed({ text: 'Size 3', submit: false })).toBe(true)
    expect(controlAllowed({ text: 'Notify me', submit: true })).toBe(false)
    expect(controlAllowed({ text: 'I am over 18', submit: true })).toBe(true)
  })

  it('finds same-site canonical and Shopify product data only', () => {
    const html = `<html><head>
      <link rel="canonical" href="/products/raccoon-knife">
      <link rel="amphtml" href="https://other.example/amp">
      <script>window.Shopify = {}</script>
      <meta property="og:type" content="product"></head></html>`
    const found = findAlternatives(html, URL0)
    expect(found).toContain('https://shop.example/products/raccoon-knife')
    expect(found.some((url) => url.includes('other.example'))).toBe(false)
  })

  it('offers the store’s US edition first', () => {
    const html = `<html><head>
      <link rel="canonical" href="/en-ua/products/raccoon">
      <link rel="alternate" hreflang="uk-UA" href="/uk-ua/products/raccoon">
      <link rel="alternate" hreflang="en-US" href="/products/raccoon-us">
      <link rel="alternate" hreflang="en-us" href="https://other.example/products/raccoon">
    </head><body></body></html>`
    expect(findAlternatives(html, URL0)).toEqual([
      'https://shop.example/products/raccoon-us',
      'https://shop.example/en-ua/products/raccoon',
    ])
  })

  it('lets AI fix a page in another currency', () => {
    expect(
      solverAllowed({
        settings: { ...settings, resolveErrors: true },
        errorCode: 'wrong_currency',
        lastAiAt: null,
        now: Date.now(),
      }),
    ).toBe(true)
  })

  it('reads stored recipes defensively', () => {
    expect(parseRecipe(null)).toBeNull()
    expect(parseRecipe('not json')).toBeNull()
    expect(
      parseRecipe(
        JSON.stringify([
          { action: 'click', selector: '#accept', label: 'Accept' },
          { action: 'wait', seconds: 99 },
          { action: 'type', text: 'secret' },
          { action: 'click' },
        ]),
      ),
    ).toEqual([
      { action: 'click', selector: '#accept', label: 'Accept' },
      { action: 'wait', seconds: 8 },
    ])
  })

  it('runs only for page-read problems with AI and the switch on', () => {
    const base = {
      settings,
      errorCode: 'not_found',
      lastAiAt: null,
      now: Date.now(),
    }
    expect(solverAllowed(base)).toBe(true)
    expect(solverAllowed({ ...base, errorCode: 'challenge' })).toBe(false)
    expect(
      solverAllowed({
        ...base,
        settings: { ...settings, resolveErrors: false },
      }),
    ).toBe(false)
    expect(solverAllowed({ ...base, lastAiAt: new Date().toISOString() })).toBe(
      false,
    )
  })
})

describe('solveOnPage', () => {
  it('clicks through a cookie banner and keeps the step as a recipe', async () => {
    const { page, clicked } = fakePage({
      states: { start: NO_PRICE, accepted: PRICED },
      controls: {
        start: [
          { tag: 'button', text: 'Add to cart', selector: '#buy' },
          { tag: 'button', text: 'Accept cookies', selector: '#accept' },
        ],
      },
      clicks: { '#accept': 'accepted' },
    })
    const { fetchImpl, bodies } = modelAnswers(
      step({ action: 'click', target: 0 }),
    )
    const result = await solveOnPage(page, {
      problem: { code: 'not_found', message: 'No price.' },
      currencyHint: '',
      settings,
      endpoint,
      accept: acceptAll,
      fetchImpl,
    })
    expect(result.status).toBe('solved')
    expect(result.offer).toMatchObject({ amount: 118.5, currency: 'USD' })
    expect(result.readByAi).toBe(false)
    expect(result.recipe).toEqual([
      { action: 'click', selector: '#accept', label: 'Accept cookies' },
    ])
    expect(clicked).toEqual(['#accept'])
    // The purchase button was never offered to the model.
    const sent = JSON.parse(String(bodies[0].messages[1].content))
    expect(sent.controls).toEqual([
      expect.objectContaining({ index: 0, text: 'Accept cookies' }),
    ])
    expect(sent.page).toBe('shop.example/products/raccoon')
    expect(summarizeSteps(result.steps)).toBe(
      'click "Accept cookies" (clicked)',
    )
  })

  it('accepts a read price only when it is on the page', async () => {
    const page = fakePage({
      states: {
        start:
          '<html><body><div class="price-box">Now $99.00</div></body></html>',
      },
    }).page
    const { fetchImpl } = modelAnswers(
      step({
        action: 'read',
        price: '$120.00',
        currency: 'USD',
        confidence: 0.99,
      }),
      step({
        action: 'read',
        price: '$99.00',
        currency: 'USD',
        confidence: 0.95,
      }),
    )
    const result = await solveOnPage(page, {
      problem: { code: 'not_found', message: 'No price.' },
      currencyHint: '',
      settings,
      endpoint,
      accept: acceptAll,
      fetchImpl,
    })
    expect(result).toMatchObject({
      status: 'solved',
      readByAi: true,
      recipe: null,
      offer: { amount: 99, currency: 'USD', method: 'ai' },
    })
    expect(result.steps[0]).toMatchObject({ result: 'not_in_page' })
  })

  it('stops at a bot check instead of touching it', async () => {
    const { page } = fakePage({
      states: { start: NO_PRICE, wall: CHALLENGE },
      controls: {
        start: [{ tag: 'button', text: 'Accept cookies', selector: '#accept' }],
      },
      clicks: { '#accept': 'wall' },
    })
    const { fetchImpl } = modelAnswers(step({ action: 'click', target: 0 }))
    const result = await solveOnPage(page, {
      problem: { code: 'not_found', message: 'No price.' },
      currencyHint: '',
      settings,
      endpoint,
      accept: acceptAll,
      fetchImpl,
    })
    expect(result.status).toBe('challenge')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses unknown controls and screenshots without vision, then gives up', async () => {
    const { page } = fakePage({ states: { start: NO_PRICE } })
    const { fetchImpl } = modelAnswers(
      step({ action: 'click', target: 7 }),
      step({ action: 'screenshot' }),
      step({ action: 'give_up', reason: 'Price is hidden.' }),
    )
    const result = await solveOnPage(page, {
      problem: { code: 'not_found', message: 'No price.' },
      currencyHint: '',
      settings,
      endpoint,
      accept: acceptAll,
      fetchImpl,
    })
    expect(result.status).toBe('gave_up')
    expect(result.steps.map((entry) => entry.result)).toEqual([
      'refused: unknown control',
      'refused: the model is not set up to read images',
      'Price is hidden.',
    ])
  })

  it('stops after the step limit and reports AI endpoint failures', async () => {
    const { page } = fakePage({ states: { start: NO_PRICE } })
    const { fetchImpl } = modelAnswers(
      ...Array.from({ length: 10 }, () => step({ action: 'scroll' })),
    )
    const limited = await solveOnPage(page, {
      problem: { code: 'not_found', message: 'No price.' },
      currencyHint: '',
      settings,
      endpoint,
      accept: acceptAll,
      fetchImpl,
      maxSteps: 3,
    })
    expect(limited.status).toBe('failed')
    expect(limited.aiCalls).toBe(3)

    const failing = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const broken = await solveOnPage(page, {
      problem: { code: 'not_found', message: 'No price.' },
      currencyHint: '',
      settings,
      endpoint,
      accept: acceptAll,
      fetchImpl: failing,
    })
    expect(broken.status).toBe('failed')
    expect(broken.note).toContain('Could not reach the AI endpoint')
  })
})

describe('replayRecipe', () => {
  it('replays steps without AI and skips missing controls', async () => {
    const { page, clicked } = fakePage({
      states: { start: NO_PRICE, accepted: PRICED },
      clicks: { '#accept': 'accepted' },
    })
    const result = await replayRecipe(
      page,
      [
        { action: 'escape' },
        { action: 'click', selector: '#accept', label: 'Accept cookies' },
      ],
      { currencyHint: '' },
    )
    expect(result).toMatchObject({
      challenge: false,
      offer: { amount: 118.5, currency: 'USD' },
    })
    expect(clicked).toEqual(['#accept'])
  })
})
