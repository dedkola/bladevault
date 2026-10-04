// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompletenessDetail } from '@/components/insight-pages/completeness-detail'
import { createKnife } from '@/tests/fixtures/knife'
import type { Knife } from '@/lib/data'

const state = vi.hoisted(() => ({
  knives: [] as Knife[],
  bulkUpdateKnives: vi.fn(),
  refreshVault: vi.fn(),
  showFeedback: vi.fn(),
}))
vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => state,
}))
vi.mock('@/components/insights-chart', () => ({ InsightsChart: () => <div /> }))

beforeEach(() => {
  state.knives = []
  state.bulkUpdateKnives.mockReset().mockResolvedValue([])
  state.refreshVault.mockReset().mockResolvedValue(undefined)
  state.showFeedback.mockReset()
  window.sessionStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input === '/api/smart-collections')
        return Response.json({ collections: [] })
      const knife = state.knives.find((knife) => input.endsWith(`/${knife.id}`))
      return knife
        ? Response.json({ knife })
        : Response.json({ error: 'Knife not found' }, { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('guided cleanup review', () => {
  it('keeps review usable when session storage writes are blocked', async () => {
    const user = userEvent.setup()
    state.knives = [
      createKnife({ specs: { ...createKnife().specs, bladeThickness: '' } }),
    ]
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Storage full', 'QuotaExceededError')
      })
    render(<CompletenessDetail />)
    await user.click(
      screen.getByRole('button', {
        name: 'Review 1 missing blade thickness values',
      }),
    )
    await screen.findByRole('textbox', { name: 'Blade thickness' })
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    expect(await screen.findByText(/Review finished/)).toHaveTextContent(
      '0 saved · 1 skipped',
    )
    write.mockRestore()
    await user.click(screen.getByRole('button', { name: 'Finish review' }))
    expect(
      screen.queryByRole('button', { name: 'Resume review' }),
    ).not.toBeInTheDocument()
    expect(state.bulkUpdateKnives).not.toHaveBeenCalled()
  })
  it('keeps valid fractional source notation out of the issue queues', () => {
    state.knives = [
      createKnife({
        specs: { ...createKnife().specs, bladeThickness: '.090 inches' },
      }),
    ]
    render(<CompletenessDetail />)
    expect(
      screen.getByRole('button', {
        name: 'Review 0 uninterpretable blade thickness values',
      }),
    ).toBeDisabled()
  })

  it('saves only the reviewed field and version, advances, and resumes progress after returning', async () => {
    const user = userEvent.setup()
    state.knives = ['first', 'second'].map((id) =>
      createKnife({
        id,
        name: id,
        specs: { ...createKnife().specs, bladeThickness: '' },
      }),
    )
    const view = render(<CompletenessDetail />)
    await user.click(
      screen.getByRole('button', {
        name: 'Review 2 missing blade thickness values',
      }),
    )
    const input = await screen.findByRole('textbox', {
      name: 'Blade thickness',
    })
    await user.type(input, '.090 inches')
    expect(screen.getByRole('status')).toHaveTextContent(
      '2.286 mm — understood',
    )
    await user.click(screen.getByRole('button', { name: 'Save and next' }))
    expect(state.bulkUpdateKnives).toHaveBeenCalledWith(
      ['first'],
      'specs.bladeThickness',
      '.090 inches',
      { first: state.knives[0].updatedAt },
    )
    await screen.findByText(/Knife 2 of 2/)
    view.unmount()
    render(<CompletenessDetail />)
    await user.click(screen.getByRole('button', { name: 'Resume review' }))
    await screen.findByText('Benchmade second')
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    expect(await screen.findByText(/Review finished/)).toHaveTextContent(
      '1 saved · 1 skipped',
    )
    await user.click(screen.getByRole('button', { name: 'Finish review' }))
    expect(
      screen.queryByRole('button', { name: 'Resume review' }),
    ).not.toBeInTheDocument()
  })

  it('does not advance after a failed save and allows skipping without saving', async () => {
    const user = userEvent.setup()
    state.knives = [
      createKnife({
        specs: { ...createKnife().specs, bladeThickness: 'unknown' },
      }),
    ]
    state.bulkUpdateKnives.mockRejectedValue(
      new Error('The collection changed after this review.'),
    )
    render(<CompletenessDetail />)
    await user.click(
      screen.getByRole('button', {
        name: 'Review 1 uninterpretable blade thickness values',
      }),
    )
    const input = await screen.findByRole('textbox', {
      name: 'Blade thickness',
    })
    expect(screen.getByRole('button', { name: 'Save and next' })).toBeDisabled()
    await user.clear(input)
    await user.type(input, '3 mm')
    await user.click(screen.getByRole('button', { name: 'Save and next' }))
    await screen.findByRole('alert')
    expect(screen.getByText(/Knife 1 of 1/)).toBeInTheDocument()
    expect(input).toHaveValue('3 mm')
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    expect(await screen.findByText(/Review finished/)).toHaveTextContent(
      '0 saved · 1 skipped',
    )
    expect(state.bulkUpdateKnives).toHaveBeenCalledTimes(1)
  })

  it('previews exact material changes and requires acknowledgement of affected saved filters', async () => {
    const user = userEvent.setup()
    state.knives = [
      createKnife({ id: 'old', name: 'Old', handleMaterial: 'G10' }),
      createKnife({ id: 'keep', name: 'Keep', handleMaterial: 'G-10' }),
      createKnife({
        id: 'composite',
        name: 'Composite',
        handleMaterial: 'Carbon Fiber / G-10',
      }),
    ]
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        collections: [
          { id: 'saved', name: 'G10 knives', query: 'handleMaterial=G10' },
        ],
      }),
    )
    render(<CompletenessDetail />)
    await user.click(screen.getByRole('button', { name: /Review labels/ }))
    const dialog = screen.getByRole('dialog')
    await within(dialog).findByRole('link', { name: 'G10 knives' })
    expect(
      within(dialog).getByRole('list', { name: 'Knives to update' }),
    ).toHaveTextContent('Benchmade Old')
    expect(
      within(dialog).queryByText(/Benchmade Keep|Composite/),
    ).not.toBeInTheDocument()
    const apply = within(dialog).getByRole('button', {
      name: 'Apply to 1 knife',
    })
    expect(apply).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(apply)
    expect(state.bulkUpdateKnives).toHaveBeenCalledWith(
      ['old'],
      'handleMaterial',
      'G-10',
      { old: state.knives[0].updatedAt },
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
  })

  it('makes no changes when a label preview is canceled', async () => {
    const user = userEvent.setup()
    state.knives = [
      createKnife({ id: 'a', handleMaterial: 'G10' }),
      createKnife({ id: 'b', handleMaterial: 'G-10' }),
    ]
    render(<CompletenessDetail />)
    await user.click(screen.getByRole('button', { name: /Review labels/ }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(state.bulkUpdateKnives).not.toHaveBeenCalled()
    expect(state.knives.map((knife) => knife.handleMaterial)).toEqual([
      'G10',
      'G-10',
    ])
  })
})
