import { afterEach, describe, expect, it } from 'vitest'
import * as compareRoute from '@/app/api/compare/route'
import * as bulkRoute from '@/app/api/knives/bulk/route'
import * as bulkPinRoute from '@/app/api/knives/bulk/pin/route'
import * as knifeRoute from '@/app/api/knives/[id]/route'
import * as knivesRoute from '@/app/api/knives/route'
import { saveSettings } from '@/lib/settings'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('knife API routes', () => {
  it('rejects empty normalized names and creates a valid knife', async () => {
    vault = await createTempVault()

    const invalid = await knivesRoute.POST(
      jsonRequest('http://localhost/api/knives', 'POST', { name: '   ' }),
    )
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toEqual({ error: 'Name is required' })

    const created = await knivesRoute.POST(
      jsonRequest('http://localhost/api/knives', 'POST', {
        name: ' Native 5 ',
        brand: ' Quiet Carry ',
        specs: { country: ' Taiwan ' },
        customFields: { condition: ' New ' },
      }),
    )
    expect(created.status).toBe(200)
    const payload = (await created.json()) as {
      knife: { id: string; name: string; brand: string }
    }
    expect(payload.knife).toMatchObject({
      id: 'native-5',
      name: 'Native 5',
      brand: 'Quiet Carry',
    })

    const list = await knivesRoute.GET()
    const listPayload = (await list.json()) as { knives: Array<{ id: string }> }
    expect(listPayload.knives.map((knife) => knife.id)).toEqual(['native-5'])
  })

  it('filters patch fields and returns 404 for an unknown knife', async () => {
    vault = await createTempVault()
    await knivesRoute.POST(
      jsonRequest('http://localhost/api/knives', 'POST', {
        name: 'Knife',
        brand: 'Original',
      }),
    )

    const updated = await knifeRoute.PATCH(
      jsonRequest('http://localhost/api/knives/knife', 'PATCH', {
        brand: ' Updated ',
        addedAt: 'forged',
        specs: { price: ' $42 ', unsupported: 'ignored' },
      }),
      { params: Promise.resolve({ id: 'knife' }) },
    )
    const payload = (await updated.json()) as {
      knife: { brand: string; addedAt: string; specs: Record<string, string> }
    }
    expect(payload.knife.brand).toBe('Updated')
    expect(payload.knife.addedAt).not.toBe('forged')
    expect(payload.knife.specs.price).toBe('$42')
    expect(payload.knife.specs.unsupported).toBeUndefined()

    const missing = await knifeRoute.PATCH(
      jsonRequest('http://localhost/api/knives/missing', 'PATCH', {
        brand: 'Nope',
      }),
      { params: Promise.resolve({ id: 'missing' }) },
    )
    expect(missing.status).toBe(404)
  })

  it('validates bulk fields and persists compare mutations', async () => {
    vault = await createTempVault()
    for (const name of ['First', 'Second']) {
      await knivesRoute.POST(
        jsonRequest('http://localhost/api/knives', 'POST', { name }),
      )
    }
    saveSettings({
      customFields: [{ id: 'condition', name: 'Condition', type: 'text' }],
    })

    const unsupported = await bulkRoute.PATCH(
      jsonRequest('http://localhost/api/knives/bulk', 'PATCH', {
        ids: ['first'],
        field: 'customFields.unknown',
        value: 'New',
      }),
    )
    expect(unsupported.status).toBe(400)

    const bulk = await bulkRoute.PATCH(
      jsonRequest('http://localhost/api/knives/bulk', 'PATCH', {
        ids: ['first', 'second', 'first'],
        field: 'customFields.condition',
        value: ' New ',
      }),
    )
    const bulkPayload = (await bulk.json()) as {
      knives: Array<{ customFields: Record<string, string> }>
    }
    expect(bulkPayload.knives).toHaveLength(2)
    expect(
      bulkPayload.knives.every(
        (knife) => knife.customFields.condition === 'New',
      ),
    ).toBe(true)

    for (const id of ['first', 'second']) {
      await compareRoute.POST(
        jsonRequest('http://localhost/api/compare', 'POST', { id }),
      )
    }
    const compared = (await (await compareRoute.GET()).json()) as {
      compareIds: string[]
    }
    expect(compared.compareIds).toEqual(['second', 'first'])

    await compareRoute.DELETE(
      jsonRequest('http://localhost/api/compare', 'DELETE', { id: 'second' }),
    )
    expect(
      ((await (await compareRoute.GET()).json()) as { compareIds: string[] })
        .compareIds,
    ).toEqual(['first'])

    await compareRoute.DELETE(
      jsonRequest('http://localhost/api/compare', 'DELETE', {}),
    )
    const bulkCompare = await compareRoute.POST(
      jsonRequest('http://localhost/api/compare', 'POST', {
        ids: ['first', 'second', 'first'],
      }),
    )
    expect(
      ((await bulkCompare.json()) as { compareIds: string[] }).compareIds,
    ).toEqual(['first', 'second'])
  })
})

describe('bulk pin API route', () => {
  it('validates input and bulk-updates pinned state', async () => {
    vault = await createTempVault()

    for (const name of ['Alpha', 'Beta']) {
      await knivesRoute.POST(
        jsonRequest('http://localhost/api/knives', 'POST', { name }),
      )
    }

    // rejects missing pinned field
    const missingPinned = await bulkPinRoute.POST(
      jsonRequest('http://localhost/api/knives/bulk/pin', 'POST', {
        ids: ['alpha'],
      }),
    )
    expect(missingPinned.status).toBe(400)

    // rejects empty ids array
    const emptyIds = await bulkPinRoute.POST(
      jsonRequest('http://localhost/api/knives/bulk/pin', 'POST', {
        ids: [],
        pinned: true,
      }),
    )
    expect(emptyIds.status).toBe(400)

    // strips invalid entries and deduplicates
    const pin = await bulkPinRoute.POST(
      jsonRequest('http://localhost/api/knives/bulk/pin', 'POST', {
        ids: ['alpha', 'beta', '', 123, 'alpha'],
        pinned: true,
      }),
    )
    expect(pin.status).toBe(200)
    const pinPayload = (await pin.json()) as { knives: Array<{ id: string; pinned: boolean }> }
    expect(pinPayload.knives).toHaveLength(2)
    expect(pinPayload.knives.every((k) => k.pinned)).toBe(true)

    // unpin
    const unpin = await bulkPinRoute.POST(
      jsonRequest('http://localhost/api/knives/bulk/pin', 'POST', {
        ids: ['alpha'],
        pinned: false,
      }),
    )
    expect(unpin.status).toBe(200)
    const unpinPayload = (await unpin.json()) as { knives: Array<{ pinned: boolean }> }
    expect(unpinPayload.knives.every((k) => !k.pinned)).toBe(true)
  })
})
