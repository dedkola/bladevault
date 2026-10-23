/** Compact presentation only; keep the stored measurement untouched. */
export function compactMeasurement(value?: string, fallback = '—'): string {
  if (!value?.trim()) return fallback
  return value
    .split(/[|/]/)[0]
    .trim()
    .replace(/(\d)\s*(?:["″]|inch(?:es)?\b|in\b\.?)/i, '$1 in')
    .replace(/(\d)\s*oz\b/i, '$1 oz')
}
