// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { useRef, useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModernCollectionInspector } from '@/components/modern-collection-inspector'
import { createKnife } from '@/tests/fixtures/knife'

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function InspectorHarness({
  variant = 'alloy',
  autoSelected = false,
}: {
  variant?: 'alloy' | 'modern'
  autoSelected?: boolean
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const knife = createKnife()
  return (
    <>
      <button ref={triggerRef} onClick={() => setOpen(true)}>
        Inspect knife
      </button>
      {open && (
        <ModernCollectionInspector
          knife={knife}
          variant={variant}
          siblings={[knife]}
          hasMoreImages={false}
          onPreviousImage={vi.fn()}
          onNextImage={vi.fn()}
          onSelect={vi.fn()}
          onClose={() => setOpen(false)}
          onPin={vi.fn()}
          onCompare={vi.fn()}
          pinBusy={false}
          compareBusy={false}
          inCompare={false}
          autoSelected={autoSelected}
          returnFocusRef={triggerRef}
        />
      )}
    </>
  )
}

describe('Alloy phone inspector focus', () => {
  it('moves focus inside, traps Tab, closes with Escape and restores its trigger', async () => {
    const user = userEvent.setup()
    render(<InspectorHarness />)
    const trigger = screen.getByRole('button', { name: 'Inspect knife' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(dialog).toContainElement(document.activeElement as HTMLElement),
    )
    for (let index = 0; index < 10; index++) {
      await user.tab()
      await waitFor(() =>
        expect(dialog).toContainElement(document.activeElement as HTMLElement),
      )
    }
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it.each([
    { variant: 'modern' as const, autoSelected: false },
    { variant: 'alloy' as const, autoSelected: true },
  ])(
    'keeps $variant automatic=$autoSelected outside modal focus behavior',
    async (props) => {
      const user = userEvent.setup()
      render(<InspectorHarness {...props} />)
      const trigger = screen.getByRole('button', { name: 'Inspect knife' })
      await user.click(trigger)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(trigger).toHaveFocus()
    },
  )
})
