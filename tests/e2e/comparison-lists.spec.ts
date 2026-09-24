import { expect, test } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('creates, selects destinations, scopes removal, persists and restores a deleted comparison', async ({
  page,
  request,
}) => {
  const first = await seedKnife(request, {
    name: 'First',
    brand: 'Alpha',
    pinned: true,
  })
  await seedKnife(request, { name: 'Second', brand: 'Beta' })
  await page.goto('/collection')
  await page
    .getByRole('button', { name: 'Add Alpha First to compare', exact: true })
    .click()
  await page
    .getByLabel('Comparison name', { exact: true })
    .fill('Everyday carry')
  await page.getByRole('button', { name: 'Create & add', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page
    .getByRole('button', { name: 'New comparison', exact: true })
    .first()
    .click()
  await page
    .getByLabel('Comparison name', { exact: true })
    .fill('Travel shortlist')
  await page
    .getByRole('button', { name: 'Create comparison', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Travel shortlist', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Add knives', exact: true }).click()
  await page
    .getByRole('button', { name: /Add Beta Second.*to this comparison/ })
    .click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.goto('/collection')
  await page
    .getByRole('button', {
      name: 'Choose comparisons for Alpha First',
      exact: true,
    })
    .click()
  await expect(
    page.getByRole('checkbox', { name: /Everyday carry/ }),
  ).toBeChecked()
  await page.getByRole('checkbox', { name: /Travel shortlist/ }).check()
  await page
    .getByRole('button', { name: 'Save selection', exact: true })
    .click()
  await page
    .getByRole('link', { name: 'Travel shortlist 2', exact: true })
    .click()
  await expect(page.getByRole('columnheader').nth(1)).toContainText('First')
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Travel shortlist', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('button', {
      name: 'Remove Alpha First from compare',
      exact: true,
    })
    .first()
    .click()
  await expect(page.getByRole('columnheader')).toHaveCount(2)
  const data = await (await request.get('/api/comparisons')).json()
  expect(
    data.lists.find((list: { name: string }) => list.name === 'Everyday carry')
      .ids,
  ).toEqual([first.knife.id])
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('columnheader')).toHaveCount(3)
  await page
    .getByRole('button', { name: 'Comparison options', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Delete comparison', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Delete comparison', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Everyday carry', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Travel shortlist', exact: true }),
  ).toBeVisible()
})

test('preserves chooser drafts through creation, cancels safely and supports bulk addition', async ({
  page,
  request,
}) => {
  await seedKnife(request, { name: 'First', brand: 'Alpha' })
  await seedKnife(request, { name: 'Second', brand: 'Beta' })
  for (const name of ['Carry', 'Travel'])
    await request.post('/api/comparisons', { data: { action: 'create', name } })
  await page.goto('/collection')
  const trigger = page.getByRole('button', {
    name: 'Choose comparisons for Alpha First',
    exact: true,
  })
  await trigger.click()
  await page.getByRole('checkbox', { name: /Carry/ }).check()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'New comparison', exact: true })
    .click()
  await page.getByLabel('Comparison name', { exact: true }).fill('Weekend')
  await page.getByRole('button', { name: 'Create & add', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: /Carry/ })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: /Weekend/ })).toBeChecked()
  await page
    .getByRole('button', { name: 'Save selection', exact: true })
    .click()
  await trigger.click()
  await page.getByRole('checkbox', { name: /Carry/ }).uncheck()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(page.getByRole('checkbox', { name: /Carry/ })).toBeChecked()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.getByRole('button', { name: 'Select all 2', exact: true }).click()
  await page
    .getByRole('button', { name: 'Compare selected', exact: true })
    .click()
  await page.getByRole('checkbox', { name: /Travel/ }).check()
  await page
    .getByRole('button', { name: 'Add to selected lists', exact: true })
    .click()
  const { lists } = await (await request.get('/api/comparisons')).json()
  expect(
    lists.find((l: { name: string }) => l.name === 'Travel').ids,
  ).toHaveLength(2)
  expect(
    lists.find((l: { name: string }) => l.name === 'Carry').ids,
  ).toHaveLength(1)
})

test('handles many lists, long names, mobile navigation and empty final state', async ({
  page,
  request,
}) => {
  const longName = 'A'.repeat(60)
  for (const name of [
    longName,
    ...Array.from({ length: 7 }, (_, i) => `Shortlist ${i + 1}`),
  ])
    await request.post('/api/comparisons', { data: { action: 'create', name } })
  await page.goto('/compare?list=deleted')
  await expect(page.getByText(/This comparison no longer exists/)).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Find comparison', exact: true })
    .fill('Shortlist 7')
  await page.getByRole('link', { name: 'Shortlist 7 0', exact: true }).click()
  await page.setViewportSize({ width: 320, height: 740 })
  await page
    .getByRole('combobox', { name: 'Switch comparison' })
    .selectOption({ label: `${longName} (0)` })
  await expect(
    page.getByRole('heading', { name: longName, exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page
    .getByRole('button', { name: 'New comparison', exact: true })
    .first()
    .click()
  await page
    .getByLabel('Comparison name', { exact: true })
    .fill('Mobile comparison')
  await page
    .getByRole('button', { name: 'Create comparison', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Mobile comparison', exact: true }),
  ).toBeVisible()
  const { lists } = await (await request.get('/api/comparisons')).json()
  for (const list of lists)
    await request.post('/api/comparisons', {
      data: { action: 'delete', id: list.id },
    })
  await page.reload()
  await expect(
    page.getByText('A place for every shortlist', { exact: true }),
  ).toBeVisible()
})
