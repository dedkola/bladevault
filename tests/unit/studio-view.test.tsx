// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StudioView } from '@/components/studio'
import { createKnife } from '@/tests/fixtures/knife'

const state = vi.hoisted(() => ({ themeStyle: 'current' }))
vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({
    ...state,
    knives: [
      createKnife({ id: 'first', name: 'First knife', pinned: true }),
      createKnife({ id: 'second', name: 'Second knife', pinned: false }),
    ],
    isLoading: false,
    updateKnife: vi.fn(),
    showFeedback: vi.fn(),
  }),
}))
vi.mock('@/components/providers/comparisons-provider', () => ({
  useComparisons: () => ({
    choose: vi.fn(),
    membershipCount: () => 0,
    loading: false,
    busy: false,
    error: null,
  }),
}))

afterEach(() => {
  cleanup()
  state.themeStyle = 'current'
})

describe('Studio themes', () => {
  it('uses the shared default header and keeps search and pinned filtering usable', async () => {
    const user = userEvent.setup()
    const { container } = render(<StudioView />)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Studio' }),
    ).toBeVisible()
    expect(container.querySelector('[data-page-header]')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Add knife/ })).toHaveAttribute(
      'href',
      '/add',
    )
    expect(container.querySelectorAll('[data-studio-tile]')).toHaveLength(2)

    await user.click(
      screen.getByRole('button', { name: 'Pinned', exact: true }),
    )
    expect(container.querySelectorAll('[data-studio-tile]')).toHaveLength(1)
    expect(
      container.querySelector('[data-studio-tile="first"]'),
    ).toBeInTheDocument()

    await user.type(
      screen.getByRole('searchbox', { name: 'Search knives' }),
      'Second',
    )
    expect(
      screen.getByRole('heading', { name: 'No matching knives' }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Show all knives' }))
    expect(container.querySelectorAll('[data-studio-tile]')).toHaveLength(2)
  })

  it('retains the modern Studio header when the theme changes', () => {
    const { container, rerender } = render(<StudioView />)
    state.themeStyle = 'modern'
    rerender(<StudioView />)
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'The collection, at a glance.',
      }),
    ).toBeVisible()
    expect(
      container.querySelector('[data-page-header]'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Focus mode' })).toBeEnabled()
    expect(container.querySelectorAll('[data-studio-tile]')).toHaveLength(2)
  })
})
