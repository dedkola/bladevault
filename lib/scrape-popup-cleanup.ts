export type PopupCleanupOptions = {
  root?: Document
  manual?: boolean
  observe?: boolean
  hideOnly?: boolean
}

/** Self-contained so Playwright can run this function in the retailer page. */
export function cleanupScrapePopups({
  root = document,
  manual = false,
  observe = false,
  hideOnly = false,
}: PopupCleanupOptions = {}): number {
  const knownOverlays = [
    '[data-kl-scroll-locking-modal="true"]',
    '.privy-popup-container',
    '.privy-popup-overlay',
    '#onetrust-consent-sdk',
    '#CybotCookiebotDialog',
    '#CybotCookiebotDialogBodyUnderlay',
    '#cookie-law-info-bar',
    '.shopify-pc__banner',
    '.cc-window',
    '.isense-cc-window',
    '[aria-label="Cookie bar" i]',
  ].join(',')
  const candidates = [
    knownOverlays,
    'dialog',
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[class*="popup" i]',
    '[id*="popup" i]',
    '[class*="modal" i]',
    '[id*="modal" i]',
  ].join(',')

  let observer: MutationObserver | undefined
  const clean = () => {
    let removed = 0
    const scopes: Array<Document | ShadowRoot> = [root]
    for (const scope of scopes) {
      // Cookie managers increasingly render inside an open shadow root.
      for (const host of scope.querySelectorAll('*')) {
        if (host.shadowRoot) scopes.push(host.shadowRoot)
      }
      observer?.observe(scope, { childList: true, subtree: true })
    }
    const overlays = scopes.flatMap((scope) =>
      Array.from(scope.querySelectorAll<HTMLElement>(candidates)),
    )
    for (const element of overlays) {
      // Never remove a page wrapper or the product's main content.
      if (
        !element.isConnected ||
        element.matches('html, body, main, [role="main"]') ||
        element.querySelector('main, [role="main"], [itemtype$="/Product"]')
      )
        continue

      const identity = `${element.id} ${element.className} ${element.getAttribute('aria-label') ?? ''}`
      const isDialog = element.matches(
        'dialog, [role="dialog"], [aria-modal="true"]',
      )
      const isMarketing =
        /\b(newsletter|subscribe|subscription|mailing list|sign[\s-]?up|cookies?|consent)\b/i.test(
          `${identity.replace(/[_-]/g, ' ')} ${element.textContent ?? ''}`,
        )
      if (
        !element.matches(knownOverlays) &&
        !isMarketing &&
        !(manual && isDialog)
      )
        continue

      if (hideOnly) {
        ;(element as HTMLElement).style.setProperty(
          'display',
          'none',
          'important',
        )
        for (const sibling of [
          element.previousElementSibling,
          element.nextElementSibling,
        ]) {
          if (
            sibling?.matches(
              '.modal-backdrop, .popup-overlay, [data-modal-backdrop]',
            ) &&
            !sibling.querySelector('main, [role="main"], h1, form')
          ) {
            ;(sibling as HTMLElement).style.setProperty(
              'display',
              'none',
              'important',
            )
          }
        }
        removed += 1
        continue
      }

      let target = element
      // A modal can sit inside a separate fullscreen overlay. Remove that shell
      // only when its other children are backdrops, not other page content.
      while (
        target.parentElement &&
        target.parentElement !== root.body &&
        target.parentElement.matches(
          '.modal, .modal-overlay, .popup-overlay, [data-modal-overlay]',
        ) &&
        Array.from(target.parentElement.children).every(
          (child) =>
            child === target ||
            child.matches('.modal-backdrop, [data-modal-backdrop]'),
        )
      )
        target = target.parentElement

      // Backdrops are often siblings of the dialog rather than its children.
      for (const sibling of [
        target.previousElementSibling,
        target.nextElementSibling,
      ]) {
        if (
          sibling?.matches(
            '.modal-backdrop, .popup-overlay, [data-modal-backdrop]',
          ) &&
          !sibling.querySelector('main, [role="main"], h1, form')
        )
          sibling.remove()
      }
      target.remove()
      removed += 1
    }

    if (removed > 0 && !hideOnly) {
      for (const element of [root.documentElement, root.body]) {
        if (!element) continue
        element.classList.remove(
          'klaviyo-prevent-body-scrolling',
          'modal-open',
          'overflow-hidden',
          'no-scroll',
          'noscroll',
          'scroll-locked',
        )
        element.style.setProperty('overflow', 'auto', 'important')
        if (element.style.position === 'fixed') {
          for (const property of ['position', 'top', 'left', 'right', 'width'])
            element.style.removeProperty(property)
        }
      }
    }
    return removed
  }

  if (observe && root.body) {
    const state = root as Document & {
      __bladevaultPopupCleanup?: MutationObserver
    }
    if (!state.__bladevaultPopupCleanup) {
      // Catch overlays inserted while lazy images load or capture scrolls.
      state.__bladevaultPopupCleanup = new MutationObserver(() => clean())
    }
    observer = state.__bladevaultPopupCleanup
  }
  return clean()
}

/** Changes only the preview copy; the iframe continues to block scripts. */
export function cleanScrapePreview(html: string): {
  html: string
  removed: number
} {
  const root = new DOMParser().parseFromString(html, 'text/html')
  const removed = cleanupScrapePopups({ root, manual: true })
  return {
    html: `<!DOCTYPE html>\n${root.documentElement.outerHTML}`,
    removed,
  }
}
