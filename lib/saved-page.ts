// Client-safe helpers for importing product pages the person saved from their
// own browser (File → Save Page As). No filesystem or network access here.

export const SAVED_PAGE_ACCEPT = '.html,.htm,.xhtml,.mhtml,.mht'
export const MAX_SAVED_PAGE_FILE_BYTES = 100 * 1024 * 1024
export const MAX_SAVED_PAGE_HTML_CHARS = 20 * 1024 * 1024

export class SavedPageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SavedPageError'
  }
}

export type SavedPage = {
  html: string
  /** Original page address recorded by the browser, when available. */
  url?: string
}

const UNSUPPORTED_FILE =
  'Choose a product page saved from your browser as “Webpage, Complete” (.html) or “Webpage, Single File” (.mhtml).'

function isMhtml(fileName: string, text: string): boolean {
  if (/\.mht(ml)?$/i.test(fileName)) return true
  const head = text.slice(0, 4096)
  return (
    /^content-type:\s*multipart\/related/im.test(head) &&
    /^mime-version:/im.test(head)
  )
}

function readHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>()
  // Unfold continuation lines before splitting into name/value pairs.
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    headers.set(
      line.slice(0, index).trim().toLowerCase(),
      line.slice(index + 1).trim(),
    )
  }
  return headers
}

function splitHeaders(part: string): { headers: string; body: string } {
  const match = /\r?\n\r?\n/.exec(part)
  if (!match) return { headers: part, body: '' }
  return {
    headers: part.slice(0, match.index),
    body: part.slice(match.index + match[0].length),
  }
}

function headerParam(value: string | undefined, name: string): string {
  if (!value) return ''
  const match = new RegExp(
    `(?:^|;)\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`,
    'i',
  ).exec(value)
  return match ? (match[2] ?? match[1]) : ''
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function decodeQuotedPrintable(body: string, charset: string): string {
  const text = body.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
      continue
    }
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes.push(code)
    else bytes.push(...new TextEncoder().encode(char))
  }
  return decodeBytes(Uint8Array.from(bytes), charset)
}

function decodeBase64(body: string, charset: string): string {
  const binary = atob(body.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return decodeBytes(bytes, charset)
}

/** Extract the main HTML document from a Chrome/Edge single-file (.mhtml) save. */
export function extractMhtmlDocument(text: string): SavedPage {
  const top = splitHeaders(text)
  const headers = readHeaders(top.headers)
  const boundary = headerParam(headers.get('content-type'), 'boundary')
  if (!boundary) throw new SavedPageError(UNSUPPORTED_FILE)
  const snapshotUrl = headers.get('snapshot-content-location')

  for (const rawPart of top.body.split(`--${boundary}`)) {
    const part = rawPart.replace(/^\r?\n/, '')
    if (!part.trim() || part.startsWith('--')) continue
    const section = splitHeaders(part)
    const partHeaders = readHeaders(section.headers)
    const type = partHeaders.get('content-type') ?? ''
    if (!/^text\/html\b/i.test(type)) continue
    const charset = headerParam(type, 'charset')
    const encoding = (
      partHeaders.get('content-transfer-encoding') ?? ''
    ).toLowerCase()
    let html: string
    try {
      html =
        encoding === 'quoted-printable'
          ? decodeQuotedPrintable(section.body, charset)
          : encoding === 'base64'
            ? decodeBase64(section.body, charset)
            : section.body
    } catch {
      throw new SavedPageError(UNSUPPORTED_FILE)
    }
    const url = snapshotUrl || partHeaders.get('content-location')
    return { html, ...(url ? { url } : {}) }
  }
  throw new SavedPageError(UNSUPPORTED_FILE)
}

/** Read a saved webpage file's text into the HTML BladeVault can import. */
export function parseSavedPage(fileName: string, text: string): SavedPage {
  if (/\.webarchive$/i.test(fileName) || text.startsWith('bplist'))
    throw new SavedPageError(
      'Safari web archives are not supported. In Safari choose File → Save As → Format: Page Source, or save the page from Chrome or Edge.',
    )
  const page = isMhtml(fileName, text)
    ? extractMhtmlDocument(text)
    : { html: text }
  if (!/<(html|head|body|main|div|meta|title)\b/i.test(page.html))
    throw new SavedPageError(UNSUPPORTED_FILE)
  if (page.html.length > MAX_SAVED_PAGE_HTML_CHARS)
    throw new SavedPageError(
      'This saved page is too large to import. Save only the product page and try again.',
    )
  return page
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .trim()
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(tag)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value ? decodeAttribute(value) : undefined
}

function findTagAttribute(
  html: string,
  tagName: string,
  test: (tag: string) => boolean,
  attribute: string,
): string | undefined {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
  for (const match of html.matchAll(pattern)) {
    if (test(match[0])) {
      const value = attributeValue(match[0], attribute)
      if (value) return value
    }
  }
  return undefined
}

function asHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Find the page's original address: the browser's "saved from" note first,
 * then canonical and Open Graph URLs published by the retailer.
 */
export function findSavedPageUrl(html: string): string | undefined {
  const head = html.slice(0, 512 * 1024)
  const savedFrom = /<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/i.exec(head)?.[1]
  return (
    asHttpUrl(savedFrom) ??
    asHttpUrl(
      findTagAttribute(
        head,
        'link',
        (tag) => /\brel\s*=\s*["']?canonical\b/i.test(tag),
        'href',
      ),
    ) ??
    asHttpUrl(
      findTagAttribute(
        head,
        'meta',
        (tag) => /\bproperty\s*=\s*["']?og:url\b/i.test(tag),
        'content',
      ),
    )
  )
}

/** Product markup that a verification interstitial would not contain. */
export function hasProductMarkup(html: string): boolean {
  return (
    /"@type"\s*:\s*\[?\s*"Product"/i.test(html) ||
    /\bitemtype\s*=\s*["']https?:\/\/schema\.org\/Product["']/i.test(html) ||
    /<meta\b[^>]*\bproperty\s*=\s*["']og:type["'][^>]*\bcontent\s*=\s*["'](?:og:)?product\b/i.test(
      html,
    )
  )
}

/**
 * "Webpage, Complete" saves rewrite downloaded images to a local
 * `<name>_files/` folder that resolves to nonexistent retailer URLs.
 */
export function isSavedPageLocalImage(src: string): boolean {
  if (src.startsWith('data:')) return false
  try {
    const url = new URL(src)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
    return /\/[^/]*_files\//i.test(decodeURIComponent(url.pathname))
  } catch {
    return true
  }
}
