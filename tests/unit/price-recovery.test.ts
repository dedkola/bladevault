import { describe, expect, it, vi } from 'vitest'
import type { Knife } from '@/lib/data'
import type { VerifyDecision } from '@/lib/price-monitor/discovery-ai'
import {
  describeVariant,
  detectMovedPage,
  expectedVariantFor,
  isSoftMissingPage,
  looksLikeProductPage,
  productPageAcceptor,
  productPageUrl,
  readPageVariant,
  relinkSafeToApply,
  relinkSearch,
  variantMismatch,
} from '@/lib/price-monitor/recovery'
import {
  findProductLinks,
  MAX_SOLVER_STEPS,
  MAX_SOLVER_STEPS_UNLIMITED,
  solverLimits,
  storeSearchUrls,
} from '@/lib/price-monitor/solver'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const PRODUCT = `<html><head><title>Para 3</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Spyderco Para 3 Lightweight","sku":"C223PBK","brand":{"@type":"Brand","name":"Spyderco"},"offers":{"@type":"Offer","price":"139.95","priceCurrency":"USD","sku":"C223PBK"}}</script>
</head><body><main><h1>Spyderco Para 3 Lightweight</h1><p>Model C223PBK</p></main></body></html>`
const CATEGORY = `<html><head><title>Folding knives</title></head><body>
<nav><a href="/account/login">Sign in</a></nav>
<main><h1>Folding knives</h1>
<a href="/products/para-3-lightweight">Spyderco Para 3 Lightweight</a>
<a href="/products/para-military-2">Spyderco Para Military 2</a>
<a href="/products/delica-4">Spyderco Delica 4</a>
<a href="/cart">Cart</a>
<a href="https://other.example/products/para-3">Para 3 elsewhere</a>
</main></body></html>`
const NOT_FOUND = `<html><head><title>Page not found – Shop</title></head><body><h1>Oops</h1></body></html>`
const SHOPIFY_VARIANTS = (selected: string) => `<html><body>
<form action="/cart/add" method="post"><select name="id">
<option value="111"${selected === '111' ? ' selected' : ''}>Black / Plain</option>
<option value="222"${selected === '222' ? ' selected' : ''}>Blue / Serrated</option>
</select></form></body></html>`

const knife = (patch: Partial<Knife['specs']> = {}) =>
  ({
    id: 'k1',
    name: 'Para 3 Lightweight',
    brand: 'Spyderco',
    specs: { modelNumber: 'C223PBK', ...patch },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as Knife

describe('page kinds', () => {
  it('reports a redirect to a category page without a price as moved', () => {
    expect(
      detectMovedPage({
        sourceUrl: 'https://shop.example/products/para-3',
        finalUrl: 'https://shop.example/collections/folding',
        html: CATEGORY,
        hasPrice: false,
      }),
    ).toBe(true)
    // The same path, a product page, or a price read: not moved.
    expect(
      detectMovedPage({
        sourceUrl: 'https://shop.example/products/para-3/',
        finalUrl: 'https://www.shop.example/products/para-3',
        html: CATEGORY,
        hasPrice: false,
      }),
    ).toBe(false)
    expect(
      detectMovedPage({
        sourceUrl: 'https://shop.example/products/para-3',
        finalUrl: 'https://shop.example/products/para-3-lightweight',
        html: PRODUCT,
        hasPrice: false,
      }),
    ).toBe(false)
    expect(
      detectMovedPage({
        sourceUrl: 'https://shop.example/products/para-3',
        finalUrl: 'https://shop.example/collections/folding',
        html: CATEGORY,
        hasPrice: true,
      }),
    ).toBe(false)
  })

  it('finds "not found" pages that answered with HTTP 200', () => {
    expect(isSoftMissingPage(NOT_FOUND, false)).toBe(true)
    expect(
      isSoftMissingPage(
        '<html><body><main>This product is no longer available.</main></body></html>',
        false,
      ),
    ).toBe(true)
    expect(isSoftMissingPage(PRODUCT, false)).toBe(false)
    expect(isSoftMissingPage(NOT_FOUND, true)).toBe(false)
    expect(looksLikeProductPage(PRODUCT)).toBe(true)
    expect(looksLikeProductPage(CATEGORY)).toBe(false)
  })
})

describe('variants', () => {
  it('reads the selected Shopify variant, then the link variant', () => {
    expect(
      readPageVariant(SHOPIFY_VARIANTS('222'), 'https://s.example/products/x'),
    ).toEqual({ id: '222', label: 'Blue / Serrated' })
    // The page's selection wins over a link variant it no longer shows.
    expect(
      readPageVariant(
        SHOPIFY_VARIANTS('222'),
        'https://s.example/products/x?variant=111',
      ),
    ).toMatchObject({ id: '222' })
    expect(
      readPageVariant(
        SHOPIFY_VARIANTS('none'),
        'https://s.example/products/x?variant=222',
      ),
    ).toEqual({ id: '222' })
    expect(readPageVariant(PRODUCT, 'https://s.example/p')).toEqual({
      sku: 'C223PBK',
    })
    expect(readPageVariant(CATEGORY, 'https://s.example/c')).toBeNull()
  })

  it('reports a mismatch only for the same kind of identifier', () => {
    expect(variantMismatch({ id: '111' }, { id: '222' })).toBe(true)
    expect(variantMismatch({ id: '111' }, { id: '111', sku: 'X' })).toBe(false)
    expect(variantMismatch({ sku: 'C223-PBK' }, { sku: 'c223pbk' })).toBe(false)
    expect(variantMismatch({ sku: 'C223PBK' }, { sku: 'C223PBL' })).toBe(true)
    expect(variantMismatch({ id: '111' }, { sku: 'X' })).toBe(false)
    expect(variantMismatch(null, { id: '1' })).toBe(false)
    expect(variantMismatch({ id: '1' }, null)).toBe(false)
  })

  it('expects the link variant over a learned one', () => {
    expect(
      expectedVariantFor({
        url: 'https://s.example/products/x?variant=111',
        expected_variant: JSON.stringify({ id: '222', sku: 'B' }),
      }),
    ).toEqual({ id: '111' })
    expect(
      expectedVariantFor({
        url: 'https://s.example/products/x',
        expected_variant: JSON.stringify({ id: '222', label: 'Blue' }),
      }),
    ).toEqual({ id: '222', label: 'Blue' })
    expect(
      expectedVariantFor({ url: 'https://s.example/x', expected_variant: '{' }),
    ).toBeNull()
    expect(describeVariant({ id: '1', label: 'Blue' })).toBe('"Blue"')
    expect(describeVariant({ sku: 'X1' })).toBe('SKU X1')
  })
})

describe('finding a moved product', () => {
  it('searches with brand, name and model number', () => {
    const search = relinkSearch(knife())
    expect(search.queries[0]).toBe('Spyderco Para 3 Lightweight C223PBK')
    expect(search.product).toContain('model number C223PBK')
  })

  it('lists product-looking links of the same store, best first', () => {
    const links = findProductLinks(
      CATEGORY,
      'https://shop.example/collections/folding',
      ['Spyderco Para 3 Lightweight C223PBK'],
    )
    expect(links[0]).toEqual({
      url: 'https://shop.example/products/para-3-lightweight',
      text: 'Spyderco Para 3 Lightweight',
    })
    expect(links.map((link) => link.url)).not.toContain(
      'https://shop.example/cart',
    )
    expect(links.map((link) => link.url)).not.toContain(
      'https://other.example/products/para-3',
    )
    expect(links.map((link) => link.url)).not.toContain(
      'https://shop.example/account/login',
    )
  })

  it("builds the store's own search pages", () => {
    expect(storeSearchUrls('https://shop.example/x', '', 'Para 3')).toEqual([
      'https://shop.example/search?q=Para%203',
    ])
    expect(
      storeSearchUrls('https://shop.example/x', 'wp-content', 'Para 3'),
    ).toContain('https://shop.example/?s=Para%203&post_type=product')
    expect(storeSearchUrls('https://shop.example/x', '', ' ')).toEqual([])
  })

  it('turns product data links into product page links', () => {
    expect(
      productPageUrl('https://shop.example/products/para-3.js?x=1#top'),
    ).toBe('https://shop.example/products/para-3')
    expect(
      productPageUrl('https://shop.example/products/para-3?variant=5&utm=x'),
    ).toBe('https://shop.example/products/para-3?variant=5')
  })

  it('accepts a page only with the model number and AI’s yes', async () => {
    const verify = vi.fn(async (): Promise<VerifyDecision> => ({
      accepted: true,
      confidence: 0.9,
      reason: 'same',
      kind: null,
      sameModel: false,
    }))
    const accept = productPageAcceptor({
      knife: knife(),
      endpoint: { baseUrl: 'http://ai.test/v1', apiKey: null },
      model: 'm',
      verify,
    })
    expect(await accept({ url: 'u', html: PRODUCT })).toBe(true)
    expect(await accept({ url: 'u', html: CATEGORY })).toBe(false)
    expect(
      await accept({ url: 'u', html: PRODUCT.replaceAll('C223PBK', 'C223GP') }),
    ).toBe(false)
    // Only the product page reached AI; the others failed the page checks.
    expect(verify).toHaveBeenCalledTimes(1)
    verify.mockResolvedValueOnce({
      accepted: false,
      confidence: 0.9,
      reason: '',
      kind: null,
      sameModel: false,
    })
    expect(await accept({ url: 'u', html: PRODUCT })).toBe(false)
    // The exact model number on a knife page wins over AI's doubts.
    verify.mockResolvedValueOnce({
      accepted: false,
      confidence: 0.9,
      reason: 'The blade shape is described differently.',
      kind: 'knife',
      sameModel: true,
    })
    expect(await accept({ url: 'u', html: PRODUCT })).toBe(true)
  })

  it('applies a new link without asking only with the exact model number', () => {
    expect(relinkSafeToApply(knife(), PRODUCT)).toBe(true)
    expect(relinkSafeToApply(knife({ modelNumber: '' }), PRODUCT)).toBe(false)
    expect(relinkSafeToApply(knife({ modelNumber: 'C223GP' }), PRODUCT)).toBe(
      false,
    )
    expect(relinkSafeToApply(knife(), null)).toBe(false)
  })
})

describe('solver limits', () => {
  it('gives Unlimited AI more steps and time', () => {
    const ai = DEFAULT_PRICE_MONITORING.ai
    expect(solverLimits(ai).maxSteps).toBe(MAX_SOLVER_STEPS)
    expect(solverLimits({ usage: { ...ai.usage, mode: 'unlimited' } })).toEqual(
      {
        maxSteps: MAX_SOLVER_STEPS_UNLIMITED,
        budgetMs: 180_000,
      },
    )
  })
})
