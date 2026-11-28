/**
 * What AI saw on a store page it doubts, kept with the store link so the
 * user can compare it with their own knife. Pure, client-safe: the Inbox,
 * Price Drops and the Market tab render the same comparison.
 */

/** The knife details AI compares, named after the knife's own fields. */
export const REVIEW_FIELDS = [
  'modelNumber',
  'lockingMechanism',
  'bladeCoating',
  'handleMaterial',
] as const
export type ReviewField = (typeof REVIEW_FIELDS)[number]

export const REVIEW_FIELD_LABEL: Record<ReviewField, string> = {
  modelNumber: 'Model no.',
  lockingMechanism: 'Lock',
  bladeCoating: 'Blade finish',
  handleMaterial: 'Handle',
}

/** AI's call on one detail: same as the knife, a real conflict, or unclear. */
export const REVIEW_MATCHES = ['same', 'different', 'unknown'] as const
export type ReviewMatch = (typeof REVIEW_MATCHES)[number]

export type ReviewPageField = { value: string | null; match: ReviewMatch }

/** Stored with the store link (price_sources.review_detail, JSON). */
export type ReviewDetail = {
  /** VerifyIssue: why AI doubts the reading. */
  issue: string
  /** A price AI found on the page, as written there. */
  pagePrice: string | null
  /** The product title on the page. */
  title: string | null
  page: Partial<Record<ReviewField, ReviewPageField>>
  /**
   * The knife's details AI compared against. One the user changed since
   * then is no longer AI's call: it shows as unknown until the next check.
   */
  compared?: Partial<Record<ReviewField, string>>
}

/** Issues that ask "is this link your knife?" rather than about a price. */
const VERSION_ISSUES = new Set(['wrong_variant', 'wrong_product'])

export function isVersionIssue(issue: string | null | undefined): boolean {
  return VERSION_ISSUES.has(issue ?? '')
}

export type ComparisonRow = {
  field: ReviewField
  label: string
  /** The knife's own value, read live; '' when the knife has none. */
  yours: string
  /** What the page says; null when AI did not find it there. */
  page: string | null
  match: ReviewMatch
  /** The user changed this detail since AI compared it. */
  changed?: boolean
}

/** The comparison for one doubted store link, ready to render. */
export type SourceReview = {
  issue: string
  /** The question is about the knife (version), not about the price. */
  version: boolean
  pagePrice: string | null
  title: string | null
  rows: ComparisonRow[]
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean ? clean.slice(0, max) : null
}

/** Reads a stored review; anything malformed reads as none. */
export function parseReviewDetail(
  json: string | null | undefined,
): ReviewDetail | null {
  if (!json) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const issue = text(record.issue, 40)
  if (!issue) return null
  const pageRecord =
    record.page &&
    typeof record.page === 'object' &&
    !Array.isArray(record.page)
      ? (record.page as Record<string, unknown>)
      : {}
  const page: ReviewDetail['page'] = {}
  for (const field of REVIEW_FIELDS) {
    const entry = pageRecord[field]
    if (!entry || typeof entry !== 'object') continue
    const { value, match } = entry as Record<string, unknown>
    page[field] = {
      value: text(value, 80),
      match: (REVIEW_MATCHES as readonly unknown[]).includes(match)
        ? (match as ReviewMatch)
        : 'unknown',
    }
  }
  const comparedRecord =
    record.compared &&
    typeof record.compared === 'object' &&
    !Array.isArray(record.compared)
      ? (record.compared as Record<string, unknown>)
      : null
  const compared: NonNullable<ReviewDetail['compared']> = {}
  for (const field of REVIEW_FIELDS) {
    const value = text(comparedRecord?.[field], 100)
    if (value) compared[field] = value
  }
  return {
    issue,
    pagePrice: text(record.pagePrice, 40),
    title: text(record.title, 160),
    page,
    ...(comparedRecord ? { compared } : {}),
  }
}

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/** The knife's side of the comparison. */
export type ReviewKnife = {
  handleMaterial?: string | null
  specs: Partial<Record<Exclude<ReviewField, 'handleMaterial'>, string>>
}

/**
 * Pairs the knife's details with the page's. A detail neither side has is
 * left out; one the knife lacks cannot conflict, so it never differs.
 */
export function buildSourceReview(
  knife: ReviewKnife,
  detail: ReviewDetail | null,
): SourceReview | null {
  if (!detail) return null
  const rows: ComparisonRow[] = []
  for (const field of REVIEW_FIELDS) {
    const yours =
      (field === 'handleMaterial'
        ? knife.handleMaterial
        : knife.specs[field]
      )?.trim() ?? ''
    const page = detail.page[field]?.value ?? null
    if (!yours && !page) continue
    // Older reviews did not keep what AI compared against: trust the match.
    const changed = Boolean(
      detail.compared && !same(detail.compared[field] ?? '', yours),
    )
    const match =
      yours && page && !changed
        ? (detail.page[field]?.match ?? 'unknown')
        : 'unknown'
    rows.push({
      field,
      label: REVIEW_FIELD_LABEL[field],
      yours,
      page,
      match,
      ...(changed ? { changed } : {}),
    })
  }
  return {
    issue: detail.issue,
    version: isVersionIssue(detail.issue),
    pagePrice: detail.pagePrice,
    title: detail.title,
    rows,
  }
}

/** Reads the knife's side from SQLite's knives row (specs JSON). */
export function reviewKnifeFromRow(row: {
  specs: string | null
  handle_material: string | null
}): ReviewKnife {
  let specs: ReviewKnife['specs'] = {}
  try {
    const parsed = JSON.parse(row.specs ?? '{}') as Record<string, unknown>
    for (const field of REVIEW_FIELDS) {
      if (field === 'handleMaterial') continue
      const value = parsed[field]
      if (typeof value === 'string') specs = { ...specs, [field]: value }
    }
  } catch {
    // A broken specs column: compare without the knife's details.
  }
  return { handleMaterial: row.handle_material, specs }
}
