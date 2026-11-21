import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aiFallbackAllowed,
  AI_FAILURES_BEFORE_COOLDOWN,
  AI_FRAGMENT_MAX_BYTES,
  appearsLiterally,
  buildPriceFragment,
  extractOfferWithAi,
  parseAiOfferAnswer,
} from '@/lib/price-monitor/ai'
import {
  AiClientError,
  aiBudgetRefusal,
  listAiModels,
  isReasoningModel,
  parseJsonAnswer,
  PLANNING_TIMEOUT_MS,
  REASONING_MAX_TOKENS,
  REASONING_MIN_TIMEOUT_MS,
  REASONING_PURPOSES,
  requestJsonCompletion,
  resetAiModelProfiles,
  SAFE_ANSWER_TOKENS,
  setAiBudgetGate,
  setAiCallObserver,
  stripThinking,
  type AiCallEvent,
} from '@/lib/price-monitor/ai-client'
import {
  redactSecrets,
  redactSecretsDeep,
  rememberSecret,
} from '@/lib/price-monitor/secret-registry'
import {
  DEFAULT_PRICE_MONITORING,
  normalizeAiBaseUrl,
  normalizePriceMonitoring,
  parseAiHeaders,
} from '@/lib/settings-shared'

const KEY = 'sk-test-0123456789abcdef'
const endpoint = { baseUrl: 'http://localhost:11434/v1', apiKey: KEY }

const PAGE = `<!doctype html><html><head>
<title>Raccoon folding knife</title>
<meta property="product:price:amount" content="129.00">
<style>.price{color:red}</style>
<script>window.tracking = "secret-ish"; var price = 999</script>
<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
</head><body>
<header><a class="cart-link" href="/cart">Cart (0)</a></header>
<h1>Raccoon</h1>
<div class="product-main" data-tracking="abc">
  <div class="price-box"><span class="price price--old">$149.00</span>
  <span class="price price--sale" style="color:red">$129.00</span></div>
  <p class="stock">In stock</p>
</div>
<footer>${'Lorem ipsum '.repeat(50)}</footer>
</body></html>`

function chatResponse(content: unknown, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  resetAiModelProfiles()
  setAiCallObserver(null)
})

describe('buildPriceFragment', () => {
  it('keeps the title, price meta and price elements, without scripts or styles', () => {
    const fragment = buildPriceFragment(PAGE)
    expect(fragment).toContain('Title: Raccoon folding knife')
    expect(fragment).toContain('product:price:amount="129.00"')
    expect(fragment).toContain('$129.00')
    expect(fragment).toContain('In stock')
    expect(fragment).not.toContain('window.tracking')
    expect(fragment).not.toContain('color:red')
    expect(fragment).not.toContain('data-tracking')
    expect(fragment).not.toContain('style=')
    expect(fragment).not.toContain('Lorem ipsum')
    // JSON-LD without offers is left out.
    expect(fragment).not.toContain('BreadcrumbList')
  })

  it('includes JSON-LD offers and stays within 8 KB on huge pages', () => {
    const offers = `<script type="application/ld+json">{"@type":"Product","offers":{"price":"89.50","priceCurrency":"EUR"}}</script>`
    const rows = Array.from(
      { length: 400 },
      (_, index) =>
        `<li class="related-product"><span class="price">€${index}.99</span> Ünïcödé knife ${index}</li>`,
    ).join('')
    const html = `<html><head><title>Big</title>${offers}</head><body><ul>${rows}</ul></body></html>`
    const fragment = buildPriceFragment(html)
    expect(fragment).toContain('"price":"89.50"')
    expect(Buffer.byteLength(fragment, 'utf8')).toBeLessThanOrEqual(
      AI_FRAGMENT_MAX_BYTES,
    )
    expect(fragment).not.toContain('�')
  })

  it('adds the rest of the cleaned page when the budget is large', () => {
    const rows = Array.from(
      { length: 2000 },
      (_, index) => `<p data-x="${index}">Detail line ${index}</p>`,
    ).join('')
    const html = `<html><head><title>Big</title></head><body>
      <!-- tracking comment -->
      <div class="buy-box"><span class="price">$129.00</span></div>
      <section style="color:red">${rows}<b>Final sale $99.00</b></section>
      <script>var price = 1</script></body></html>`
    const small = buildPriceFragment(html)
    expect(small).not.toContain('Final sale')
    const large = buildPriceFragment(html, 200 * 1024)
    // Price elements first, then the page.
    expect(large.indexOf('$129.00')).toBeLessThan(large.indexOf('Page:'))
    expect(large).toContain('Final sale $99.00')
    expect(large).toContain('Detail line 1999')
    expect(large).not.toContain('tracking comment')
    expect(large).not.toContain('var price')
    expect(large).not.toContain('style=')
    expect(large).not.toContain('data-x')
    const capped = buildPriceFragment(html, 20 * 1024)
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(20 * 1024)
    expect(capped).toContain('$129.00')
  })

  it('returns an empty fragment for an empty page', () => {
    expect(buildPriceFragment('<html><body></body></html>')).toBe('')
  })
})

describe('appearsLiterally', () => {
  const fragment = '<span class="price">$1,129.00</span> 49,90 € and 7 left'
  it('matches prices as written, including non-breaking spaces', () => {
    expect(appearsLiterally('$1,129.00', fragment)).toBe(true)
    expect(appearsLiterally('49,90 €', fragment)).toBe(true)
  })
  it('rejects prices inside longer numbers and invented prices', () => {
    expect(appearsLiterally('129.00', fragment)).toBe(false)
    expect(appearsLiterally('1,129', fragment)).toBe(false)
    expect(appearsLiterally('$99.00', fragment)).toBe(false)
    expect(appearsLiterally('in stock', fragment)).toBe(false)
  })
})

describe('parseAiOfferAnswer', () => {
  const fragment = buildPriceFragment(PAGE)

  it('accepts a confident answer quoted from the page', () => {
    expect(
      parseAiOfferAnswer(
        {
          price: '$129.00',
          currency: 'usd',
          availability: 'in_stock',
          confidence: 0.92,
        },
        fragment,
      ),
    ).toEqual({
      status: 'ok',
      confidence: 0.92,
      offer: {
        amount: 129,
        currency: 'USD',
        availability: 'in_stock',
        method: 'ai',
      },
    })
  })

  it('uses the currency hint and maps schema.org availability', () => {
    const result = parseAiOfferAnswer(
      {
        price: '129.00',
        currency: null,
        availability: 'https://schema.org/OutOfStock',
        confidence: 1,
      },
      '<meta product:price:amount="129.00">',
      'EUR',
    )
    expect(result).toMatchObject({
      status: 'ok',
      offer: { amount: 129, currency: 'EUR', availability: 'out_of_stock' },
    })
  })

  it('rejects low confidence, invented prices, bad amounts and missing prices', () => {
    const answer = (patch: Record<string, unknown>) =>
      parseAiOfferAnswer(
        {
          price: '$129.00',
          currency: 'USD',
          availability: 'in_stock',
          confidence: 0.9,
          ...patch,
        },
        fragment,
      )
    expect(answer({ confidence: 0.69 })).toEqual({
      status: 'rejected',
      reason: 'low_confidence',
    })
    expect(answer({ confidence: 'very' })).toMatchObject({
      reason: 'low_confidence',
    })
    expect(answer({ price: '$119.00' })).toEqual({
      status: 'rejected',
      reason: 'not_in_page',
    })
    expect(answer({ price: null })).toEqual({
      status: 'rejected',
      reason: 'not_found',
    })
    expect(
      parseAiOfferAnswer(
        { price: '0.00', confidence: 0.9 },
        '<span class="price">0.00</span>',
      ),
    ).toEqual({ status: 'rejected', reason: 'invalid_price' })
    expect(parseAiOfferAnswer('nonsense', fragment)).toEqual({
      status: 'rejected',
      reason: 'not_found',
    })
  })
})

describe('aiFallbackAllowed', () => {
  const settings = {
    ...DEFAULT_PRICE_MONITORING.ai,
    enabled: true,
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
  }
  const now = Date.UTC(2026, 10, 18, 12)
  it('needs AI configured and the fallback on', () => {
    expect(aiFallbackAllowed({ settings, lastAiAt: null, now })).toBe(true)
    expect(
      aiFallbackAllowed({
        settings: { ...settings, extractionFallback: false },
        lastAiAt: null,
        now,
      }),
    ).toBe(false)
    expect(
      aiFallbackAllowed({
        settings: { ...settings, enabled: false },
        lastAiAt: null,
        now,
      }),
    ).toBe(false)
    expect(
      aiFallbackAllowed({
        settings: { ...settings, model: '' },
        lastAiAt: null,
        now,
      }),
    ).toBe(false)
  })
  const hoursAgo = (hours: number) =>
    new Date(now - hours * 3_600_000).toISOString()
  it('Limited: uses AI at most once per source per configured hours', () => {
    expect(aiFallbackAllowed({ settings, lastAiAt: hoursAgo(23), now })).toBe(
      false,
    )
    expect(aiFallbackAllowed({ settings, lastAiAt: hoursAgo(24), now })).toBe(
      true,
    )
    const sixHours = {
      ...settings,
      usage: { ...settings.usage, sourceCooldownHours: 6 },
    }
    expect(
      aiFallbackAllowed({ settings: sixHours, lastAiAt: hoursAgo(6), now }),
    ).toBe(true)
    expect(
      aiFallbackAllowed({ settings: sixHours, lastAiAt: hoursAgo(5), now }),
    ).toBe(false)
  })
  it('Unlimited: no wait, except for a source that keeps failing', () => {
    const unlimited = {
      ...settings,
      usage: { ...settings.usage, mode: 'unlimited' as const },
    }
    expect(
      aiFallbackAllowed({ settings: unlimited, lastAiAt: hoursAgo(0), now }),
    ).toBe(true)
    expect(
      aiFallbackAllowed({
        settings: unlimited,
        lastAiAt: hoursAgo(0),
        now,
        consecutiveFailures: AI_FAILURES_BEFORE_COOLDOWN - 1,
      }),
    ).toBe(true)
    expect(
      aiFallbackAllowed({
        settings: unlimited,
        lastAiAt: hoursAgo(23),
        now,
        consecutiveFailures: AI_FAILURES_BEFORE_COOLDOWN,
      }),
    ).toBe(false)
    expect(
      aiFallbackAllowed({
        settings: unlimited,
        lastAiAt: hoursAgo(24),
        now,
        consecutiveFailures: AI_FAILURES_BEFORE_COOLDOWN,
      }),
    ).toBe(true)
  })
})

describe('AI settings normalization', () => {
  it('validates the base URL and model and merges partial updates', () => {
    expect(normalizeAiBaseUrl(' http://localhost:11434/v1/ ')).toBe(
      'http://localhost:11434/v1',
    )
    expect(normalizeAiBaseUrl('ftp://example.com')).toBeNull()
    expect(normalizeAiBaseUrl('https://user:pw@example.com/v1')).toBeNull()
    expect(normalizeAiBaseUrl('https://example.com/v1?key=x')).toBeNull()

    const current = normalizePriceMonitoring({
      ai: {
        enabled: true,
        baseUrl: 'https://api.example.com/v1/',
        model: 'm1',
      },
    })
    expect(current.ai).toEqual({
      enabled: true,
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      headers: {},
      extractionFallback: true,
      advisor: true,
      resolveErrors: true,
      vision: false,
      findMovedPages: true,
      autoRelink: false,
      fixVariants: true,
      retryBlocked: true,
      confirmChanges: true,
      spotCheck: true,
      dailyDigest: true,
      maxPageKb: 200,
      maxAnswerTokens: 16_384,
      usage: {
        mode: 'limited',
        dailyCalls: 200,
        dailyTokens: 2_000_000,
        sourceCooldownHours: 24,
      },
      agentMode: 'off',
    })
    expect(
      normalizePriceMonitoring({ ai: { agentMode: 'act' } }, current).ai
        .agentMode,
    ).toBe('act')
    expect(
      normalizePriceMonitoring({ ai: { agentMode: 'yolo' } }, current).ai
        .agentMode,
    ).toBe('off')
    // Usage: a partial update keeps the rest; bad values fall back.
    expect(
      normalizePriceMonitoring(
        { ai: { usage: { mode: 'unlimited', dailyCalls: -5 } } },
        current,
      ).ai.usage,
    ).toEqual({
      mode: 'unlimited',
      dailyCalls: 0,
      dailyTokens: 2_000_000,
      sourceCooldownHours: 24,
    })
    expect(
      normalizePriceMonitoring({ ai: { usage: { mode: 'turbo' } } }, current).ai
        .usage.mode,
    ).toBe('limited')
    // Page size and answer limit stay within their bounds.
    expect(
      normalizePriceMonitoring(
        { ai: { maxPageKb: 5000, maxAnswerTokens: 10 } },
        current,
      ).ai,
    ).toMatchObject({ maxPageKb: 1000, maxAnswerTokens: 1024 })
    expect(
      normalizePriceMonitoring({ ai: { maxPageKb: 'x' } }, current).ai
        .maxPageKb,
    ).toBe(200)
    const next = normalizePriceMonitoring(
      { ai: { advisor: false, baseUrl: 'not a url' } },
      current,
    )
    expect(next.ai).toEqual({ ...current.ai, advisor: false })
    expect(
      normalizePriceMonitoring({ ai: { baseUrl: '  ' } }, current).ai.baseUrl,
    ).toBe('')
    expect(normalizePriceMonitoring({}).ai).toEqual(DEFAULT_PRICE_MONITORING.ai)
  })
})

describe('custom AI headers', () => {
  it('accepts a JSON object of string headers', () => {
    expect(
      parseAiHeaders(
        '{ "x-opencode-session": " s-1 ", "User-Agent": "github-copilot-chat/1.0" }',
      ),
    ).toEqual({
      ok: true,
      headers: {
        'x-opencode-session': 's-1',
        'User-Agent': 'github-copilot-chat/1.0',
      },
    })
    expect(parseAiHeaders('  ')).toEqual({ ok: true, headers: {} })
  })

  it('rejects invalid, reserved and duplicate headers', () => {
    for (const value of [
      'not json',
      '[]',
      '{"bad name": "x"}',
      '{"Authorization": "Bearer x"}',
      '{"Host": "evil.example"}',
      '{"X-A": 1}',
      '{"X-A": "line\\nbreak"}',
      '{"X-A": "a", "x-a": "b"}',
    ])
      expect(parseAiHeaders(value).ok, value).toBe(false)
  })

  it('keeps saved headers when an update is invalid', () => {
    const current = normalizePriceMonitoring({
      ai: { headers: { 'x-opencode-session': 'bv' } },
    })
    expect(current.ai.headers).toEqual({ 'x-opencode-session': 'bv' })
    expect(
      normalizePriceMonitoring({ ai: { headers: { Host: 'x' } } }, current).ai
        .headers,
    ).toEqual({ 'x-opencode-session': 'bv' })
    expect(
      normalizePriceMonitoring({ ai: { headers: {} } }, current).ai.headers,
    ).toEqual({})
  })

  it('sends custom headers with chat and model requests', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(chatResponse('{"ok":true}'))
      .mockResolvedValueOnce(
        new Response('{"data":[{"id":"m"}]}', { status: 200 }),
      )
    const withHeaders = {
      ...endpoint,
      headers: { 'x-opencode-session': 'bv-1' },
    }
    await requestJsonCompletion(
      withHeaders,
      {
        model: 'm',
        system: 's',
        user: 'u',
        schemaName: 'x',
        schema: { type: 'object' },
      },
      { timeoutMs: 1000, fetchImpl },
    )
    await listAiModels(withHeaders, { fetchImpl })
    for (const call of fetchImpl.mock.calls) {
      const sent = new Headers(call[1]?.headers)
      expect(sent.get('x-opencode-session')).toBe('bv-1')
      expect(sent.get('Authorization')).toBe(`Bearer ${KEY}`)
    }
  })
})

describe('AI client', () => {
  it('parses answers with code fences or surrounding prose', () => {
    expect(parseJsonAnswer('```json\n{"price":"1"}\n```')).toEqual({
      price: '1',
    })
    expect(parseJsonAnswer('Sure! {"price": null} Hope it helps')).toEqual({
      price: null,
    })
    expect(() => parseJsonAnswer('no json')).toThrow(AiClientError)
  })

  it('sends the key as a bearer token and falls back from json_schema to json_object', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"response_format not supported"}}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(chatResponse('{"ok":true}'))
    const result = await requestJsonCompletion(
      endpoint,
      {
        model: 'llama3.2',
        system: 's',
        user: 'u',
        schemaName: 'x',
        schema: { type: 'object' },
      },
      { timeoutMs: 1000, fetchImpl },
    )
    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      `Bearer ${KEY}`,
    )
    expect(init?.redirect).toBe('error')
    const first = JSON.parse(String(init?.body))
    const second = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))
    expect(first).toMatchObject({
      model: 'llama3.2',
      temperature: 0,
      response_format: { type: 'json_schema' },
    })
    expect(second.response_format).toEqual({ type: 'json_object' })
  })

  it('retries an empty answer from a reasoning model with a larger budget', async () => {
    const reasoningOnly = () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'length',
              message: { content: '', reasoning_content: 'Let me think…' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reasoningOnly())
      .mockResolvedValueOnce(chatResponse('{"ok":true}'))
    const request = {
      model: 'glm-5.3',
      system: 's',
      user: 'u',
      schemaName: 'x',
      schema: { type: 'object' },
      maxTokens: 200,
    }
    const result = await requestJsonCompletion(endpoint, request, {
      timeoutMs: 1000,
      fetchImpl,
    })
    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const first = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    const second = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))
    expect(first.max_tokens).toBe(200)
    expect(second.max_tokens).toBe(REASONING_MAX_TOKENS)
    // Same response format; only the budget changes.
    expect(second.response_format).toEqual(first.response_format)

    // A model learned as reasoning starts with the larger budget.
    expect(isReasoningModel(endpoint, 'glm-5.3')).toBe(true)
    resetAiModelProfiles()

    const always = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => reasoningOnly())
    const error = await requestJsonCompletion(endpoint, request, {
      timeoutMs: 1000,
      fetchImpl: always,
    }).catch((caught: unknown) => caught)
    expect(always).toHaveBeenCalledTimes(2)
    expect((error as AiClientError).code).toBe('invalid_response')
    expect((error as Error).message).toContain('reasoning')
  })

  it('starts later requests to a learned reasoning model with its budget', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"ok":1}',
                  reasoning_content: 'Thinking first.',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(chatResponse('{"ok":2}'))
    const request = {
      model: 'thinker',
      system: 's',
      user: 'u',
      schemaName: 'x',
      schema: { type: 'object' },
      maxTokens: 200,
    }
    expect(
      await requestJsonCompletion(endpoint, request, {
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).toEqual({ ok: 1 })
    expect(
      await requestJsonCompletion(endpoint, request, {
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).toEqual({ ok: 2 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const first = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    const second = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))
    expect(first.max_tokens).toBe(200)
    expect(second.max_tokens).toBe(REASONING_MAX_TOKENS)
    // Another model at the same endpoint is not affected.
    expect(isReasoningModel(endpoint, 'other')).toBe(false)
  })

  it('retries once with more time when a model times out', async () => {
    const timeouts: number[] = []
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const started = Date.now()
            init?.signal?.addEventListener('abort', () => {
              timeouts.push(Date.now() - started)
              reject(new Error('aborted'))
            })
          }),
      )
      .mockResolvedValueOnce(chatResponse('{"ok":true}'))
    const result = await requestJsonCompletion(
      endpoint,
      {
        model: 'slow',
        system: 's',
        user: 'u',
        schemaName: 'x',
        schema: { type: 'object' },
        maxTokens: 200,
      },
      { timeoutMs: 20, fetchImpl },
    )
    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(timeouts).toHaveLength(1)
    expect(isReasoningModel(endpoint, 'slow')).toBe(true)
    expect(REASONING_MIN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('does not retry a timeout when the caller cancelled', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
          controller.abort()
        }),
    )
    const error = await requestJsonCompletion(
      endpoint,
      { model: 'm', system: 's', user: 'u', schemaName: 'x', schema: {} },
      { timeoutMs: 1000, signal: controller.signal, fetchImpl },
    ).catch((caught: unknown) => caught)
    expect((error as AiClientError).code).toBe('cancelled')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries an answer cut off at the token limit', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'length',
                message: { content: '{"price": "12' },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(chatResponse('{"price":"12.00"}'))
    const result = await requestJsonCompletion(
      endpoint,
      {
        model: 'm',
        system: 's',
        user: 'u',
        schemaName: 'x',
        schema: {},
        maxTokens: 200,
      },
      { timeoutMs: 1000, fetchImpl },
    )
    expect(result).toEqual({ price: '12.00' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('uses the endpoint answer limit and lowers it when the model refuses it', async () => {
    const reasoningOnly = () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'length', message: { content: '' } }],
        }),
        { status: 200 },
      )
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reasoningOnly())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'max_tokens must be less than or equal to 8192',
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(chatResponse('{"ok":1}'))
      .mockResolvedValueOnce(chatResponse('{"ok":2}'))
    const big = { ...endpoint, maxAnswerTokens: 32_768 }
    const request = {
      model: 'r1',
      system: 's',
      user: 'u',
      schemaName: 'x',
      schema: {},
      maxTokens: 200,
    }
    expect(
      await requestJsonCompletion(big, request, { timeoutMs: 1000, fetchImpl }),
    ).toEqual({ ok: 1 })
    expect(
      await requestJsonCompletion(big, request, { timeoutMs: 1000, fetchImpl }),
    ).toEqual({ ok: 2 })
    const sent = fetchImpl.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
    )
    expect(sent.map((body) => body.max_tokens)).toEqual([
      200,
      32_768,
      SAFE_ANSWER_TOKENS,
      SAFE_ANSWER_TOKENS,
    ])
    // The response format did not change while lowering the limit.
    expect(sent[2].response_format).toEqual(sent[1].response_format)
  })

  it('asks OpenCode models to answer without thinking, and drops the field if refused', async () => {
    const opencode = {
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: KEY,
    }
    const request = {
      model: 'glm-5.1',
      system: 's',
      user: 'u',
      schemaName: 'x',
      schema: { type: 'object' },
    }
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(chatResponse('{"ok":1}'))
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"Unknown field: thinking"}}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(chatResponse('{"ok":2}'))
      .mockResolvedValueOnce(chatResponse('{"ok":3}'))
    expect(
      await requestJsonCompletion(opencode, request, {
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).toEqual({ ok: 1 })
    const other = { ...request, model: 'kimi-k2.6' }
    expect(
      await requestJsonCompletion(opencode, other, {
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).toEqual({ ok: 2 })
    expect(
      await requestJsonCompletion(opencode, other, {
        timeoutMs: 1000,
        fetchImpl,
      }),
    ).toEqual({ ok: 3 })
    const sent = fetchImpl.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
    )
    expect(sent[0].thinking).toEqual({ type: 'disabled' })
    expect(sent[1].thinking).toEqual({ type: 'disabled' })
    // Same format again, without the refused field, and not sent later.
    expect(sent[2].thinking).toBeUndefined()
    expect(sent[2].response_format).toEqual(sent[1].response_format)
    expect(sent[3].thinking).toBeUndefined()
  })

  it('does not send the thinking field to other endpoints', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(chatResponse('{"ok":true}'))
    await requestJsonCompletion(
      endpoint,
      {
        model: 'llama3.2',
        system: 's',
        user: 'u',
        schemaName: 'x',
        schema: { type: 'object' },
      },
      { timeoutMs: 1000, fetchImpl },
    )
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.thinking).toBeUndefined()
  })

  it('lets planning tasks reason with room from the start, apart from page reads', async () => {
    const opencode = {
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: KEY,
    }
    const request = {
      model: 'deepseek-v4.1-flash',
      system: 's',
      user: 'u',
      schemaName: 'x',
      schema: { type: 'object' },
      maxTokens: 300,
    }
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"plan":1}',
                  reasoning_content: 'Weighing every knife first.',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(chatResponse('{"price":"12.00"}'))
    expect(REASONING_PURPOSES.has('agent')).toBe(true)
    expect(REASONING_PURPOSES.has('extraction')).toBe(false)
    expect(
      await requestJsonCompletion(
        opencode,
        { ...request, purpose: 'agent' },
        { timeoutMs: 1000, fetchImpl },
      ),
    ).toEqual({ plan: 1 })
    expect(
      await requestJsonCompletion(
        opencode,
        { ...request, purpose: 'extraction' },
        { timeoutMs: 1000, fetchImpl },
      ),
    ).toEqual({ price: '12.00' })
    const [planning, reading] = fetchImpl.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
    )
    // The supervisor may think, with the reasoning budget at once.
    expect(planning.thinking).toBeUndefined()
    expect(planning.max_tokens).toBe(REASONING_MAX_TOKENS)
    // A page read still asks not to think and keeps its small budget.
    expect(reading.thinking).toEqual({ type: 'disabled' })
    expect(reading.max_tokens).toBe(300)
    // What was learned from planning stays with planning.
    expect(isReasoningModel(opencode, 'deepseek-v4.1-flash', 'agent')).toBe(
      true,
    )
    expect(isReasoningModel(opencode, 'deepseek-v4.1-flash')).toBe(false)
    expect(PLANNING_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000)
  })

  it('refuses requests the budget gate stops, without sending or reporting', async () => {
    const events: AiCallEvent[] = []
    setAiCallObserver((event) => events.push(event))
    setAiBudgetGate(() => 'The daily AI budget is used up.')
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(chatResponse('{"ok":true}'))
      const request = {
        model: 'm',
        system: 's',
        user: 'u',
        schemaName: 'x',
        schema: {},
      }
      const error = await requestJsonCompletion(
        endpoint,
        { ...request, purpose: 'extraction' },
        { timeoutMs: 1000, fetchImpl },
      ).catch((caught: unknown) => caught)
      expect((error as AiClientError).code).toBe('budget')
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(events).toHaveLength(0)
      expect(aiBudgetRefusal('solver')).toContain('budget')
      // Connection tests always go through.
      expect(aiBudgetRefusal('test')).toBeNull()
      await requestJsonCompletion(
        endpoint,
        { ...request, purpose: 'test' },
        { timeoutMs: 1000, fetchImpl },
      )
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      setAiBudgetGate(null)
    }
    expect(aiBudgetRefusal('solver')).toBeNull()
  })

  it('removes inline thinking from answers', () => {
    expect(stripThinking('<think>price is 5?</think>{"a":1}')).toBe('{"a":1}')
    expect(stripThinking('<think>still going')).toBe('')
    expect(parseJsonAnswer('<think>{"wrong":1}</think>\n{"a":2}')).toEqual({
      a: 2,
    })
  })

  it('reports each call to the journal observer without content', async () => {
    const events: AiCallEvent[] = []
    setAiCallObserver((event) => events.push(event))
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 120, completion_tokens: 8 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
    const request = {
      model: 'm',
      system: 's',
      user: 'secret page text',
      schemaName: 'x',
      schema: {},
      purpose: 'extraction' as const,
    }
    await requestJsonCompletion(endpoint, request, {
      timeoutMs: 1000,
      fetchImpl,
    })
    await requestJsonCompletion(endpoint, request, {
      timeoutMs: 1000,
      fetchImpl,
    }).catch(() => null)
    // Without a purpose nothing is reported.
    await requestJsonCompletion(
      endpoint,
      { ...request, purpose: undefined },
      {
        timeoutMs: 1000,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(chatResponse('{}')),
      },
    )
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      purpose: 'extraction',
      model: 'm',
      ok: true,
      attempts: 1,
      promptTokens: 120,
      completionTokens: 8,
      errorCode: null,
    })
    expect(events[1]).toMatchObject({ ok: false, errorCode: 'http' })
    expect(JSON.stringify(events)).not.toContain('secret page text')
  })

  it('never puts the key into error messages', async () => {
    rememberSecret(KEY)
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: `Invalid key ${KEY} provided` } }),
          { status: 401 },
        ),
      )
    const error = await requestJsonCompletion(
      endpoint,
      { model: 'm', system: 's', user: 'u', schemaName: 'x', schema: {} },
      { timeoutMs: 1000, fetchImpl },
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiClientError)
    expect((error as AiClientError).status).toBe(401)
    expect((error as Error).message).toContain('HTTP 401')
    expect((error as Error).message).toContain('Check the API key')
    expect((error as Error).message).not.toContain(KEY)

    const network = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new TypeError('fetch failed', { cause: new Error(`Bearer ${KEY}`) }),
      )
    const networkError = await listAiModels(endpoint, {
      fetchImpl: network,
    }).catch((caught: unknown) => caught)
    expect((networkError as AiClientError).code).toBe('network')
    expect((networkError as Error).message).not.toContain(KEY)
  })

  it('redacts remembered secrets in text and nested values', () => {
    rememberSecret(KEY)
    expect(redactSecrets(`key=${KEY}`)).toBe('key=[redacted]')
    expect(redactSecretsDeep({ a: [{ b: `x ${KEY} y` }], c: 1 })).toEqual({
      a: [{ b: 'x [redacted] y' }],
      c: 1,
    })
    const untouched = { a: 1 }
    expect(redactSecretsDeep(untouched)).toBe(untouched)
  })

  it('lists model ids from OpenAI and Ollama style responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ models: [{ name: 'llama3.2' }] }))
      .mockResolvedValueOnce(Response.json({ nothing: true }))
    expect(await listAiModels(endpoint, { fetchImpl })).toEqual([
      'gpt-a',
      'gpt-b',
    ])
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:11434/v1/models')
    expect(
      await listAiModels({ ...endpoint, apiKey: null }, { fetchImpl }),
    ).toEqual(['llama3.2'])
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).has('Authorization'),
    ).toBe(false)
    await expect(listAiModels(endpoint, { fetchImpl })).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('refuses an invalid base URL before sending anything', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      listAiModels({ baseUrl: 'file:///etc', apiKey: KEY }, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'config' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('extractOfferWithAi', () => {
  it('sends only the trimmed fragment and validates the answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      chatResponse(
        JSON.stringify({
          price: '$129.00',
          currency: 'USD',
          availability: 'in_stock',
          confidence: 0.95,
        }),
      ),
    )
    const result = await extractOfferWithAi({
      html: PAGE,
      endpoint,
      model: 'llama3.2',
      fetchImpl,
    })
    expect(result).toMatchObject({
      status: 'ok',
      offer: { amount: 129, currency: 'USD', method: 'ai' },
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    const user = body.messages[1].content as string
    expect(user).toContain('$129.00')
    expect(user).not.toContain('window.tracking')
    expect(Buffer.byteLength(user, 'utf8')).toBeLessThan(
      AI_FRAGMENT_MAX_BYTES + 100,
    )
  })

  it('rejects a hallucinated price', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        chatResponse(
          '{"price":"$99.00","currency":"USD","availability":"in_stock","confidence":0.99}',
        ),
      )
    const result = await extractOfferWithAi({
      html: PAGE,
      endpoint,
      model: 'm',
      fetchImpl,
    })
    expect(result).toMatchObject({ status: 'rejected', reason: 'not_in_page' })
  })
})
