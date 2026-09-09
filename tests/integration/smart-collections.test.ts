import { afterEach, describe, expect, it } from 'vitest'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'
import { closeLocalDb } from '@/lib/local-db'
import { getSmartCollections } from '@/lib/smart-collections-storage'
import { DELETE, POST } from '@/app/api/smart-collections/route'
import { saveSettings } from '@/lib/settings'

let vault: TempVault | undefined
afterEach(async () => {
  await vault?.cleanup()
  vault = undefined
})
const request = (body: unknown) =>
  new Request('http://localhost/api/smart-collections', {
    method: 'POST',
    body: JSON.stringify(body),
  })
describe('saved smart collection persistence', () => {
  it('persists, renames, updates rules, and deletes without affecting settings', async () => {
    vault = await createTempVault()
    const response = await POST(
      request({
        name: ' Small blades ',
        query: 'bladeLengthMax=80&view=families',
      }),
    )
    expect(response.status).toBe(200)
    const { collection } = await response.json()
    saveSettings({ theme: 'dark' })
    closeLocalDb()
    expect(getSmartCollections()).toEqual([
      { id: collection.id, name: 'Small blades', query: 'bladeLengthMax=80' },
    ])
    expect(
      (
        await POST(
          request({
            id: collection.id,
            name: 'Light blades',
            query: 'weightMax=100',
          }),
        )
      ).status,
    ).toBe(200)
    closeLocalDb()
    expect(getSmartCollections()[0].query).toBe('weightMax=100')
    expect((await DELETE(request({ id: collection.id }))).status).toBe(200)
    expect(getSmartCollections()).toEqual([])
    expect((await DELETE(request({ id: collection.id }))).status).toBe(404)
  })
  it('rejects malformed requests, empty rules, and reversed ranges', async () => {
    vault = await createTempVault()
    for (const body of [
      null,
      {},
      { name: ' ', query: 'brand=A' },
      { name: 'Test', query: '' },
      { name: 'Test', query: 'weightMin=100&weightMax=50' },
      { name: 'Test', query: 'weightMax=nope' },
    ])
      expect((await POST(request(body))).status).toBe(400)
    expect(getSmartCollections()).toEqual([])
  })
})
