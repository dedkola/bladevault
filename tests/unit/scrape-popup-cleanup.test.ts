// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupScrapePopups,
  cleanScrapePreview,
} from '@/lib/scrape-popup-cleanup'

const product = `<main><h1>Native Chief Lightweight</h1>
  <p>CTS BD1N steel</p><details><summary>Technical specifications</summary>
  Blade length: 4.02 inches</details><img src="/knife.jpg"></main>`

afterEach(() => {
  const state = document as Document & {
    __bladevaultPopupCleanup?: MutationObserver
  }
  state.__bladevaultPopupCleanup?.disconnect()
  delete state.__bladevaultPopupCleanup
  document.documentElement.removeAttribute('style')
  document.body.className = ''
  document.body.removeAttribute('style')
  document.body.innerHTML = ''
})

describe('scrape popup cleanup', () => {
  it('removes stacked Spyderco-style newsletter and cookie overlays and unlocks scrolling', () => {
    document.body.className = 'template-product klaviyo-prevent-body-scrolling'
    document.body.style.cssText = 'overflow:hidden;position:fixed;top:-500px'
    document.body.innerHTML = `${product}
      <div data-kl-scroll-locking-modal="true" role="dialog">Subscribe</div>
      <section aria-label="Cookie bar"><button>Accept</button></section>`
    const originalProduct = document.querySelector('main')!.outerHTML

    expect(cleanupScrapePopups()).toBe(2)
    expect(document.querySelector('main')!.outerHTML).toBe(originalProduct)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.className).toBe('template-product')
    expect(document.body.style.overflow).toBe('auto')
    expect(document.body.style.position).toBe('')
    expect(document.body.style.top).toBe('')
  })

  it('can hide overlays in place for live screenshots', () => {
    document.body.innerHTML = `${product}
      <div data-kl-scroll-locking-modal="true" role="dialog">Subscribe</div>`

    expect(cleanupScrapePopups({ hideOnly: true })).toBe(1)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(
      (document.querySelector('[role="dialog"]') as HTMLElement).style.display,
    ).toBe('none')
    expect(document.querySelector('main')).not.toBeNull()
  })

  it('keeps sticky headers, inline subscriptions, product dialogs, and page wrappers', () => {
    document.body.innerHTML = `<div class="newsletter-modal-layout">
      <header style="position:fixed">Store navigation</header>${product}
      <form id="newsletter">Subscribe to our newsletter</form>
      <div role="dialog" aria-label="Size guide">Product dimensions</div>
      <div class="product-modal"><h2>Blade specifications</h2></div>
      </div>`
    const before = document.body.innerHTML
    expect(cleanupScrapePopups()).toBe(0)
    expect(document.body.innerHTML).toBe(before)
  })

  it('recognizes marketing dialogs without depending on a particular retailer', () => {
    document.body.innerHTML = `${product}
      <div class="modal-backdrop"></div>
      <section role="dialog"><h2>Join our mailing list</h2></section>
      <div id="newsletter-popup">Special offers</div>
      <aside class="popup">Subscribe for special offers</aside>`
    expect(cleanupScrapePopups()).toBe(3)
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    expect(document.querySelector('main')).not.toBeNull()
  })

  it('watches for late and repeated popups during lazy-load scrolling', async () => {
    document.body.innerHTML = product
    cleanupScrapePopups({ observe: true })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div data-kl-scroll-locking-modal="true">Delayed signup</div>',
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        document.querySelector('[data-kl-scroll-locking-modal]'),
      ).toBeNull()
    }
    expect(document.querySelector('main')!.outerHTML).toBe(
      new DOMParser()
        .parseFromString(product, 'text/html')
        .querySelector('main')!.outerHTML,
    )
  })

  it('clears cookie banners and later overlays inside nested open shadow roots', async () => {
    document.body.innerHTML = `${product}<csm-cookie-consent></csm-cookie-consent>`
    const shadow = document
      .querySelector('csm-cookie-consent')!
      .attachShadow({ mode: 'open' })
    shadow.innerHTML =
      '<div aria-label="Cookie bar">Cookie preferences</div><nested-widget></nested-widget>'
    const nested = shadow
      .querySelector('nested-widget')!
      .attachShadow({ mode: 'open' })
    nested.innerHTML = '<div role="dialog">Join our mailing list</div>'
    expect(cleanupScrapePopups({ observe: true })).toBe(2)
    expect(shadow.querySelector('[aria-label="Cookie bar"]')).toBeNull()
    nested.innerHTML = '<div role="dialog">Subscribe to updates</div>'
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(nested.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('main')).not.toBeNull()
  })

  it('lets manual preview cleanup remove unfamiliar modal shells without altering the original', () => {
    const original = `<html><body>${product}<div class="popup-overlay">
      <div role="dialog" aria-modal="true">An unfamiliar promotion</div>
      <div class="modal-backdrop"></div></div></body></html>`
    const result = cleanScrapePreview(original)
    expect(result.removed).toBe(1)
    expect(result.html).not.toContain('An unfamiliar promotion')
    expect(result.html).not.toContain('popup-overlay')
    expect(result.html).toContain('Technical specifications')
    expect(original).toContain('An unfamiliar promotion')
  })
})
