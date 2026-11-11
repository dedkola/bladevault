// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InspectorTabs } from '@/components/inspector-tabs'
import type { KnifeNote, MaintenanceEvent } from '@/lib/data'
import { createKnife } from '@/tests/fixtures/knife'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function historyLabels(): string[] {
  return [...document.querySelectorAll('[data-inspector-history] > li')].map(
    (item) => item.querySelector('b')?.textContent ?? '',
  )
}

const events: MaintenanceEvent[] = [
  {
    id: 3,
    knifeId: 'benchmade-bugout',
    type: 'lubrication',
    occurredAt: '2026-11-07',
    notes: '',
    createdAt: '2026-11-07T10:00:00.000Z',
  },
  {
    id: 2,
    knifeId: 'benchmade-bugout',
    type: 'sharpening',
    occurredAt: '2026-11-03',
    notes: '',
    createdAt: '2026-11-03T10:00:00.000Z',
  },
  {
    id: 1,
    knifeId: 'benchmade-bugout',
    type: 'stropping',
    occurredAt: '2026-10-07',
    notes: '',
    createdAt: '2026-10-07T10:00:00.000Z',
  },
]

const notes: KnifeNote[] = [
  {
    id: 1,
    knifeId: 'benchmade-bugout',
    body: 'Pocket clip loosened after a month of carry.',
    notedAt: '2026-11-05T12:00:00.000Z',
    createdAt: '2026-11-05T12:00:00.000Z',
    updatedAt: '2026-11-05T12:00:00.000Z',
  },
]

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/notes')
        ? jsonResponse({ notes })
        : jsonResponse({ events }),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Inspector history tab', () => {
  it('orders record milestones, maintenance entries and notes newest first', async () => {
    const user = userEvent.setup()
    render(
      <InspectorTabs
        knife={createKnife({
          addedAt: '2026-06-21T09:00:00.000Z',
          updatedAt: '2026-09-27T09:00:00.000Z',
        })}
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'History' }))
    await waitFor(() =>
      expect(historyLabels()).toEqual([
        'Lubrication',
        'Note',
        'Sharpening',
        'Stropping',
        'Record updated',
        'Catalogued',
      ]),
    )
  })

  it('keeps maintenance entries out of History when a Maintenance tab exists', async () => {
    const user = userEvent.setup()
    render(
      <InspectorTabs
        knife={createKnife({
          addedAt: '2026-06-21T09:00:00.000Z',
          updatedAt: '2026-09-27T09:00:00.000Z',
        })}
        maintenanceTab
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'History' }))
    await waitFor(() =>
      expect(historyLabels()).toEqual(['Note', 'Record updated', 'Catalogued']),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/\/notes$/)
  })
})
