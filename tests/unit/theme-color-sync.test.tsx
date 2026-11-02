// @vitest-environment jsdom

import { act, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ThemeColorSync } from '@/components/theme-color-sync'

afterEach(() => {
  document.documentElement.classList.remove('dark')
  delete document.documentElement.dataset.themeStyle
  document.querySelector('meta[name="theme-color"]')?.remove()
})

it('updates browser chrome when the theme style or color mode changes', async () => {
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  document.head.append(meta)
  const { unmount } = render(<ThemeColorSync />)

  expect(meta.content).toBe('#fcfcfb')

  for (const [style, dark, color] of [
    ['classic', true, '#18150f'],
    ['modern', false, '#f5f5f7'],
    ['modern', true, '#0d0d0f'],
    ['alloy', false, '#101010'],
    ['alloy', true, '#080808'],
  ] as const) {
    await act(async () => {
      document.documentElement.dataset.themeStyle = style
      document.documentElement.classList.toggle('dark', dark)
    })
    await waitFor(() => expect(meta.content).toBe(color))
  }

  unmount()
})
