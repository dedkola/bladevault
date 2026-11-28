import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { POST } from '@/app/api/knives/route'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

// A 1×1 transparent PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('POST /api/knives photo downloads', () => {
  let vault: TempVault

  beforeEach(async () => {
    vault = await createTempVault('bladevault-skipped-images-')
  })

  afterEach(async () => {
    await vault.cleanup()
  })

  it('saves the knife and reports photos that could not be downloaded', async () => {
    const response = await POST(
      new Request('http://localhost/api/knives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Partly downloaded',
          // A private address is refused, like a photo behind a bot check.
          imageUrls: [PNG, 'http://127.0.0.1/blocked.jpg'],
        }),
      }),
    )
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.knife.images).toHaveLength(1)
    expect(data.skippedImages).toBe(1)
  })

  it('reports no skipped photos when every photo is saved', async () => {
    const response = await POST(
      new Request('http://localhost/api/knives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'All saved', imageUrls: [PNG] }),
      }),
    )
    const data = await response.json()
    expect(data.knife.images).toHaveLength(1)
    expect(data.skippedImages).toBe(0)
  })
})
