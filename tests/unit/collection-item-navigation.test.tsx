// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnifeCard } from '@/components/knife-card'
import { AlloyCollectionCard } from '@/components/alloy-collection-card'
import {
  ModernCollectionGallery,
  ModernCollectionTable,
} from '@/components/modern-collection-table'
import { createKnife } from '@/tests/fixtures/knife'

const state = vi.hoisted(() => ({
  updateKnife: vi.fn(),
  showFeedback: vi.fn(),
  choose: vi.fn(),
  membershipCount: vi.fn(),
}))

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({
    ...state,
    pinnedItemsFirst: true,
    cardFields: [],
    customFieldDefinitions: [],
  }),
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
  state.updateKnife.mockReset().mockResolvedValue(undefined)
  state.showFeedback.mockReset()
  state.choose.mockReset().mockResolvedValue(undefined)
  state.membershipCount.mockReset().mockReturnValue(0)
})
afterEach(cleanup)

describe('collection item navigation', () => {
  for (const variant of ['classic', 'alloy', 'modern'] as const) {
    it(`opens ${variant} item details on double-click while preserving preview and keyboard actions`, async () => {
      const user = userEvent.setup()
      const knife = createKnife()
      const onOpen = vi.fn()
      const onOpenDetail = vi.fn()

      render(
        variant === 'classic' ? (
          <KnifeCard
            knife={knife}
            onOpen={onOpen}
            onOpenDetail={onOpenDetail}
          />
        ) : variant === 'alloy' ? (
          <AlloyCollectionCard
            knife={knife}
            onOpen={onOpen}
            onOpenDetail={onOpenDetail}
            onSelect={vi.fn()}
          />
        ) : (
          <ModernCollectionGallery
            knives={[knife]}
            onOpen={onOpen}
            onOpenDetail={onOpenDetail}
          />
        ),
      )

      const preview = screen.getByRole('button', {
        name: /^(Preview|Inspect) Benchmade Bugout/,
      })
      await user.click(preview)
      expect(onOpen).not.toHaveBeenCalled()
      await waitFor(() => expect(onOpen).toHaveBeenCalledWith(knife))
      expect(onOpenDetail).not.toHaveBeenCalled()

      onOpen.mockClear()
      preview.focus()
      await user.keyboard('{Enter}')
      expect(onOpen).toHaveBeenCalledWith(knife)
      expect(onOpenDetail).not.toHaveBeenCalled()

      onOpen.mockClear()
      await user.dblClick(preview)
      expect(onOpenDetail).toHaveBeenCalledExactlyOnceWith(knife)
      await new Promise((resolve) => setTimeout(resolve, 550))
      expect(onOpen).not.toHaveBeenCalled()
    })
  }

  for (const variant of ['classic', 'alloy'] as const) {
    const Card = variant === 'classic' ? KnifeCard : AlloyCollectionCard

    it(`keeps ${variant} double-clicks in bulk selection mode`, async () => {
      const user = userEvent.setup()
      const knife = createKnife()
      const onOpen = vi.fn()
      const onOpenDetail = vi.fn()
      const onSelect = vi.fn()
      render(
        <Card
          knife={knife}
          selectionMode
          onOpen={onOpen}
          onOpenDetail={onOpenDetail}
          onSelect={onSelect}
        />,
      )

      await user.dblClick(
        screen.getByRole('button', { name: 'Select Benchmade Bugout' }),
      )
      expect(onSelect).toHaveBeenCalledWith(knife.id)
      expect(onOpen).not.toHaveBeenCalled()
      expect(onOpenDetail).not.toHaveBeenCalled()
    })

    it(`does not navigate when ${variant} pin or comparison controls are double-clicked`, async () => {
      const user = userEvent.setup()
      const knife = createKnife()
      const onOpen = vi.fn()
      const onOpenDetail = vi.fn()
      render(
        <Card
          knife={knife}
          onOpen={onOpen}
          onOpenDetail={onOpenDetail}
          onSelect={vi.fn()}
        />,
      )

      await user.dblClick(screen.getByRole('button', { name: /^Pin / }))
      await user.dblClick(
        screen.getByRole('button', {
          name:
            variant === 'classic' ? /^Add .* to compare$/ : 'Compare Bugout',
        }),
      )
      expect(state.updateKnife).toHaveBeenCalledWith(knife.id, { pinned: true })
      expect(state.choose).toHaveBeenCalledWith([knife.id])
      expect(onOpen).not.toHaveBeenCalled()
      expect(onOpenDetail).not.toHaveBeenCalled()
    })
  }

  it('cancels a pending preview when its card unmounts', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const { unmount } = render(
      <KnifeCard
        knife={createKnife()}
        onOpen={onOpen}
        onOpenDetail={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /^Preview / }))
    unmount()
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('opens list row details on double-click while keeping selection checkboxes separate', async () => {
    const user = userEvent.setup()
    const knife = createKnife()
    const onOpen = vi.fn()
    const onOpenDetail = vi.fn()
    const onSelect = vi.fn()
    render(
      <ModernCollectionTable
        knives={[knife]}
        onOpen={onOpen}
        onOpenDetail={onOpenDetail}
        columns={[]}
        selectedIds={new Set()}
        onSelect={onSelect}
        onSelectAll={vi.fn()}
        allSelected={false}
        someSelected={false}
        onReorderColumn={vi.fn()}
        columnWidths={{}}
        onResizeColumn={vi.fn()}
      />,
    )

    await user.dblClick(screen.getByRole('checkbox', { name: 'Select Bugout' }))
    expect(onSelect).toHaveBeenCalledWith(knife.id)
    expect(onOpen).not.toHaveBeenCalled()
    expect(onOpenDetail).not.toHaveBeenCalled()

    await user.dblClick(screen.getByText('Bugout', { exact: true }))
    expect(onOpenDetail).toHaveBeenCalledExactlyOnceWith(knife)
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(onOpen).not.toHaveBeenCalled()
  })
})
