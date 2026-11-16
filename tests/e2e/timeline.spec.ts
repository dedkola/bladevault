import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('tells the collection story and recaps a single year', async ({
  page,
  request,
}) => {
  const { knife: bugout } = await seedKnife(request)
  const { knife: pm2 } = await seedKnife(request, {
    name: 'Paramilitary 2',
    brand: 'Spyderco',
  })
  await request.post(`/api/knives/${bugout.id}/maintenance`, {
    data: {
      type: 'sharpening',
      occurredAt: '2019-06-15T12:00:00.000Z',
      notes: 'Sharpmaker at 40°',
    },
  })
  await request.post(`/api/knives/${pm2.id}/notes`, {
    data: { body: 'First **week** of carry' },
  })

  await page.goto('/timeline')
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()
  const nav = page.getByRole('link', { name: 'Timeline', exact: true })
  await expect(nav.first()).toBeVisible()

  const story = page.locator('[data-timeline]')
  await expect(story.getByText('The collection begins')).toBeVisible()
  await expect(story.getByText('New brand')).toBeVisible()
  await expect(story.getByText('First maintenance logged')).toBeVisible()
  await expect(story.getByText('Sharpmaker at 40°')).toBeVisible()
  await expect(story.getByText('First week of carry')).toBeVisible()

  await story.getByRole('button', { name: '2019' }).click()
  await expect(story.getByRole('button', { name: '2019' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(story.getByRole('heading', { name: 'Your 2019' })).toBeVisible()
  await expect(story.getByText('Most-maintained blade')).toBeVisible()
  await expect(story.getByText('The collection begins')).toHaveCount(0)

  await story.getByRole('link', { name: 'Benchmade Bugout' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/collection/${bugout.id}$`))
})

test('is reachable from the navigation in other layouts', async ({
  page,
  request,
}) => {
  await seedKnife(request)
  for (const themeStyle of ['forge', 'alloy', 'ledger']) {
    await request.post('/api/settings', { data: { themeStyle } })
    await page.goto('/insights')
    await page.getByRole('link', { name: 'Timeline', exact: true }).click()
    await expect(page).toHaveURL(/\/timeline$/)
    await expect(
      page.locator('[data-timeline]').getByText('The collection begins'),
    ).toBeVisible()
  }
})
