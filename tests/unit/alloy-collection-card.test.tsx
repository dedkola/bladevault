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
  state.updateKnife.mockReset().mockResolvedValue(undefined)
  state.showFeedback.mockReset()
  state.choose.mockReset().mockResolvedValue(undefined)
  state.membershipCount.mockReset().mockReturnValue(0)
})
afterEach(cleanup)

describe('Alloy collection cards', () => {
  it('keeps original units and comparison list selection while inspecting separately', async () => {
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
