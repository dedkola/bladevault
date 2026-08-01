import type { Knife } from '@/lib/data'

export function createKnife(overrides: Partial<Knife> = {}): Knife {
  return {
    id: 'benchmade-bugout',
    name: 'Bugout',
    brand: 'Benchmade',
    bladeStyle: 'Drop Point',
    handleMaterial: 'Grivory',
    images: [],
    specs: {
      weight: '1.85 oz',
      overallLength: '7.46 in',
      bladeLength: '3.24 in',
      bladeThickness: '0.09 in',
      bladeCoating: '',
      bladeMaterial: 'CPM-S30V',
      lockingMechanism: 'AXIS Lock',
      designer: '',
      modelNumber: '535',
      handleLength: '4.22 in',
      hardness: '58-60 HRC',
      price: '$180',
      country: 'USA',
    },
    customFields: {},
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    description: 'Lightweight everyday carry knife.',
    sourceUrl: 'https://example.com/bugout',
    pinned: false,
    ...overrides,
  }
}
