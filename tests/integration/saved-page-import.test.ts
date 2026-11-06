import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import * as savedPageRoute from '@/app/api/scrape/saved-page/route'

const { lookup, requestExternalUrl } = vi.hoisted(() => ({
  lookup: vi.fn(),
  requestExternalUrl: vi.fn(),
}))
vi.mock('@/lib/external-http', () => ({ requestExternalUrl }))
vi.mock('dns/promises', () => ({ lookup }))

const pageUrl = 'https://www.buckknives.com/product/110-folding-hunter-knife/'
const productHtml = `<!DOCTYPE html>
<!-- saved from url=(0061)${pageUrl} -->
<html><head>
<title>110 Folding Hunter Knife | Buck Knives</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: '110 Folding Hunter Knife',
  brand: { '@type': 'Brand', name: 'Buck Knives' },
  image: ['https://cdn.buckknives.com/images/0110BRS-B.jpg'],
})}</script>
</head><body><main><h1>110 Folding Hunter Knife</h1>
<img src="110 Folding Hunter Knife_files/0110BRS-B-local.jpg">
</main></body></html>`
const challengeHtml = `<html><head><title>Just a moment...</title></head><body>
  <h1>www.buckknives.com</h1><h2>Performing security verification</h2>
  <p>This website uses a security service to protect against malicious bots.</p>
  </body></html>`
let vault: TempVault | null = null

function request(body: unknown) {
  return new Request('http://localhost/api/scrape/saved-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('saved page import API', () => {
  beforeEach(async () => {
    vault = await createTempVault()
    lookup.mockReset()
    requestExternalUrl.mockReset()
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })

  afterEach(async () => {
    await vault?.cleanup()
    vault = null
  })

  it('imports a saved product page that also loads verification scripts', async () => {
    const response = await savedPageRoute.POST(request({ html: productHtml }))
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.finalUrl).toBe(pageUrl)
    expect(data.product).toMatchObject({
      name: expect.stringContaining('110 Folding Hunter'),
      sourceUrl: pageUrl,
    })
    expect(data.product.images).toContain(
      'https://cdn.buckknives.com/images/0110BRS-B.jpg',
    )
    expect(
      data.product.images.some((src: string) => src.includes('_files/')),
    ).toBe(false)
    expect(requestExternalUrl).not.toHaveBeenCalled()
  })

  it('prefers the product URL the person entered', async () => {
    const entered = 'https://www.buckknives.com/product/110-slim-knife/'
    const response = await savedPageRoute.POST(
      request({ html: productHtml, url: entered }),
    )
    expect((await response.json()).product.sourceUrl).toBe(entered)
  })

  it('explains when the saved file is the verification page', async () => {
    const response = await savedPageRoute.POST(
      request({ html: challengeHtml, url: pageUrl }),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: 'challenge',
      error: expect.stringMatching(/security verification page/),
    })
  })

  it('asks for a URL when the file has no address and rejects private ones', async () => {
    const noAddress = await savedPageRoute.POST(
      request({ html: '<html><body><h1>Knife</h1></body></html>' }),
    )
    expect(noAddress.status).toBe(400)
    expect((await noAddress.json()).error).toMatch(/Paste the product URL/)

    const blocked = await savedPageRoute.POST(
      request({ html: productHtml, url: 'http://127.0.0.1/knife' }),
    )
    expect(blocked.status).toBe(400)
    expect((await blocked.json()).code).toBe('blocked_url')
  })
})
