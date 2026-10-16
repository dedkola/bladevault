export function getSafeExternalUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null

  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null
  } catch {
    return null
  }
}

/** Comparison key only; keep the original source URL on the record. */
export function normalizeSourceUrl(
  value: string | null | undefined,
): string | null {
  const safeUrl = getSafeExternalUrl(value?.trim())
  if (!safeUrl) return null

  const url = new URL(safeUrl)
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.searchParams.sort()
  return url.href
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
