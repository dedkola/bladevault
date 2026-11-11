import { describe, expect, it } from 'vitest'
import {
  applyNoteMarkdownCommand,
  markdownToPlainText,
} from '@/lib/note-markdown'

describe('applyNoteMarkdownCommand', () => {
  it('wraps the selection in bold markers and keeps it selected', () => {
    const result = applyNoteMarkdownCommand('a blade note', 2, 7, 'bold')
    expect(result.value).toBe('a **blade** note')
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe(
      'blade',
    )
  })

  it('inserts placeholder text when there is no selection', () => {
    const result = applyNoteMarkdownCommand('', 0, 0, 'italic')
    expect(result.value).toBe('*italic*')
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe(
      'italic',
    )
  })

  it('removes markers when the selection is already wrapped', () => {
    const result = applyNoteMarkdownCommand('a **blade** note', 4, 9, 'bold')
    expect(result.value).toBe('a blade note')
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe(
      'blade',
    )
  })

  it('adds headings to every selected line and toggles them off', () => {
    const added = applyNoteMarkdownCommand('one\ntwo', 0, 7, 'heading')
    expect(added.value).toBe('## one\n## two')

    const removed = applyNoteMarkdownCommand(
      added.value,
      0,
      added.value.length,
      'heading',
    )
    expect(removed.value).toBe('one\ntwo')
  })

  it('prefixes quotes and removes them on a second pass', () => {
    const quoted = applyNoteMarkdownCommand('carried it', 0, 10, 'quote')
    expect(quoted.value).toBe('> carried it')
    expect(applyNoteMarkdownCommand(quoted.value, 0, 12, 'quote').value).toBe(
      'carried it',
    )
  })

  it('numbers each line of a numbered list', () => {
    const result = applyNoteMarkdownCommand('one\ntwo', 0, 7, 'numberedList')
    expect(result.value).toBe('1. one\n2. two')
  })

  it('replaces list markers when switching list style', () => {
    const result = applyNoteMarkdownCommand(
      '- one\n- two',
      0,
      11,
      'numberedList',
    )
    expect(result.value).toBe('1. one\n2. two')
  })

  it('selects the placeholder URL after inserting a link', () => {
    const result = applyNoteMarkdownCommand('see docs', 4, 8, 'link')
    expect(result.value).toBe('see [docs](https://)')
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe(
      'https://',
    )
  })

  it('inserts a table surrounded by blank lines', () => {
    const result = applyNoteMarkdownCommand('intro', 5, 5, 'table')
    expect(
      result.value.startsWith(
        'intro\n\n| Column 1 | Column 2 |\n| --- | --- |',
      ),
    ).toBe(true)
    expect(result.selectionStart).toBe(result.value.length)
  })

  it('inserts a divider surrounded by blank lines', () => {
    const result = applyNoteMarkdownCommand('intro', 5, 5, 'divider')
    expect(result.value).toBe('intro\n\n---')
  })

  it('selects only the code content in a new code block', () => {
    const result = applyNoteMarkdownCommand('abc', 0, 0, 'codeBlock')
    expect(result.value).toBe('```\ncode\n```\n\nabc')
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe(
      'code',
    )
  })

  it('clamps out-of-range selections', () => {
    const result = applyNoteMarkdownCommand('blade', 99, -4, 'inlineCode')
    expect(result.value).toBe('blade`code`')
  })
})

describe('markdownToPlainText', () => {
  it('flattens block and inline formatting', () => {
    expect(
      markdownToPlainText(
        '## Edge\n\n**sharp** and `thin`\n\n- one\n- two\n\n> quoted',
      ),
    ).toBe('Edge sharp and thin one two quoted')
  })

  it('drops table pipes and separator rows', () => {
    expect(
      markdownToPlainText('| Steel | HRC |\n| --- | --- |\n| M390 | 61 |'),
    ).toBe('Steel HRC M390 61')
  })

  it('keeps link labels and code block content', () => {
    expect(markdownToPlainText('[docs](https://example.com)')).toBe('docs')
    expect(markdownToPlainText('```js\nconst steel = 1\n```')).toBe(
      'const steel = 1',
    )
  })

  it('leaves plain text untouched', () => {
    expect(markdownToPlainText('  Carried it all summer.  ')).toBe(
      'Carried it all summer.',
    )
  })
})
