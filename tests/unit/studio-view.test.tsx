// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { WorkspaceHeaderActionsContext } from '@/components/workspace-header-actions'
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

    await user.click(screen.getByRole('button', { name: 'Pinned' }))
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

  it('moves modern Studio focus mode into the workspace header', async () => {
    const user = userEvent.setup()
    function Workspace() {
      const [target, setTarget] = useState<HTMLElement | null>(null)
      return (
        <WorkspaceHeaderActionsContext.Provider value={target}>
          <div id="studio-header-actions" ref={setTarget} />
          <StudioView />
        </WorkspaceHeaderActionsContext.Provider>
      )
    }
    const { container, rerender } = render(<Workspace />)
    state.themeStyle = 'modern'
    rerender(<Workspace />)
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'The collection, at a glance.',
      }),
    ).toBeVisible()
    expect(
      container.querySelector('[data-page-header]'),
    ).not.toBeInTheDocument()
    const focusButton = screen.getByRole('button', { name: 'Focus mode' })
    expect(focusButton).toBeEnabled()
    expect(focusButton.parentElement).toHaveAttribute(
      'id',
      'studio-header-actions',
    )
    expect(focusButton.textContent).toBe('')
    expect(
      screen.queryByRole('link', { name: /Add knife/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Visual library')).not.toBeInTheDocument()
    await user.click(focusButton)
    expect(
      screen.getByRole('dialog', { name: 'Studio focus mode' }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Exit focus' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(focusButton).toHaveFocus()
    expect(container.querySelectorAll('[data-studio-tile]')).toHaveLength(2)
  })
})
