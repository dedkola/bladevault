// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizablePreviewLayout } from '@/components/resizable-preview-layout'

let resizeCallback: ResizeObserverCallback

class TestResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }

  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

class TestPointerEvent extends MouseEvent {
  pointerId: number
  isPrimary: boolean

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
    this.isPrimary = init.isPrimary ?? true
  }
}

function reportWidth(width: number) {
  act(() => {
    resizeCallback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      {} as ResizeObserver,
    )
  })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('PointerEvent', TestPointerEvent)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ResizablePreviewLayout', () => {
  it('supports keyboard resizing and keeps both panes usable as the window narrows', async () => {
    const user = userEvent.setup()
    render(
      <ResizablePreviewLayout preview={<div>Preview</div>}>
        <div>Form</div>
      </ResizablePreviewLayout>,
    )
    reportWidth(1320)
    const divider = screen.getByRole('separator', { name: 'Knife form width' })
    expect(divider).toHaveAttribute('aria-valuenow', '25')
    divider.focus()

    await user.keyboard('{ArrowRight}')
    expect(divider).toHaveAttribute('aria-valuenow', '27')
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(divider).toHaveAttribute('aria-valuenow', '37')
    await user.keyboard('{ArrowLeft}')
    expect(divider).toHaveAttribute('aria-valuenow', '35')
    await user.keyboard('{Home}{ArrowLeft}')
    expect(divider).toHaveAttribute('aria-valuenow', '25')
    await user.keyboard('{End}{ArrowRight}')
    expect(divider).toHaveAttribute('aria-valuenow', '75')

    reportWidth(724)
    expect(divider).toHaveAttribute('aria-valuemin', '46')
    expect(divider).toHaveAttribute('aria-valuemax', '54')
    expect(divider).toHaveAttribute('aria-valuenow', '54')
    reportWidth(1320)
    expect(divider).toHaveAttribute('aria-valuenow', '75')

    fireEvent.doubleClick(divider)
    expect(divider).toHaveAttribute('aria-valuenow', '25')
  })

  it('captures dragging, stops at the limits, and shields the iframe until release', () => {
    render(
      <ResizablePreviewLayout preview={<iframe title="Product preview" />}>
        <div>Form</div>
      </ResizablePreviewLayout>,
    )
    reportWidth(1320)
    const divider = screen.getByRole('separator')
    const layout = divider.parentElement!
    vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
      left: 200,
      width: 1320,
    } as DOMRect)
    let captured = false
    const release = vi.fn(() => {
      captured = false
    })
    Object.assign(divider, {
      setPointerCapture: vi.fn(() => {
        captured = true
      }),
      hasPointerCapture: vi.fn(() => captured),
      releasePointerCapture: release,
    })
    const preview = screen.getByTitle('Product preview').parentElement!

    fireEvent.pointerMove(divider, { clientX: 2000 })
    expect(divider).toHaveAttribute('aria-valuenow', '25')
    fireEvent.pointerDown(divider, { button: 0, pointerId: 1 })
    expect(preview.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    fireEvent.pointerMove(divider, { clientX: 0, pointerId: 1 })
    expect(divider).toHaveAttribute('aria-valuenow', '25')
    fireEvent.pointerMove(divider, { clientX: 2000, pointerId: 1 })
    expect(divider).toHaveAttribute('aria-valuenow', '75')
    fireEvent.pointerUp(divider, { pointerId: 1 })
    expect(release).toHaveBeenCalledWith(1)
    expect(
      preview.querySelector('[aria-hidden="true"]'),
    ).not.toBeInTheDocument()
    fireEvent.pointerMove(divider, { clientX: 200, pointerId: 1 })
    expect(divider).toHaveAttribute('aria-valuenow', '75')
  })

  it('preserves the form and chosen split when the preview is hidden and reopened', async () => {
    const user = userEvent.setup()
    const form = <input aria-label="Model name" defaultValue="" />
    const preview = <div>Preview</div>
    const view = render(
      <ResizablePreviewLayout preview={preview}>{form}</ResizablePreviewLayout>,
    )
    reportWidth(1320)
    const input = screen.getByRole('textbox')
    await user.type(input, 'Native Chief')
    screen.getByRole('separator').focus()
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')

    view.rerender(<ResizablePreviewLayout>{form}</ResizablePreviewLayout>)
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBe(input)
    expect(input).toHaveValue('Native Chief')

    view.rerender(
      <ResizablePreviewLayout preview={preview}>{form}</ResizablePreviewLayout>,
    )
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '35')
    expect(screen.getByRole('textbox')).toBe(input)
    expect(input).toHaveValue('Native Chief')
  })
})
