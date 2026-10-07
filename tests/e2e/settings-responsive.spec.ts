import { expect, test, type Page } from '@playwright/test'
import { resetVault } from './helpers'

/**
 * Settings layout across every screen size we care about.
 *
 * These guard the specific defects the redesign fixed:
 *   1. the page used to cap itself twice (max-w-7xl + mx-auto max-w-3xl), so on a
 *      large display the form used ~30% of the viewport with dead gutters;
 *   2. buttons rendered at h-7 while inputs/selects rendered at h-8, so a button
 *      sitting next to a field was visibly shorter;
 *   3. panels could overflow their container and introduce a horizontal scrollbar.
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
  'Cloud Backup',
  'Backup & Restore',
  'Appearance',
  'Custom Fields',
  'AI / MCP',
  'About',
] as const

/** Tabs that render more than one panel, and so should tile on a wide screen. */
const MULTI_PANEL_TABS = [
  'Cloud Backup',
  'Backup & Restore',
  'Appearance',
  'AI / MCP',
] as const

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

async function openTab(page: Page, tab: string) {
  // Scoped to the settings rail and matched on the label prefix: the Cloud
  // Backup tab carries a "Beta" badge, so its accessible name is
  // "Cloud Backup Beta" on some viewports and an exact match would miss it.
  const label = new RegExp(`^${tab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  await page
    .locator('[data-settings-rail]')
    .getByRole('button', { name: label })
    .click()
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
      }
    })
  })
}

test.describe('column behaviour', () => {
  test('tiles multi-panel tabs on a 4K display', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 })
    await page.goto('/settings')

    for (const tab of MULTI_PANEL_TABS) {
      await openTab(page, tab)
      expect(
        await gridColumns(page),
        `${tab} should tile at 2560`,
      ).toBeGreaterThanOrEqual(2)
    }

    // the headline case: Appearance's three panels sit side by side
    await openTab(page, 'Appearance')
    expect(await gridColumns(page)).toBe(3)
  })

  test('collapses to a single column on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/settings')

    for (const tab of TABS) {
      await openTab(page, tab)
      expect(
        await gridColumns(page),
        `${tab} should be one column at 390`,
      ).toBe(1)
    }
  })

  test('does not stretch a single-panel tab across the whole display', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 2560, height: 1440 })
    await page.goto('/settings')

    // Local storage / App lock / Custom Fields / About each render one panel.
    for (const tab of ['Local storage', 'App lock', 'Custom Fields', 'About']) {
      await openTab(page, tab)
      const { panelWidths } = await layoutMetrics(page)
      expect(panelWidths.length, `${tab} should render one panel`).toBe(1)
      // capped rather than stretched into a 2000px card with an empty right half
      expect(
        panelWidths[0],
        `${tab} panel should stay readable`,
      ).toBeLessThanOrEqual(1152)
    }
  })

  test('uses the width it is given on a large display', async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 })
    await page.goto('/settings')
    await openTab(page, 'Appearance')

    const { gridWidth } = await layoutMetrics(page)
    // the old layout capped the content column at 768px; make sure that is gone
    expect(gridWidth).toBeGreaterThan(1200)
  })
})
