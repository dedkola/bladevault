// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NoteMarkdown } from '@/components/note-markdown'

afterEach(cleanup)

describe('NoteMarkdown', () => {
  it('keeps single line breaks from plain-text notes', () => {
    render(<NoteMarkdown body={'Bought at Blade Show.\nGreat action.'} />)

    expect(
      screen.getByText(/Bought at Blade Show\./).closest('p'),
    ).toContainHTML('<br')
  })

  it('renders GitHub tables', () => {
    render(
      <NoteMarkdown body={'| Steel | HRC |\n| --- | --- |\n| M390 | 61 |'} />,
    )

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: 'Steel' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '61' })).toBeInTheDocument()
  })

  it('drops raw HTML instead of rendering it', () => {
    render(<NoteMarkdown body={'safe <script>alert(1)</script>'} />)

    expect(document.querySelector('script')).toBeNull()
  })

  it('renders unsafe link protocols as plain text', () => {
    render(<NoteMarkdown body={'[click](javascript:alert(1))'} />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('click').tagName).toBe('SPAN')
  })

  it('renders safe links in a new tab', () => {
    render(<NoteMarkdown body={'[docs](https://example.com/specs)'} />)

    const link = screen.getByRole('link', { name: 'docs' })
    expect(link).toHaveAttribute('href', 'https://example.com/specs')
    expect(link).toHaveAttribute('rel', 'noreferrer noopener')
  })
})
