/** Format a knife count while preserving a caller's localized number. */
export function formatKnifeCount(
  count: number,
  formattedCount = String(count),
) {
  return `${formattedCount} ${count === 1 ? 'knife' : 'knives'}`
}
