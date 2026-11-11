// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnifeUserNotes } from '@/components/knife-user-notes'

vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => ({ scheduleVaultBackup: () => {} }),
}))

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ notes: [] })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openComposer() {
  const user = userEvent.setup()
  render(<KnifeUserNotes knifeId="benchmade-bugout" />)
  await user.click(await screen.findByRole('button', { name: 'Add note' }))
  const editor = screen.getByLabelText('Note') as HTMLTextAreaElement
  return { user, editor }
}

describe('KnifeUserNotes composer', () => {
  it('wraps the selected text in bold markers', async () => {
    const { user, editor } = await openComposer()
    await user.type(editor, 'blade')
    editor.setSelectionRange(0, 5)

    await user.click(screen.getByRole('button', { name: 'Bold' }))

    expect(editor).toHaveValue('**blade**')
    expect(editor.selectionStart).toBe(2)
    expect(editor.selectionEnd).toBe(7)
  })

  it('inserts a table template', async () => {
    const { user, editor } = await openComposer()

    await user.click(screen.getByRole('button', { name: 'Table' }))

    expect((editor as HTMLTextAreaElement).value).toContain(
      '| Column 1 | Column 2 |',
    )
  })

  it('renders Markdown in the preview tab', async () => {
    const { user, editor } = await openComposer()
    await user.type(editor, '**blade** and `61 HRC`')

    await user.click(screen.getByRole('tab', { name: 'Preview' }))

    expect(screen.getByText('blade').tagName).toBe('STRONG')
    expect(screen.getByText('61 HRC').tagName).toBe('CODE')
  })
})
