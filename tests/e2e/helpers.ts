import type { APIRequestContext } from '@playwright/test'

export async function resetVault(request: APIRequestContext) {
  const response = await request.get('/api/knives')
  const payload = (await response.json()) as { knives?: Array<{ id: string }> }

  for (const knife of payload.knives ?? []) {
    await request.delete(`/api/knives/${knife.id}`)
  }

  await request.delete('/api/compare')
  await request.post('/api/settings', {
    data: {
      theme: 'light',
      pinnedItemsFirst: true,
      cardFields: ['bladeStyle', 'handleMaterial'],
      cloudBackupLastSyncedAt: '',
      cloudAutoBackupEnabled: false,
      mcpEnabled: true,
      mcpWriteEnabled: false,
      customFields: [],
    },
  })
}

export async function seedKnife(
  request: APIRequestContext,
  overrides: Record<string, unknown> = {},
) {
  const response = await request.post('/api/knives', {
    data: {
      name: 'Bugout',
      brand: 'Benchmade',
      bladeStyle: 'Drop Point',
      handleMaterial: 'Grivory',
      description: 'Lightweight folder',
      specs: {
        weight: '1.85 oz',
        overallLength: '7.46 in',
        bladeLength: '3.24 in',
        bladeMaterial: 'CPM-S30V',
        price: '$180',
        country: 'USA',
      },
      customFields: {},
      imageUrls: [],
      sourceUrl: '',
      pinned: false,
      ...overrides,
    },
  })

  if (!response.ok()) {
    throw new Error(
      `Failed to seed knife: ${response.status()} ${await response.text()}`,
    )
  }

  return (await response.json()) as { knife: { id: string } }
}
