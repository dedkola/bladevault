export function getOrdinalDay(day: number): string {
  const lastTwoDigits = day % 100
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) return `${day}th`
  if (day % 10 === 1) return `${day}st`
  if (day % 10 === 2) return `${day}nd`
  if (day % 10 === 3) return `${day}rd`
  return `${day}th`
}

export function formatActivityCounts(
  addedCount: number,
  editedCount: number,
  maintainedCount = 0,
): string {
  const parts: string[] = []
  if (addedCount > 0) {
    parts.push(`${addedCount} ${addedCount === 1 ? 'knife' : 'knives'} added`)
  }
  if (editedCount > 0) {
    parts.push(
      `${editedCount} ${editedCount === 1 ? 'knife' : 'knives'} edited`,
    )
  }
  if (maintainedCount > 0) {
    parts.push(
      `${maintainedCount} ${maintainedCount === 1 ? 'knife' : 'knives'} maintained`,
    )
  }
  return parts.join(' · ')
}

export function formatActivityDayLabel(
  date: Date,
  addedCount: number,
  editedCount: number,
  maintainedCount = 0,
): string {
  const formattedDate = `${date.toLocaleDateString(undefined, {
    month: 'long',
  })} ${getOrdinalDay(date.getDate())}`
  const counts = formatActivityCounts(addedCount, editedCount, maintainedCount)
  if (!counts)
    return `No knives added, edited, or maintained on ${formattedDate}.`
  return `${counts} on ${formattedDate}.`
}
