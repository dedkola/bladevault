import fs from 'fs/promises'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalStorage } from '@/lib/storage/local'
import type { CreateKnifeInput } from '@/lib/storage/types'
import { createKnife } from '@/tests/fixtures/knife'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

const baseInput: CreateKnifeInput = {
  name: '  Bugout  ',
  brand: ' Benchmade ',
  bladeStyle: 'Drop Point',
  handleMaterial: 'Grivory',
  imageUrls: [],
  specs: {
    weight: '1.85 oz',
    overallLength: '7.46 in',
    bladeLength: '3.24 in',
    country: 'USA',
  },
  customFields: { acquiredFrom: ' Knife  Show ' },
  description: 'Light folder',
  sourceUrl: '',
  pinned: false,
}

afterEach(async () => {
  vi.useRealTimers()
  await vault?.cleanup()
  vault = null
})

describe('LocalStorage', () => {
  it('creates normalized unique records and persists embedded images', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const image = 'data:image/png;base64,aGVsbG8='

    const first = await storage.createKnife({
      ...baseInput,
      imageUrls: [image],
    })
    const second = await storage.createKnife(baseInput)

    expect(first).toMatchObject({
      id: 'bugout',
      name: 'Bugout',
      brand: 'Benchmade',
      customFields: { acquiredFrom: 'Knife Show' },
      images: ['bugout/image-01.png'],
    })
    expect(second.id).toBe('bugout-2')
    await expect(
      fs.readFile(path.join(vault.dataDir, 'images', first.images[0]), 'utf8'),
    ).resolves.toBe('hello')
  })

  it('merges partial updates and applies bulk changes atomically', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const first = await storage.createKnife(baseInput)
    const second = await storage.createKnife({ ...baseInput, name: 'Bailout' })

    const updated = await storage.updateKnife(first.id, {
      specs: { price: ' $200 ' },
      customFields: { box: ' Yes ' },
    })
    expect(updated.specs).toMatchObject({ weight: '1.85 oz', price: '$200' })
    expect(updated.customFields).toEqual({
      acquiredFrom: 'Knife Show',
      box: 'Yes',
    })

    await expect(
      storage.bulkUpdateKnives([first.id, 'missing'], { brand: 'Changed' }),
    ).rejects.toThrow('could not be found')
    expect((await storage.getKnifeById(first.id))?.brand).toBe('Benchmade')

    const bulk = await storage.bulkUpdateKnives(
      [first.id, second.id, first.id],
      { specs: { country: ' Japan ' } },
    )
    expect(bulk).toHaveLength(2)
    expect(bulk.every((knife) => knife.specs.country === 'Japan')).toBe(true)
  })

  it('returns the newest compare item first even when timestamps collide', async () => {
    vault = await createTempVault()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const storage = new LocalStorage()

    await storage.addToCompare('first')
    await storage.addToCompare('second')

    expect(await storage.getCompareList()).toEqual(['second', 'first'])
  })

  it('deletes compare state and the managed image directory with a knife', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = await storage.createKnife({
      ...baseInput,
      imageUrls: ['data:image/png;base64,aGVsbG8='],
    })
    await storage.addToCompare(knife.id)

    await storage.deleteKnife(knife.id)

    expect(await storage.getKnifeById(knife.id)).toBeUndefined()
    expect(await storage.getCompareList()).toEqual([])
    await expect(
      fs.access(path.join(vault.dataDir, 'images', knife.id)),
    ).rejects.toThrow()
  })

  it('rejects traversal into a sibling whose name shares the images prefix', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const sibling = path.join(vault.dataDir, 'images-private')
    await fs.mkdir(sibling, { recursive: true })
    await fs.writeFile(path.join(sibling, 'secret.png'), 'secret')

    await expect(
      storage.getImage('../images-private/secret.png'),
    ).rejects.toThrow('Invalid image path')
  })

  it('rejects missing image streams before returning a response stream', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()

    await expect(storage.getImageStream('missing/image.png')).rejects.toThrow()
  })

  it('preserves custom fields when importing a snapshot', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()
    const knife = createKnife({
      id: 'snapshot',
      customFields: { acquiredFrom: 'Collector Show' },
    })

    await storage.replaceAllWithSnapshot([knife], [])

    expect((await storage.getKnifeById('snapshot'))?.customFields).toEqual({
      acquiredFrom: 'Collector Show',
    })
  })

  it('fills gaps when generating unique ids', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()

    const first = await storage.createKnife(baseInput)
    expect(first.id).toBe('bugout')

    const second = await storage.createKnife(baseInput)
    expect(second.id).toBe('bugout-2')

    const third = await storage.createKnife(baseInput)
    expect(third.id).toBe('bugout-3')

    await storage.deleteKnife(second.id)

    const fourth = await storage.createKnife(baseInput)
    expect(fourth.id).toBe('bugout-2')

    const ids = [first.id, third.id, fourth.id].sort()
    expect(ids).toEqual(['bugout', 'bugout-2', 'bugout-3'])
  })

  it('handles many duplicate names efficiently', async () => {
    vault = await createTempVault()
    const storage = new LocalStorage()

    const createdIds: string[] = []
    for (let i = 0; i < 100; i += 1) {
      const knife = await storage.createKnife(baseInput)
      createdIds.push(knife.id)
    }

    const uniqueIds = new Set(createdIds)
    expect(uniqueIds.size).toBe(createdIds.length)
    expect(createdIds[0]).toBe('bugout')
    expect(createdIds[1]).toBe('bugout-2')
    expect(createdIds[createdIds.length - 1]).toBe('bugout-100')
  })
})
