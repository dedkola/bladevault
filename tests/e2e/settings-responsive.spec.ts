import { expect, test, type Page } from '@playwright/test'
import { resetVault } from './helpers'

/**
 * Settings layout across every screen size we care about.
 *
 * Each tab is one reading column of flat sections. These guard that:
 *   1. nothing overflows the viewport or its section at any width;
 *   2. buttons, inputs and selects share one height;
 *   3. the column stays capped on large displays, so a control sits close to
 *      the setting it changes;
 *   4. the card-field preview sits beside its options only when the column is
 *      wide enough.
 */

const VIEWPORTS = [
  { name: '4k', width: 2560, height: 1440 },
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'laptop', width: 1600, height: 900 },
  { name: 'small-laptop', width: 1280, height: 800 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'tablet-portrait', width: 820, height: 1180 },
  { name: 'small', width: 640, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

const TABS = [
  'Local storage',
  'App lock',
  'Backup & Restore',
  'Appearance',
  'Custom fields',
  'AI / MCP',
  'About',
] as const

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

async function openTab(page: Page, tab: string) {
  // Scoped to the settings rail and matched on the label prefix.
  const label = new RegExp(`^${tab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  await page
    .locator('[data-settings-rail]')
    .getByRole('button', { name: label })
    .click()
  // Tab selection navigates asynchronously; the previous grid stays visible
  // until the requested panel commits. Measure only the selected tab.
  await expect(page.locator('.settings-head h2')).toHaveText(tab)
  await expect(page.locator('.settings-grid')).toBeVisible()
}

/** Grid column count, read off the computed track list (0px tracks are collapsed). */
async function gridColumns(page: Page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.settings-grid')
    if (!grid) return 0
    return getComputedStyle(grid)
      .gridTemplateColumns.split(' ')
      .filter((track) => track !== '0px').length
  })
}

async function layoutMetrics(page: Page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.settings-grid') as HTMLElement
    const surface = document.querySelector('.settings-surface') as HTMLElement
    const controls = [
      ...grid.querySelectorAll(
        '[data-slot="button"], [data-slot="input"], [data-slot="select-trigger"]',
      ),
    ]
    const gridWidth = grid.getBoundingClientRect().width
    const controlBounds = [
      ...grid.querySelectorAll(
        'button, input, [role="combobox"], [role="checkbox"]',
      ),
    ].flatMap((control) => {
      // Base UI renders a clipped, aria-hidden native input beside the visible
      // checkbox. Only the rendered control belongs to the panel layout.
      if (
        control.matches('input[type="hidden"], input[aria-hidden="true"]') ||
        !control.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      ) {
        return []
      }

      const panel = control.closest('.settings-section')
      const rect = control.getBoundingClientRect()
      if (!panel || !rect.width || !rect.height) return []

      const panelRect = panel.getBoundingClientRect()
      let scrollsVertically = false
      for (
        let ancestor = control.parentElement;
        ancestor && ancestor !== panel;
        ancestor = ancestor.parentElement
      ) {
        if (
          /auto|scroll/.test(getComputedStyle(ancestor).overflowY) &&
          ancestor.scrollHeight > ancestor.clientHeight
        ) {
          scrollsVertically = true
          break
        }
      }

      return [
        {
          name:
            control.getAttribute('aria-label') ||
            control.textContent?.trim() ||
            control.getAttribute('data-slot'),
          left: rect.left - panelRect.left,
          right: panelRect.right - rect.right,
          top: rect.top - panelRect.top,
          bottom: panelRect.bottom - rect.bottom,
          scrollsVertically,
        },
      ]
    })
    return {
      docOverflowX:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      surfaceRight: surface.getBoundingClientRect().right,
      surfaceLeft: surface.getBoundingClientRect().left,
      viewportWidth: window.innerWidth,
      gridWidth,
      panelWidths: [...grid.children].map(
        (child) => (child as HTMLElement).getBoundingClientRect().width,
      ),
      controlBounds,
      controlHeights: [
        ...new Set(
          controls.map((control) =>
            Math.round(control.getBoundingClientRect().height),
          ),
        ),
      ],
    }
  })
}

async function cardFieldsLayout(
  page: Page,
  selector = '.settings-card-fields',
) {
  return page.locator(selector).evaluate((panel) => {
    const layout = panel.querySelector(
      '.settings-card-fields-layout',
    ) as HTMLElement
    const preview = layout.firstElementChild as HTMLElement
    const options = panel.querySelector(
      '.settings-card-fields-options',
    ) as HTMLElement
    const previewRect = preview.getBoundingClientRect()
    const optionsRect = options.getBoundingClientRect()
    return {
      sideBySide:
        panel.clientWidth >=
        36 * parseFloat(getComputedStyle(document.documentElement).fontSize),
      previewRight: previewRect.right,
      previewTop: previewRect.top,
      previewBottom: previewRect.bottom,
      optionsLeft: optionsRect.left,
      optionsTop: optionsRect.top,
      optionsWidth: optionsRect.width,
      layoutWidth: layout.getBoundingClientRect().width,
    }
  })
}

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.name} (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('renders every settings tab without horizontal overflow', async ({
      page,
    }) => {
      await page.goto('/settings')

      for (const tab of TABS) {
        await openTab(page, tab)
        const metrics = await layoutMetrics(page)

        // nothing may push the document sideways at any size
        expect(
          metrics.docOverflowX,
          `${tab} must not overflow horizontally`,
        ).toBeLessThanOrEqual(1)

        // the surface stays inside the viewport, anchored to the content edge
        expect(metrics.surfaceLeft).toBeGreaterThanOrEqual(0)
        expect(metrics.surfaceRight).toBeLessThanOrEqual(
          metrics.viewportWidth + 1,
        )

        for (const bounds of metrics.controlBounds) {
          const label = `${tab}: ${bounds.name} must fit inside its panel`
          expect(bounds.left, label).toBeGreaterThanOrEqual(-1)
          expect(bounds.right, label).toBeGreaterThanOrEqual(-1)
          // The card-field list deliberately scrolls; its off-screen options
          // still need to fit horizontally, while other controls fit in full.
          if (!bounds.scrollsVertically) {
            expect(bounds.top, label).toBeGreaterThanOrEqual(-1)
            expect(bounds.bottom, label).toBeGreaterThanOrEqual(-1)
          }
        }

        // the section heading is present so the tab has a stated purpose
        await expect(page.locator('.settings-head')).toBeVisible()
      }
    })

    test('gives every control one consistent height', async ({ page }) => {
      await page.goto('/settings')

      for (const tab of TABS) {
        await openTab(page, tab)
        const { controlHeights } = await layoutMetrics(page)

        // buttons, inputs and select triggers all resolve to a single height —
        // this is what stops a button sitting next to a field from being shorter
        expect(
          controlHeights.length,
          `${tab}: expected one control height, got ${JSON.stringify(controlHeights)}`,
        ).toBeLessThanOrEqual(1)
      }
    })

    test('keeps panels inside their grid track', async ({ page }) => {
      await page.goto('/settings')

      for (const tab of TABS) {
        await openTab(page, tab)
        const { gridWidth, panelWidths } = await layoutMetrics(page)

        expect(panelWidths.length).toBeGreaterThan(0)
        for (const panelWidth of panelWidths) {
          expect(
            panelWidth,
            `${tab}: a panel is wider than the grid`,
          ).toBeLessThanOrEqual(gridWidth + 1)
        }

        if (tab === 'Appearance') {
          for (const selector of [
            '.settings-card-fields',
            '.settings-pinned-card-fields',
          ]) {
            const fields = await cardFieldsLayout(page, selector)
            if (fields.sideBySide) {
              expect(
                fields.previewRight,
                `${selector} preview sits beside the options`,
              ).toBeLessThanOrEqual(fields.optionsLeft + 1)
              expect(
                Math.abs(fields.previewTop - fields.optionsTop),
                `${selector} preview aligns with the options`,
              ).toBeLessThanOrEqual(1)
            } else {
              expect(
                fields.optionsTop,
                `${selector} options stack under the preview`,
              ).toBeGreaterThanOrEqual(fields.previewBottom - 1)
              expect(
                Math.abs(fields.optionsWidth - fields.layoutWidth),
                `${selector} options fill the card`,
              ).toBeLessThanOrEqual(1)
            }
          }
        }
      }
    })
  })
}

test.describe('reading column', () => {
  test('keeps every tab in one column at every width', async ({ page }) => {
    for (const width of [390, 1440, 2560]) {
      await page.setViewportSize({ width, height: 1080 })
      await page.goto('/settings')

      for (const tab of TABS) {
        await openTab(page, tab)
        expect(
          await gridColumns(page),
          `${tab} should be one column at ${width}`,
        ).toBe(1)
      }
    }
  })

  test('caps the column on a large display', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 })
    await page.goto('/settings')

    for (const tab of TABS) {
      await openTab(page, tab)
      const { gridWidth, panelWidths } = await layoutMetrics(page)
      expect(gridWidth, `${tab} column should stay readable`).toBe(720)
      for (const panelWidth of panelWidths) {
        expect(
          Math.abs(panelWidth - gridWidth),
          `${tab}: sections fill the column`,
        ).toBeLessThanOrEqual(1)
      }
    }
  })

  test('shows the Google Drive section without empty feedback', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto('/settings')
    await openTab(page, 'Backup & Restore')

    const sections = page.locator('.settings-grid .settings-section')
    // Google Drive comes first, then local ZIP backup; this test vault is not
    // connected to Drive.
    await expect(sections).toHaveCount(2)
    await expect(
      sections.first().getByRole('heading', { name: 'Google Drive' }),
    ).toBeVisible()
    await expect(
      sections.nth(1).getByRole('heading', { name: 'Local backup' }),
    ).toBeVisible()
    await expect(
      sections.getByRole('button', { name: 'Connect Google Drive' }),
    ).toBeVisible()

    const idleDrive = await sections.first().evaluate((panel) => {
      const body = panel.lastElementChild as HTMLElement
      const row = body.querySelector('.settings-row') as HTMLElement
      return {
        rowIsLast: body.lastElementChild === row,
        spaceAfterRow:
          body.getBoundingClientRect().bottom -
          row.getBoundingClientRect().bottom,
      }
    })
    expect(idleDrive.rowIsLast).toBe(true)
    expect(Math.abs(idleDrive.spaceAfterRow)).toBeLessThanOrEqual(1)
  })
})
