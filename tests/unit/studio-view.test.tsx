// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { WorkspaceHeaderActionsContext } from '@/components/workspace-header-actions'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudioView } from '@/components/studio'
import { hydrateKnifeListItem, toKnifeListItem } from '@/lib/data'
import { createKnife } from '@/tests/fixtures/knife'

function fullKnife(id: string) {
  return createKnife({
    id,
    name: id === 'first' ? 'First knife' : 'Second knife',
    pinned: id === 'first',
    images:
      id === 'first'
        ? ['https://example.com/front.jpg', 'https://example.com/back.jpg']
        : [],
  })
}

const state = vi.hoisted(() => ({ themeStyle: 'current' }))
vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({
    ...state,
    knives: ['first', 'second'].map((id) =>
      hydrateKnifeListItem(toKnifeListItem(fullKnife(id))),
    ),
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

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            knife: fullKnife(url.endsWith('/first') ? 'first' : 'second'),
          }),
        ),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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

  it('browses the open knife photos with buttons and keyboard and resets on reopen', async () => {
    const user = userEvent.setup()
    render(<StudioView />)
    const trigger = screen.getByRole('button', {
      name: 'Quick look: Benchmade First knife',
    })
    await user.click(trigger)
    let dialog = screen.getByRole('dialog')
    const photo = () => within(dialog).getByRole('img')
    const expectPhoto = (filename: string, count: string) => {
      expect(photo().getAttribute('src')).toContain(
        encodeURIComponent(filename),
      )
      expect(within(dialog).getByText(count)).toBeVisible()
      expect(
        within(dialog).getByRole('heading', { name: 'First knife' }),
      ).toBeVisible()
    }
    await within(dialog).findByText('1 / 2')
    expect(fetch).toHaveBeenCalledWith(
      '/api/knives/first',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expectPhoto('front.jpg', '1 / 2')
    await user.click(within(dialog).getByRole('button', { name: 'Next image' }))
    expectPhoto('back.jpg', '2 / 2')
    await user.click(within(dialog).getByRole('button', { name: 'Next image' }))
    expectPhoto('front.jpg', '1 / 2')
    await user.click(
      within(dialog).getByRole('button', { name: 'Previous image' }),
    )
    expectPhoto('back.jpg', '2 / 2')
    await user.keyboard('{ArrowLeft}')
    expectPhoto('front.jpg', '1 / 2')
    await user.keyboard('{ArrowRight}')
    expectPhoto('back.jpg', '2 / 2')
    await user.keyboard('{Escape}')
    await user.click(trigger)
    dialog = screen.getByRole('dialog')
    await within(dialog).findByText('1 / 2')
    expectPhoto('front.jpg', '1 / 2')
  })

  it('keeps a knife without photos open and disables image navigation', async () => {
    const user = userEvent.setup()
    render(<StudioView />)
    await user.click(
      screen.getByRole('button', {
        name: 'Quick look: Benchmade Second knife',
      }),
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('No photo yet')).toBeVisible()
    expect(await within(dialog).findByText('0 / 0')).toBeVisible()
    expect(
      within(dialog).getByRole('button', { name: 'Previous image' }),
    ).toBeDisabled()
    expect(
      within(dialog).getByRole('button', { name: 'Next image' }),
    ).toBeDisabled()
    await user.keyboard('{ArrowRight}')
    expect(
      within(dialog).getByRole('heading', { name: 'Second knife' }),
    ).toBeVisible()
    expect(within(dialog).getByText('0 / 0')).toBeVisible()
  })

  it('shows loading while fetching the full gallery and reports a failed request', async () => {
    let resolvePhotos!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolvePhotos = resolve
        }),
    )
    const user = userEvent.setup()
    render(<StudioView />)
    await user.click(
      screen.getByRole('button', { name: 'Quick look: Benchmade First knife' }),
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Loading photos…')).toBeVisible()
    expect(
      within(dialog).getByRole('button', { name: 'Next image' }),
    ).toBeDisabled()
    resolvePhotos(
      new Response(JSON.stringify({ error: 'Could not load photos.' }), {
        status: 500,
      }),
    )
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Could not load photos.',
    )
    expect(within(dialog).getByRole('img')).toBeVisible()
    expect(
      within(dialog).getByRole('button', { name: 'Next image' }),
    ).toBeDisabled()
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
      screen.queryByRole('heading', {
        level: 1,
        name: 'The collection, at a glance.',
      }),
    ).not.toBeInTheDocument()
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
