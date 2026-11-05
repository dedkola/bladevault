// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlloyCollectionCard } from '@/components/alloy-collection-card'
import { createKnife } from '@/tests/fixtures/knife'

const state = vi.hoisted(() => ({
  updateKnife: vi.fn(),
  showFeedback: vi.fn(),
  choose: vi.fn(),
  membershipCount: vi.fn(),
  dimensionUnit: 'in' as 'in' | 'mm' | 'both',
}))

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => state,
}))
vi.mock('@/components/providers/comparisons-provider', () => ({
  useComparisons: () => ({
    ...state,
    loading: false,
    busy: false,
    error: null,
  }),
}))

beforeEach(() => {
  state.dimensionUnit = 'in'
  state.updateKnife.mockReset().mockResolvedValue(undefined)
  state.showFeedback.mockReset()
  state.choose.mockReset().mockResolvedValue(undefined)
  state.membershipCount.mockReset().mockReturnValue(0)
})
afterEach(cleanup)

describe('Alloy collection cards', () => {
  it('keeps preferred units and comparison list selection while inspecting separately', async () => {
    const user = userEvent.setup()
    const knife = createKnife({
      specs: {
        ...createKnife().specs,
        bladeLength: '3.24" / 82.3 mm',
        weight: '1.85oz / 52.4 g',
      },
    })
    const onOpen = vi.fn()
    render(
      <AlloyCollectionCard knife={knife} onOpen={onOpen} onSelect={vi.fn()} />,
    )
    expect(screen.getByText('CPM-S30V · 3.24 in · 1.85 oz')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Compare Bugout' }))
    expect(state.choose).toHaveBeenCalledWith([knife.id])
    expect(onOpen).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', { name: 'Inspect Benchmade Bugout' }),
    )
    expect(onOpen).toHaveBeenCalledWith(knife)
  })

  it('updates metric and dual-unit lengths and weights from settings', () => {
    const knife = createKnife({
      specs: {
        ...createKnife().specs,
        bladeLength: '3.5 in',
        weight: '5.04oz / 142.8g',
      },
    })
    state.dimensionUnit = 'mm'
    const { rerender } = render(
      <AlloyCollectionCard knife={knife} onOpen={vi.fn()} onSelect={vi.fn()} />,
    )
    expect(screen.getByText('CPM-S30V · 88.9 mm · 142.8 g')).toBeVisible()
    state.dimensionUnit = 'both'
    rerender(
      <AlloyCollectionCard knife={knife} onOpen={vi.fn()} onSelect={vi.fn()} />,
    )
    expect(
      screen.getByText('CPM-S30V · 88.9 mm / 3.5 in · 142.8 g / 5.04 oz'),
    ).toBeVisible()
  })

  it('reports a failed pin without converting it into a successful update', async () => {
    const user = userEvent.setup()
    state.updateKnife.mockRejectedValue(new Error('Vault is locked'))
    const knife = createKnife()
    render(
      <AlloyCollectionCard knife={knife} onOpen={vi.fn()} onSelect={vi.fn()} />,
    )
    await user.click(screen.getByRole('button', { name: 'Pin Bugout' }))
    await waitFor(() => {
      expect(state.showFeedback).toHaveBeenCalledWith(
        'Vault is locked',
        'error',
      )
    })
    expect(state.updateKnife).toHaveBeenCalledWith(knife.id, { pinned: true })
    expect(screen.getByRole('button', { name: 'Pin Bugout' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('uses bulk selection instead of opening the inspector in selection mode', async () => {
    const user = userEvent.setup()
    const knife = createKnife()
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    render(
      <AlloyCollectionCard
        knife={knife}
        selectionMode
        onOpen={onOpen}
        onSelect={onSelect}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: 'Select Benchmade Bugout' }),
    )
    expect(onSelect).toHaveBeenCalledWith(knife.id)
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Pin Bugout' })).toBeNull()
  })
})
