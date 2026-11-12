import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isSecurityChallengePage, scrapeProduct } from '@/lib/scrape'
import { isAmazonProductUrl } from '@/lib/scrape-amazon'

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/scrape/${name}.html`, import.meta.url),
    'utf8',
  )

const emptySpecs = {
  weight: '',
  overallLength: '',
  bladeLength: '',
  bladeThickness: '',
  bladeCoating: '',
  bladeMaterial: '',
  lockingMechanism: '',
  designer: '',
  modelNumber: '',
  handleLength: '',
  hardness: '',
  price: '',
  country: '',
}

describe('Amazon product scraping', () => {
  it('recognizes product URLs only', () => {
    expect(isAmazonProductUrl('https://www.amazon.com/dp/B0FRRWK52D')).toBe(
      true,
    )
    expect(
      isAmazonProductUrl(
        'https://www.amazon.co.uk/Vosteed-Porcupine/dp/B0FRRWK52D?th=1',
      ),
    ).toBe(true)
    expect(
      isAmazonProductUrl('https://www.amazon.com/gp/product/B07CSBPN9F'),
    ).toBe(true)
    expect(isAmazonProductUrl('https://www.amazon.com/s?k=knife')).toBe(false)
    expect(isAmazonProductUrl('https://amazon.example.com/dp/B0FRRWK52D')).toBe(
      false,
    )
  })

  it('reads the listing instead of recommendations and catalog categories', () => {
    const { product, warnings } = scrapeProduct(
      fixture('amazon-vosteed-porcupine-a2611'),
      'https://www.amazon.com/dp/B0FRRWK52D?th=1',
      'https://www.amazon.com/dp/B0FRRWK52D',
    )

    expect(warnings).toBeUndefined()
    expect(product).toMatchObject({
      name: 'Porcupine',
      brand: 'Vosteed',
      bladeStyle: 'Drop Point',
      handleMaterial: 'Micarta',
      sourceUrl: 'https://www.amazon.com/dp/B0FRRWK52D',
      specs: {
        ...emptySpecs,
        bladeLength: '2.99 inches',
        // The title names the steel; the catalog only says "Alloy Steel".
        bladeMaterial: '14C28N',
        lockingMechanism: 'Top Liner Lock',
        modelNumber: 'A2611',
      },
    })
    expect(product.description.split('\n\n')).toHaveLength(5)
    expect(product.description).toMatch(
      /^【Porcupine Thumb Stud Version — Born from Real Feedback】/,
    )
    expect(product.description).not.toMatch(/About this item|Customers say/)
    expect(product.images).toEqual(
      [
        '71CAnLOVBkL',
        '81qpI5pBoPL',
        '81VSTxnYiNL',
        '81bujU4xLnL',
        '81Zxc+n+CSL',
        '819OxNtSrCL',
        '8188LSc+F1L',
      ].map(
        (id) => `https://m.media-amazon.com/images/I/${id}._AC_SL1500_.jpg`,
      ),
    )
  })

  it('prefers the title handle over other materials named in it', () => {
    const { product } = scrapeProduct(
      fixture('amazon-vosteed-raccoon-2-a2928'),
      'https://www.amazon.com/dp/B0GH6J4QRS?th=1',
      'https://www.amazon.com/dp/B0GH6J4QRS',
    )

    expect(product).toMatchObject({
      name: 'Raccoon2.0',
      brand: 'Vosteed',
      // "Copper Dune Blade" must not become a copper handle.
      handleMaterial: 'Micarta',
      bladeStyle: 'Sheepsfoot',
      specs: {
        ...emptySpecs,
        bladeLength: '3.25 inches',
        bladeMaterial: '14C28N',
        lockingMechanism: 'Top Liner Lock',
        modelNumber: 'A2928',
      },
    })
    expect(product.images).toHaveLength(6)
    expect(product.images[0]).toBe(
      'https://m.media-amazon.com/images/I/71KHSz8je0L._SL1500_.jpg',
    )
  })

  it('reads detail bullets, buy-box price, and the main image of older listings', () => {
    const html = `<html><body>
      <span id="productTitle">Spyderco Para 3 Lightweight Knife with 2.95" CTS BD1N Steel Blade and Black FRCP Handle - PlainEdge - C223PBK</span>
      <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">$109.95</span></span></div>
      <div id="imgTagWrapperId"><img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/51abc._AC_SL1500_.jpg" src="https://m.media-amazon.com/images/I/51abc._AC_SX425_.jpg"></div>
      <div id="feature-bullets"><ul><li><span class="a-list-item">Compression Lock for strong, ambidextrous lockup.</span></li></ul></div>
      <div id="detailBullets_feature_div"><ul>
        <li><span class="a-list-item"><span class="a-text-bold">Item model number &rlm; : &lrm;</span><span>C223PBK</span></span></li>
        <li><span class="a-list-item"><span class="a-text-bold">Item Weight &rlm; : &lrm;</span><span>2.9 Ounces</span></span></li>
        <li><span class="a-list-item"><span class="a-text-bold">Country of Origin &rlm; : &lrm;</span><span>USA</span></span></li>
      </ul></div>
      <div id="sims-consolidated-1_feature_div"><span class="a-offscreen">$12.99</span> Kershaw Leek S30V Frame Lock</div>
    </body></html>`
    const { product } = scrapeProduct(
      html,
      'https://www.amazon.com/dp/B0CNJYZLTY',
    )

    expect(product.brand).toBe('Spyderco')
    expect(product.images).toEqual([
      'https://m.media-amazon.com/images/I/51abc._AC_SL1500_.jpg',
    ])
    expect(product.specs).toMatchObject({
      bladeLength: '2.95 in',
      bladeMaterial: 'CTS BD1N',
      lockingMechanism: 'Compression Lock',
      modelNumber: 'C223PBK',
      weight: '2.9 Ounces',
      price: '109.95 USD',
      country: 'USA',
    })
  })

  it('treats the "unusual browser activity" checkpoint as a challenge', () => {
    expect(isSecurityChallengePage(fixture('amazon-checkpoint'))).toBe(true)
    expect(
      isSecurityChallengePage(fixture('amazon-vosteed-porcupine-a2611')),
    ).toBe(false)
    expect(
      isSecurityChallengePage(
        '<html><body><p>We’re noticing unusual activity. Check the box to confirm you’re human.</p></body></html>',
      ),
    ).toBe(true)
  })
})
