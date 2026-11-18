import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aiFallbackAllowed,
  AI_FRAGMENT_MAX_BYTES,
  appearsLiterally,
  buildPriceFragment,
  extractOfferWithAi,
  parseAiOfferAnswer,
} from '@/lib/price-monitor/ai'
import {
  AiClientError,
  listAiModels,
  parseJsonAnswer,
  requestJsonCompletion,
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
  it('uses AI at most once per source per 24 hours', () => {
    const hoursAgo = (hours: number) =>
      new Date(now - hours * 3_600_000).toISOString()
    expect(aiFallbackAllowed({ settings, lastAiAt: hoursAgo(23), now })).toBe(
      false,
    )
    expect(aiFallbackAllowed({ settings, lastAiAt: hoursAgo(24), now })).toBe(
      true,
    )
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
    })
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
