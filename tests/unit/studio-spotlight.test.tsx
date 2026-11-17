// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StudioSpotlight } from '@/components/studio-spotlight'
import { hydrateKnifeListItem, toKnifeListItem } from '@/lib/data'
import { pickSpotlight, spotlightDateKey } from '@/lib/spotlight'
import { createKnife } from '@/tests/fixtures/knife'

const STORAGE_KEY = 'bladevault-studio-spotlight'

const knives = Array.from({ length: 6 }, (_, index) =>
  hydrateKnifeListItem(
    toKnifeListItem(
      createKnife({
        id: `knife-${index}`,
        name: `Knife ${index}`,
        images: [`https://example.com/${index}.jpg`],
      }),
    ),
  ),
)

function shownId() {
  return screen
    .getByRole('region', { name: 'Knife of the day' })
    .getAttribute('data-studio-spotlight')
}

function stored() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('Studio spotlight', () => {
  it('shows today’s seeded pick and remembers it for the day', () => {
    const today = spotlightDateKey()
    const expected = pickSpotlight(knives, today)!
    render(<StudioSpotlight knives={knives} onQuickLook={vi.fn()} />)
    expect(shownId()).toBe(expected.id)
    expect(
      screen.getByRole('heading', { level: 2, name: expected.name }),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'View knife' })).toHaveAttribute(
      'href',
      `/collection/${expected.id}`,
    )
    expect(stored()).toEqual({ date: today, knifeId: expected.id, nonce: 0 })
  })

  it('shuffles to a different knife and keeps it across remounts', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <StudioSpotlight knives={knives} onQuickLook={vi.fn()} />,
    )
    const first = shownId()
    await user.click(
      screen.getByRole('button', { name: 'Shuffle today’s pick' }),
    )
    const second = shownId()
    expect(second).not.toBe(first)
    expect(stored()).toMatchObject({ knifeId: second })
    expect(stored().nonce).toBeGreaterThan(0)

    unmount()
    render(<StudioSpotlight knives={knives} onQuickLook={vi.fn()} />)
    expect(shownId()).toBe(second)
  })

  it('ignores a pick saved on another day or for a deleted knife', () => {
    const today = spotlightDateKey()
    const seeded = pickSpotlight(knives, today)!
    const other = knives.find((knife) => knife.id !== seeded.id)!
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ date: '2000-01-01', knifeId: other.id, nonce: 3 }),
    )
    const { unmount } = render(
      <StudioSpotlight knives={knives} onQuickLook={vi.fn()} />,
    )
    expect(shownId()).toBe(seeded.id)
    unmount()

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ date: today, knifeId: 'deleted', nonce: 0 }),
    )
    render(<StudioSpotlight knives={knives} onQuickLook={vi.fn()} />)
    expect(shownId()).toBe(seeded.id)
  })

  it('opens Quick Look for the pick and disables Shuffle with one candidate', async () => {
    const user = userEvent.setup()
    const onQuickLook = vi.fn()
    const only = [
      knives[0],
      { ...knives[1], sold: true },
      { ...knives[2], images: [], imageCount: 0 },
    ]
    render(<StudioSpotlight knives={only} onQuickLook={onQuickLook} />)
    const region = screen.getByRole('region', { name: 'Knife of the day' })
    expect(shownId()).toBe(knives[0].id)
    expect(
      within(region).getByRole('button', { name: 'Shuffle today’s pick' }),
    ).toBeDisabled()
    const quickLook = within(region).getByRole('button', { name: 'Quick look' })
    await user.click(quickLook)
    expect(onQuickLook).toHaveBeenCalledWith(knives[0].id, quickLook)
  })

  it('renders nothing for an empty collection', () => {
    const { container } = render(
      <StudioSpotlight knives={[]} onQuickLook={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
