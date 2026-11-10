// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeCollectionGrid } from '@/components/forge-collection'
import { ModernCollectionGallery } from '@/components/modern-collection-table'
import { createKnife } from '@/tests/fixtures/knife'
import type { CardField } from '@/lib/settings-shared'

const state = vi.hoisted(() => ({
  updateKnife: vi.fn(),
  showFeedback: vi.fn(),
  pinnedItemsFirst: true,
  cardFields: [] as CardField[],
  customFieldDefinitions: [],
  dimensionUnit: 'in' as 'in' | 'mm' | 'both',
  choose: vi.fn(),
  membershipCount: vi.fn(),
}))

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => state,
}))
vi.mock('@/components/providers/comparisons-provider', () => ({
  useComparisons: () => ({
    ...state,
    lists: [],
    loading: false,
    busy: false,
    error: null,
  }),
}))

beforeEach(() => {
  state.cardFields = []
  state.customFieldDefinitions = []
  state.dimensionUnit = 'in'
  state.updateKnife.mockReset().mockResolvedValue(undefined)
  state.showFeedback.mockReset()
  state.choose.mockReset().mockResolvedValue(undefined)
  state.membershipCount.mockReset().mockReturnValue(0)
})
afterEach(cleanup)

const knife = createKnife()
const selectedFields: CardField[] = [
  'specs.lockingMechanism',
  'specs.bladeMaterial',
  'specs.bladeLength',
  'specs.designer',
  'specs.country',
  'specs.price',
]

describe('Modern family collection cards', () => {
  it('shows selected card fields and the model number in the gallery', () => {
    state.cardFields = selectedFields
    render(
      <ModernCollectionGallery
        knives={[knife]}
        dimensionUnit="in"
        onOpen={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    )

    expect(screen.getByText('Benchmade · 535')).toBeVisible()
    expect(screen.getByText('Locking mechanism')).toHaveAttribute(
      'data-modern-object-field-label',
    )
    expect(screen.getByText('AXIS Lock')).toBeVisible()
    expect(screen.getByText('Blade material')).toBeVisible()
    expect(screen.getByText('CPM-S30V')).toBeVisible()
    expect(screen.getByText('Price')).toBeVisible()
    expect(screen.getByText('$180')).toBeVisible()
    expect(screen.queryByText('Blade style')).toBeNull()
    expect(screen.queryByText('Grivory')).toBeNull()
    expect(screen.getAllByText('3.24 in')).toHaveLength(1)
  })

  it('shows selected card fields on Forge cards', () => {
    state.cardFields = selectedFields
    render(
      <ForgeCollectionGrid
        knives={[knife]}
        dimensionUnit="in"
        onOpen={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    )

    expect(screen.getByText('Locking mechanism')).toBeVisible()
    expect(screen.getByText('AXIS Lock')).toBeVisible()
    expect(screen.getByText('Blade material')).toBeVisible()
    expect(screen.getByText('CPM-S30V')).toBeVisible()
    expect(screen.getByText('Price')).toBeVisible()
    expect(screen.getByText('$180')).toBeVisible()
    expect(screen.queryByText('Steel')).toBeNull()
    expect(screen.queryByText('Lock')).toBeNull()
  })
})
