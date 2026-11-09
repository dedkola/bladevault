'use client'

import { useEffect } from 'react'

/** Segmented controls that get a sliding highlight in the Forge-language themes. */
export const SEGMENTED_SELECTOR = [
  '[data-modern-collection-scopes]',
  '[data-modern-collection-tools] > [data-collection-view-toggle]',
  "[data-slot='tabs-list']",
  "[data-studio] [class*='segmented']",
  "[data-logs-filter-row] [aria-label='Filter log event type']",
  "[data-modern-insights] [class*='range']",
].join(', ')

const ACTIVE_SELECTOR =
  ":scope > :is(button[aria-pressed='true'], button[aria-selected='true'], [data-slot='tabs-trigger'][data-active], [data-slot='tabs-trigger'][aria-selected='true'])"

/**
 * Positions one shared highlight under the selected option of each
 * segmented control, so selection slides instead of jumping. It only writes
 * CSS variables and a data attribute; the look lives in the theme CSS.
 * Runs only while Forge, Titanium or Field is active.
 */
export function SegmentedHighlight() {
  useEffect(() => {
    const root = document.documentElement
    let frame = 0
    const tracked = new Set<HTMLElement>()
    const resizeObserver = new ResizeObserver(() => schedule())

    const clear = (group: HTMLElement) => {
      group.style.removeProperty('--seg-x')
      group.style.removeProperty('--seg-w')
      delete group.dataset.segHighlight
    }

    const update = () => {
      frame = 0
      const enabled = Boolean(root.dataset.themeVariant)
      const groups = enabled
        ? Array.from(document.querySelectorAll<HTMLElement>(SEGMENTED_SELECTOR))
        : []

      for (const group of tracked) {
        if (!groups.includes(group)) {
          clear(group)
          resizeObserver.unobserve(group)
          tracked.delete(group)
        }
      }

      for (const group of groups) {
        if (!tracked.has(group)) {
          tracked.add(group)
          resizeObserver.observe(group)
        }
        const active = group.querySelector<HTMLElement>(ACTIVE_SELECTOR)
        if (!active || active.offsetWidth === 0) {
          group.dataset.segHighlight = 'none'
          continue
        }
        group.style.setProperty('--seg-x', `${active.offsetLeft}px`)
        group.style.setProperty('--seg-w', `${active.offsetWidth}px`)
        // First placement happens without a slide; later moves animate.
        if (
          !group.dataset.segHighlight ||
          group.dataset.segHighlight === 'none'
        ) {
          group.dataset.segHighlight = 'placed'
          window.setTimeout(() => {
            if (group.dataset.segHighlight === 'placed')
              group.dataset.segHighlight = 'ready'
          }, 50)
        }
      }
    }

    // Animation frames pause in hidden windows; fall back to a timer there.
    const schedule = () => {
      if (frame) return
      frame = document.hidden
        ? window.setTimeout(update, 50)
        : requestAnimationFrame(update)
    }

    const mutationObserver = new MutationObserver(schedule)
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-pressed', 'aria-selected', 'data-active'],
    })
    const themeObserver = new MutationObserver(schedule)
    themeObserver.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme-variant', 'class'],
    })
    window.addEventListener('resize', schedule)
    void document.fonts?.ready.then(schedule)
    schedule()

    return () => {
      if (frame) {
        cancelAnimationFrame(frame)
        window.clearTimeout(frame)
      }
      mutationObserver.disconnect()
      themeObserver.disconnect()
      resizeObserver.disconnect()
      window.removeEventListener('resize', schedule)
      tracked.forEach(clear)
      tracked.clear()
    }
  }, [])

  return null
}
