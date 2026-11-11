/** Formatting commands offered by the note editor toolbar. */
export type NoteMarkdownCommand =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'heading'
  | 'quote'
  | 'bulletList'
  | 'numberedList'
  | 'inlineCode'
  | 'codeBlock'
  | 'link'
  | 'table'
  | 'divider'

export type NoteMarkdownResult = {
  value: string
  selectionStart: number
  selectionEnd: number
}

const TABLE_TEMPLATE =
  '| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |\n| Cell | Cell |'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function safeSelection(
  value: string,
  start: number,
  end: number,
): [number, number] {
  const safeStart = clamp(start, 0, value.length)
  return [safeStart, clamp(end, safeStart, value.length)]
}

function wrapSelection(
  value: string,
  start: number,
  end: number,
  marker: string,
  placeholder: string,
): NoteMarkdownResult {
  const selected = value.slice(start, end)
  const alreadyWrapped =
    selected.length > 0 &&
    value.slice(start - marker.length, start) === marker &&
    value.slice(end, end + marker.length) === marker

  if (alreadyWrapped) {
    const next =
      value.slice(0, start - marker.length) +
      selected +
      value.slice(end + marker.length)
    return {
      value: next,
      selectionStart: start - marker.length,
      selectionEnd: end - marker.length,
    }
  }

  const text = selected || placeholder
  return {
    value: value.slice(0, start) + marker + text + marker + value.slice(end),
    selectionStart: start + marker.length,
    selectionEnd: start + marker.length + text.length,
  }
}

function getLineRange(
  value: string,
  start: number,
  end: number,
): [number, number] {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const nextBreak = value.indexOf('\n', end)
  return [lineStart, nextBreak === -1 ? value.length : nextBreak]
}

/**
 * Rewrites every selected line and keeps the selection anchored to the same
 * characters, so the caret does not jump to the end of the note.
 */
function transformLines(
  value: string,
  start: number,
  end: number,
  add: (line: string, index: number) => string,
  has: (line: string) => boolean,
  strip: (line: string) => string,
): NoteMarkdownResult {
  const [lineStart, lineEnd] = getLineRange(value, start, end)
  const lines = value.slice(lineStart, lineEnd).split('\n')
  const remove = lines.every(has)
  const nextLines = lines.map((line, index) =>
    remove ? strip(line) : add(line, index),
  )

  const selectionStart = start - lineStart
  const selectionEnd = end - lineStart
  let originalOffset = 0
  let nextOffset = 0
  let mappedStart = selectionStart
  let mappedEnd = selectionEnd

  for (let index = 0; index < lines.length; index += 1) {
    const originalLength = lines[index].length
    const nextLength = nextLines[index].length
    if (
      selectionStart >= originalOffset &&
      selectionStart <= originalOffset + originalLength
    ) {
      mappedStart = nextOffset + (selectionStart - originalOffset)
    }
    if (
      selectionEnd >= originalOffset &&
      selectionEnd <= originalOffset + originalLength
    ) {
      mappedEnd = nextOffset + (selectionEnd - originalOffset)
    }
    originalOffset += originalLength + 1
    nextOffset += nextLength + 1
  }

  return {
    value:
      value.slice(0, lineStart) + nextLines.join('\n') + value.slice(lineEnd),
    selectionStart: lineStart + mappedStart,
    selectionEnd: lineStart + mappedEnd,
  }
}

function stripHeadingMarker(line: string): string {
  return line.replace(/^#{1,6}\s+/, '')
}

function stripQuoteMarker(line: string): string {
  return line.replace(/^>\s?/, '')
}

function stripListMarker(line: string): string {
  return line.replace(/^(\s*)(?:[-*+]|\d+\.)\s+/, '$1')
}

function insertBlock(
  value: string,
  start: number,
  end: number,
  block: string,
  blockSelection?: [number, number],
): NoteMarkdownResult {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const prefix = !before
    ? ''
    : before.endsWith('\n\n')
      ? ''
      : before.endsWith('\n')
        ? '\n'
        : '\n\n'
  const suffix = !after
    ? ''
    : after.startsWith('\n\n')
      ? ''
      : after.startsWith('\n')
        ? '\n'
        : '\n\n'
  const insertion = `${prefix}${block}${suffix}`
  const blockStart = start + prefix.length
  const [relativeStart, relativeEnd] = blockSelection ?? [
    block.length,
    block.length,
  ]
  return {
    value: before + insertion + after,
    selectionStart: blockStart + relativeStart,
    selectionEnd: blockStart + relativeEnd,
  }
}

/**
 * Applies a toolbar command to a Markdown note, returning the next value and
 * the selection that should be restored on the textarea.
 */
export function applyNoteMarkdownCommand(
  value: string,
  start: number,
  end: number,
  command: NoteMarkdownCommand,
): NoteMarkdownResult {
  const [selectionStart, selectionEnd] = safeSelection(value, start, end)

  switch (command) {
    case 'bold':
      return wrapSelection(
        value,
        selectionStart,
        selectionEnd,
        '**',
        'bold text',
      )
    case 'italic':
      return wrapSelection(value, selectionStart, selectionEnd, '*', 'italic')
    case 'strikethrough':
      return wrapSelection(
        value,
        selectionStart,
        selectionEnd,
        '~~',
        'struck text',
      )
    case 'inlineCode':
      return wrapSelection(value, selectionStart, selectionEnd, '`', 'code')
    case 'heading':
      return transformLines(
        value,
        selectionStart,
        selectionEnd,
        (line) => `## ${stripHeadingMarker(line)}`,
        (line) => /^#{1,6}\s+/.test(line),
        stripHeadingMarker,
      )
    case 'quote':
      return transformLines(
        value,
        selectionStart,
        selectionEnd,
        (line) => `> ${stripQuoteMarker(line)}`,
        (line) => /^>\s?/.test(line),
        stripQuoteMarker,
      )
    case 'bulletList':
      return transformLines(
        value,
        selectionStart,
        selectionEnd,
        (line) => `- ${stripListMarker(line)}`,
        (line) => /^\s*[-*+]\s+/.test(line),
        stripListMarker,
      )
    case 'numberedList':
      return transformLines(
        value,
        selectionStart,
        selectionEnd,
        (line, index) => `${index + 1}. ${stripListMarker(line)}`,
        (line) => /^\s*\d+\.\s+/.test(line),
        stripListMarker,
      )
    case 'link': {
      const selected = value.slice(selectionStart, selectionEnd)
      const label = selected || 'link text'
      const url = 'https://'
      const insertion = `[${label}](${url})`
      const urlStart = selectionStart + label.length + 3
      return {
        value:
          value.slice(0, selectionStart) +
          insertion +
          value.slice(selectionEnd),
        selectionStart: urlStart,
        selectionEnd: urlStart + url.length,
      }
    }
    case 'codeBlock': {
      const content = value.slice(selectionStart, selectionEnd) || 'code'
      return insertBlock(
        value,
        selectionStart,
        selectionEnd,
        `\`\`\`\n${content}\n\`\`\``,
        [4, 4 + content.length],
      )
    }
    case 'table':
      return insertBlock(value, selectionStart, selectionEnd, TABLE_TEMPLATE)
    case 'divider':
      return insertBlock(value, selectionStart, selectionEnd, '---')
    default:
      return { value, selectionStart, selectionEnd }
  }
}

/**
 * Flattens Markdown to readable text for one-line previews such as the
 * History tab. Rendering notes still goes through react-markdown.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, '')
    .replace(/^\s*\|(.*)\|\s*$/gm, (_match, cells: string) =>
      cells.replace(/\|/g, ' '),
    )
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
