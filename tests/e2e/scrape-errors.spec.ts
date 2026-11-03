import { expect, test, type Page } from '@playwright/test'
import { resetVault } from './helpers'

const productUrl = 'https://shop.example.com/test-knife'
const product = {
  name: 'Imported Knife',
  brand: 'Test Maker',
  description: 'Imported product details',
  bladeStyle: 'Drop Point',
  handleMaterial: 'Titanium',
  images: [],
  specs: { bladeMaterial: 'M390' },
  sourceUrl: productUrl,
}
const importedPage = {
  product,
  finalUrl: productUrl,
  html: '<html><body><h1>Imported Knife</h1></body></html>',
}

async function openAddPage(page: Page, themeStyle = 'classic') {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/knives' &&
        response.request().method() === 'GET' &&
        response.ok(),
    ),
    page.goto('/add'),
  ])
  if (themeStyle !== 'alloy') {
    await expect(page.locator('[data-sidebar]')).toBeAttached()
  }
  await expect(
    page.getByText('Loading collection…', { exact: true }),
  ).toHaveCount(0)
}

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

for (const themeStyle of ['classic', 'modern', 'alloy'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 1000 },
      { name: 'narrow', width: 390, height: 844 },
    ]) {
      test(`${themeStyle} ${theme} ${viewport.name} shows scrape errors and allows retry`, async ({
        page,
        request,
      }, testInfo) => {
        await page.setViewportSize(viewport)
        const settings = await request.post('/api/settings', {
          data: { themeStyle, theme },
        })
        expect(settings.ok()).toBe(true)
        let attempts = 0
        await page.route('**/api/scrape', (route) => {
          attempts += 1
          return route.fulfill(
            attempts === 1
              ? {
                  status: 502,
                  json: {
                    code: 'network',
                    error:
                      'Could not connect to the website. Check the URL and your connection, then try again.',
                  },
                }
              : { json: importedPage },
          )
        })
        await openAddPage(page, themeStyle)
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme-style',
          themeStyle,
        )
        if (theme === 'dark') {
          await expect(page.locator('html')).toHaveClass(/\bdark\b/)
        } else {
          await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
        }
        const url = page.getByRole('textbox', { name: 'Product URL' })
        await url.fill(productUrl)
        const scrape = page.getByRole('button', { name: 'Scrape', exact: true })
        await scrape.focus()
        await scrape.press('Enter')

        const error = page
          .getByRole('alert')
          .filter({ hasText: 'Could not connect to the website' })
        await expect(error).toContainText('Could not connect to the website')
        await expect(error).toContainText('try again')
        await expect(error).toBeInViewport()
        await expect(url).toBeEnabled()
        await expect(scrape).toBeEnabled()
        await expect(scrape.locator('.animate-spin')).toHaveCount(0)
        await expect(
          page.getByRole('button', { name: 'Interact with page' }),
        ).toBeEnabled()
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(viewport.width)

        if (
          (theme === 'light' && viewport.name === 'desktop') ||
          (theme === 'dark' && viewport.name === 'narrow')
        ) {
          const screenshot = testInfo.outputPath('scrape-error.png')
          await page.screenshot({ path: screenshot })
          await testInfo.attach('Scrape error and available controls', {
            path: screenshot,
            contentType: 'image/png',
          })
        }

        await scrape.focus()
        await scrape.press('Enter')
        await expect(
          page.getByRole('textbox', { name: 'Model Name' }),
        ).toHaveValue(product.name)
        await expect(error).toHaveCount(0)
        await expect(scrape).toBeEnabled()
        expect(attempts).toBe(2)
      })
    }
  }
}

test('keeps the manual CAPTCHA session available until Continue succeeds', async ({
  page,
}) => {
  await page.route('**/api/scrape', (route) =>
    route.fulfill({ json: importedPage }),
  )
  await page.route('**/api/scrape/interactive/start', (route) =>
    route.fulfill({ json: { sessionId: 'verification-session' } }),
  )
  let captures = 0
  await page.route(
    '**/api/scrape/interactive/verification-session/status',
    (route) =>
      route.fulfill({
        json: { status: 'waiting', isSecurityChallenge: captures < 2 },
      }),
  )
  await page.route(
    '**/api/scrape/interactive/verification-session/scrape',
    (route) => {
      captures += 1
      return route.fulfill(
        captures === 1
          ? {
              status: 403,
              json: {
                code: 'challenge',
                error:
                  'Complete CAPTCHA verification in the browser, then click Continue.',
              },
            }
          : { json: importedPage },
      )
    },
  )
  await page.route(
    '**/api/scrape/interactive/verification-session/cancel',
    (route) => route.fulfill({ json: { ok: true } }),
  )
  await openAddPage(page)
  const url = page.getByRole('textbox', { name: 'Product URL' })
  await url.fill(productUrl)
  await page.getByRole('button', { name: 'Scrape', exact: true }).click()
  const name = page.getByRole('textbox', { name: 'Model Name' })
  await expect(name).toHaveValue(product.name)
  await name.fill('My manually edited knife')
  await page.getByRole('button', { name: 'Interact with page' }).click()
  const next = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(next).toBeEnabled()
  await next.click()
  const error = page
    .getByRole('alert')
    .filter({ hasText: 'Complete CAPTCHA verification' })
  await expect(error).toBeVisible()
  await expect(next).toBeEnabled()
  await expect(url).toBeDisabled()
  await expect(name).toHaveValue('My manually edited knife')
  await next.click()
  await expect(next).toHaveCount(0)
  await expect(error).toHaveCount(0)
  await expect(url).toBeEnabled()
  await expect(name).toHaveValue('My manually edited knife')
  await expect(
    page.getByRole('button', { name: 'Interact with page' }),
  ).toBeEnabled()
  expect(captures).toBe(2)
})

test('stops a stalled scrape after 60 seconds and allows retry', async ({
  page,
}) => {
  await page.clock.install()
  let attempts = 0
  let releaseRequest: (() => void) | undefined
  await page.route('**/api/scrape', async (route) => {
    attempts += 1
    if (attempts === 1) {
      await new Promise<void>((resolve) => {
        releaseRequest = resolve
      })
      await route.abort().catch(() => {})
      return
    }
    await route.fulfill({ json: importedPage })
  })
  try {
    await openAddPage(page)
    const url = page.getByRole('textbox', { name: 'Product URL' })
    await url.fill(productUrl)
    await page.getByRole('button', { name: 'Scrape', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Scraping', exact: true }),
    ).toBeDisabled()
    await expect.poll(() => attempts).toBe(1)
    await page.clock.fastForward(60_001)
    const error = page
      .getByRole('alert')
      .filter({ hasText: 'longer than 60 seconds' })
    await expect(error).toBeVisible()
    await expect(url).toBeEnabled()
    const scrape = page.getByRole('button', { name: 'Scrape', exact: true })
    await expect(scrape).toBeEnabled()
    await expect(scrape.locator('.animate-spin')).toHaveCount(0)
    releaseRequest?.()
    await scrape.click()
    await expect(page.getByRole('textbox', { name: 'Model Name' })).toHaveValue(
      product.name,
    )
    await expect(error).toHaveCount(0)
    expect(attempts).toBe(2)
  } finally {
    releaseRequest?.()
  }
})
