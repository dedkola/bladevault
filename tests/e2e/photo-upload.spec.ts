import { crc32 } from 'node:zlib'
import sharp from 'sharp'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { resetVault, seedKnife } from './helpers'

const MIB = 1024 * 1024

async function photoWithMetadata(bytes: number, width = 1, color = 'red') {
  const png = await sharp({
    create: { width, height: 1, channels: 3, background: color },
  })
    .png()
    .toBuffer()

  // A valid ancillary PNG chunk makes the actual upload large without needing
  // a huge decoded bitmap. The original metadata must survive saving too.
  const metadata = Buffer.alloc(bytes + 12, 'A')
  metadata.writeUInt32BE(bytes, 0)
  metadata.write('tEXt', 4)
  metadata.write('Comment\0', 8)
  metadata.writeUInt32BE(crc32(metadata.subarray(4, -4)), metadata.length - 4)
  return Buffer.concat([png.subarray(0, -12), metadata, png.subarray(-12)])
}

async function expectOriginalPhotos(
  request: APIRequestContext,
  id: string,
  originals: Buffer[],
) {
  const detail = await request.get(`/api/knives/${id}`)
  expect(detail.ok()).toBeTruthy()
  const { knife } = await detail.json()
  expect(knife.images).toHaveLength(originals.length)
  for (const [index, original] of originals.entries()) {
    const image = await request.get(`/api/images/${knife.images[index]}`)
    expect(image.ok()).toBeTruthy()
    // Avoid dumping megabytes of image data into a failure report.
    expect((await image.body()).equals(original)).toBe(true)
  }
  return knife.images as string[]
}

test.beforeEach(async ({ request }) => {
  await resetVault(request)
})

test('adds a manual photo whose base64 save request exceeds 10 MiB', async ({
  page,
  request,
}) => {
  const photo = await photoWithMetadata(8 * MIB)
  await page.goto('/add')
  await page.getByRole('tab', { name: 'Manual' }).click()
  await page.getByPlaceholder('e.g. Sebenza 31').fill('Large Upload')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'large-original.png',
    mimeType: 'image/png',
    buffer: photo,
  })
  await expect(
    page.getByRole('checkbox', { name: 'Include image 1' }),
  ).toBeChecked()

  const saving = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/knives' &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Save Item', exact: true }).click()
  const saved = await saving
  expect(saved.ok(), await saved.text()).toBeTruthy()
  const { knife } = await saved.json()
  await expect(page).toHaveURL(/\/collection$/)

  await page.reload()
  await expect(page.getByText('Large Upload', { exact: true })).toBeVisible()
  await expectOriginalPhotos(request, knife.id, [photo])
})

test('edits with multiple manual photos above the combined limit and preserves the existing photo', async ({
  page,
  request,
}) => {
  const original = await photoWithMetadata(32)
  const photos = [
    await photoWithMetadata(4 * MIB, 20_000),
    await photoWithMetadata(4 * MIB, 1, 'blue'),
  ]
  const { knife } = await seedKnife(request, {
    name: 'Photo Edit',
    imageUrls: [`data:image/png;base64,${original.toString('base64')}`],
  })
  const [originalPath] = await expectOriginalPhotos(request, knife.id, [
    original,
  ])
  await page.goto(`/collection/${knife.id}`)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('input[type="file"]').setInputFiles(
    photos.map((buffer, index) => ({
      name: `manual-${index}.png`,
      mimeType: 'image/png',
      buffer,
    })),
  )
  await expect(
    page.getByRole('checkbox', { name: 'Include image 3' }),
  ).toBeChecked()
  await expect(
    page.getByRole('img', { name: 'Scraped image 2', exact: true }),
  ).toHaveJSProperty('naturalWidth', 20_000)

  const saving = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/knives/${knife.id}` &&
      response.request().method() === 'PATCH',
  )
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click()
  const saved = await saving
  expect(saved.ok(), await saved.text()).toBeTruthy()
  await expect(
    page.getByRole('button', { name: 'Edit', exact: true }),
  ).toBeVisible()

  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Edit', exact: true }),
  ).toBeVisible()
  const paths = await expectOriginalPhotos(request, knife.id, [
    original,
    ...photos,
  ])
  expect(paths[0]).toBe(originalPath)

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: /^Include image / }),
  ).toHaveCount(3)
})

test('displays a saved original larger than the image optimizer source limit', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  // Keep this a decodable source larger than the optimizer's 50 MB limit;
  // browsers may reject a PNG with a single metadata chunk that large.
  const photo = await sharp({
    create: { width: 4096, height: 4096, channels: 3, background: 'red' },
  })
    .png({ compressionLevel: 0, adaptiveFiltering: false })
    .toBuffer()
  expect(photo.length).toBeGreaterThan(50_000_000)
  const { knife } = await seedKnife(request, {
    name: 'Oversized Original',
    imageUrls: [`data:image/png;base64,${photo.toString('base64')}`],
  })
  const [imagePath] = await expectOriginalPhotos(request, knife.id, [photo])
  const rejectedOptimization = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/_next/image' &&
      response.status() === 413,
  )
  await page.goto(`/collection/${knife.id}`)
  await rejectedOptimization

  const displayed = page.getByRole('img', {
    name: 'Knife detailed view',
    exact: true,
  })
  await expect
    .poll(() =>
      displayed.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true)
  await expect(displayed).toHaveAttribute(
    'src',
    new RegExp(`^/api/images/${imagePath}`),
  )
  await expect
    .poll(
      async () =>
        new URL(
          await displayed.evaluate(
            (image: HTMLImageElement) => image.currentSrc,
          ),
        ).pathname,
    )
    .toBe(`/api/images/${imagePath}`)
  const dimensions = await displayed.evaluate(
    (image: HTMLImageElement) =>
      new Promise<{ width: number; height: number }>((resolve, reject) => {
        // A responsive image's naturalWidth is density-corrected. Decode the
        // original separately to check its pixel dimensions without srcset.
        const original = new window.Image()
        original.onload = () =>
          resolve({
            width: original.naturalWidth,
            height: original.naturalHeight,
          })
        original.onerror = () =>
          reject(new Error('Original photo did not decode'))
        original.src = image.currentSrc
      }),
  )
  expect(dimensions).toEqual({ width: 4096, height: 4096 })
})
