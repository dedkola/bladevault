import {
  getKnifeImageCount,
  type Knife,
  type KnifeActivityEvent,
  type MaintenanceEvent,
  type MaintenanceType,
} from '@/lib/data'
import { countImportantFields } from '@/lib/collection-stats'
import {
  parseLengthToInches,
  parseLengthToMillimeters,
  parseWeightToGrams,
} from '@/lib/measurement-parser'
import { parsePrice } from '@/lib/lumen-collection'

/**
 * Everything the achievement checks read, gathered by the caller. Only
 * `knives` and `now` are required; a missing source simply leaves its
 * achievements at zero progress.
 */
export type AchievementInput = {
  /** Full knife records (sold ones included); list summaries may pass `imageCount`. */
  knives: ReadonlyArray<Knife & { imageCount?: number }>
  activity?: ReadonlyArray<KnifeActivityEvent>
  maintenance?: ReadonlyArray<
    Pick<MaintenanceEvent, 'knifeId' | 'type' | 'occurredAt'>
  >
  noteCount?: number
  comparisons?: ReadonlyArray<{ knifeIds: readonly string[] }>
  /** Open care reminders in the Inbox; null when reminders are unavailable. */
  openCareReminders?: number | null
  /** Care reminders resolved or dismissed so far. */
  clearedCareReminders?: number
  /** Null or missing when price monitoring is off: market badges are unavailable. */
  priceMonitoring?: {
    watchedKnives: number
    /** Size of each caught price drop in percent (sign is ignored). */
    dropPercents: readonly number[]
    backInStock: number
  } | null
  now: Date
}

export type AchievementSnapshot = ReturnType<typeof buildAchievementSnapshot>

const EMPTY_LABELS = new Set(['', 'unknown', 'na', 'none', 'notspecified'])

/** Lowercase letters and digits only, so "CPM-MagnaCut" and "cpm magnacut" match. */
export function labelKey(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function steelKey(value: string | undefined): string {
  return labelKey(value).replace(/^cpm/, '')
}

const SUPER_STEELS = [
  'm390',
  'm398',
  '20cv',
  '204p',
  's90v',
  's110v',
  's125v',
  'magnacut',
  'k390',
  'maxamet',
  'rex121',
  'zdp189',
]
const CARBON_STEELS = [
  '1095',
  '1084',
  '5160',
  '52100',
  '80crv2',
  'o1',
  'a2',
  'w2',
]
const BUDGET_STEELS = [
  '8cr13mov',
  '8cr14mov',
  '7cr17mov',
  'aus8',
  '440a',
  '420hc',
]

type Continent = 'NA' | 'SA' | 'EU' | 'AS' | 'AF' | 'OC'

/** Country aliases (letters only) by canonical key, with their continent. */
const COUNTRIES: Record<string, [Continent, ...string[]]> = {
  usa: ['NA', 'usa', 'us', 'unitedstates', 'unitedstatesofamerica', 'america'],
  canada: ['NA', 'canada'],
  mexico: ['NA', 'mexico'],
  brazil: ['SA', 'brazil', 'brasil'],
  argentina: ['SA', 'argentina'],
  chile: ['SA', 'chile'],
  colombia: ['SA', 'colombia'],
  uk: [
    'EU',
    'uk',
    'unitedkingdom',
    'greatbritain',
    'england',
    'scotland',
    'wales',
  ],
  germany: ['EU', 'germany', 'deutschland'],
  italy: ['EU', 'italy', 'italia'],
  spain: ['EU', 'spain', 'espana'],
  france: ['EU', 'france'],
  sweden: ['EU', 'sweden'],
  finland: ['EU', 'finland'],
  norway: ['EU', 'norway'],
  denmark: ['EU', 'denmark'],
  switzerland: ['EU', 'switzerland'],
  austria: ['EU', 'austria'],
  czechia: ['EU', 'czechia', 'czechrepublic', 'czech'],
  poland: ['EU', 'poland'],
  portugal: ['EU', 'portugal'],
  netherlands: ['EU', 'netherlands', 'holland'],
  belgium: ['EU', 'belgium'],
  ireland: ['EU', 'ireland'],
  greece: ['EU', 'greece'],
  serbia: ['EU', 'serbia'],
  slovakia: ['EU', 'slovakia'],
  slovenia: ['EU', 'slovenia'],
  croatia: ['EU', 'croatia'],
  estonia: ['EU', 'estonia'],
  latvia: ['EU', 'latvia'],
  lithuania: ['EU', 'lithuania'],
  ukraine: ['EU', 'ukraine'],
  russia: ['EU', 'russia'],
  bulgaria: ['EU', 'bulgaria'],
  romania: ['EU', 'romania'],
  hungary: ['EU', 'hungary'],
  china: ['AS', 'china', 'prc'],
  taiwan: ['AS', 'taiwan'],
  japan: ['AS', 'japan'],
  southkorea: ['AS', 'southkorea', 'korea'],
  india: ['AS', 'india'],
  pakistan: ['AS', 'pakistan'],
  nepal: ['AS', 'nepal'],
  vietnam: ['AS', 'vietnam'],
  thailand: ['AS', 'thailand'],
  philippines: ['AS', 'philippines'],
  indonesia: ['AS', 'indonesia'],
  israel: ['AS', 'israel'],
  turkey: ['AS', 'turkey', 'turkiye'],
  hongkong: ['AS', 'hongkong'],
  australia: ['OC', 'australia'],
  newzealand: ['OC', 'newzealand'],
  southafrica: ['AF', 'southafrica'],
  namibia: ['AF', 'namibia'],
  kenya: ['AF', 'kenya'],
}

const COUNTRY_ALIASES = new Map<string, { key: string; continent: Continent }>(
  Object.entries(COUNTRIES).flatMap(([key, [continent, ...aliases]]) =>
    aliases.map((alias) => [alias, { key, continent }] as const),
  ),
)

/** Canonical country and continent for values like "Made in USA" or "Seki, Japan". */
export function resolveCountry(
  value: string | undefined,
): { key: string; continent?: Continent } | undefined {
  const letters = (value ?? '').toLowerCase().replace(/[^a-z]/g, '')
  const text = letters.replace(/^madein/, '')
  if (EMPTY_LABELS.has(text)) return undefined
  const exact = COUNTRY_ALIASES.get(text)
  if (exact) return exact
  // Longer aliases may sit inside a place name ("sekijapan", "solingengermany").
  for (const [alias, country] of COUNTRY_ALIASES) {
    if (alias.length >= 5 && text.includes(alias)) return country
  }
  return { key: text }
}

const DAY_MS = 86_400_000
const SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD'])

/** Local calendar day, e.g. "2026-03-09". */
export function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Longest run of consecutive local days in the set. */
export function longestDayStreak(days: ReadonlySet<string>): number {
  let best = 0
  for (const day of days) {
    const [year, month, date] = day.split('-').map(Number)
    // Only start counting at the first day of a run.
    if (days.has(localDayKey(new Date(year, month - 1, date - 1)))) continue
    let length = 1
    while (days.has(localDayKey(new Date(year, month - 1, date + length)))) {
      length += 1
    }
    best = Math.max(best, length)
  }
  return best
}

function tally(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

function maxCount(counts: Map<string, number>): number {
  return Math.max(0, ...counts.values())
}

function presentKeys(values: Iterable<string | undefined>, key = labelKey) {
  return [...values].map(key).filter((value) => !EMPTY_LABELS.has(value))
}

function percentOf(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.floor((part / whole) * 100)
}

function validDate(value: string): Date | undefined {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * Aggregates the input once so each achievement check is a cheap lookup.
 * Collection badges count knives still owned; habit badges (when knives were
 * added) and rotation badges also include sold knives.
 */
export function buildAchievementSnapshot(input: AchievementInput) {
  const all = input.knives
  const owned = all.filter((knife) => !knife.sold)
  const maintenance = input.maintenance ?? []

  const brands = tally(presentKeys(owned.map((knife) => knife.brand)))
  const designers = tally(presentKeys(owned.map((k) => k.specs.designer)))
  const steels = presentKeys(
    owned.map((knife) => knife.specs.bladeMaterial),
    steelKey,
  )
  const handles = presentKeys(owned.map((knife) => knife.handleMaterial))
  const styles = presentKeys(owned.map((knife) => knife.bladeStyle))
  const locks = presentKeys(owned.map((k) => k.specs.lockingMechanism))

  const countries = owned
    .map((knife) => resolveCountry(knife.specs.country))
    .filter((country) => country !== undefined)

  const bladeInches = owned.map((k) => parseLengthToInches(k.specs.bladeLength))
  const overallInches = owned.map((k) =>
    parseLengthToInches(k.specs.overallLength),
  )
  const thicknessMm = owned.map((k) =>
    k.specs.bladeThickness
      ? parseLengthToMillimeters(k.specs.bladeThickness)
      : undefined,
  )
  const grams = owned.map((k) => parseWeightToGrams(k.specs.weight))
  const known = (values: Array<number | undefined>) =>
    values.filter((value): value is number => value !== undefined && value > 0)

  const prices = owned
    .map((knife) => parsePrice(knife.specs.price))
    .filter(
      (price) =>
        price !== null &&
        price.amount > 0 &&
        SUPPORTED_CURRENCIES.has(price.currency),
    )
    .map((price) => price!)
  const valueByCurrency = new Map<string, number>()
  for (const price of prices) {
    valueByCurrency.set(
      price.currency,
      (valueByCurrency.get(price.currency) ?? 0) + price.amount,
    )
  }

  let fullySpecced = 0
  let filledFields = 0
  let totalFields = 0
  for (const knife of owned) {
    const { filled, total } = countImportantFields(knife)
    if (filled === total) fullySpecced += 1
    filledFields += filled
    totalFields += total
  }

  const customFieldUse = tally(
    owned.flatMap((knife) =>
      Object.entries(knife.customFields)
        .filter(([, value]) => value?.trim())
        .map(([key]) => key),
    ),
  )

  const careByType = tally(maintenance.map((event) => event.type))
  const careDays = new Set<string>()
  const careKnives = new Set<string>()
  const careDayTypes = new Map<string, Set<MaintenanceType>>()
  for (const event of maintenance) {
    const date = validDate(event.occurredAt)
    if (!date) continue
    const day = localDayKey(date)
    careDays.add(day)
    careKnives.add(event.knifeId)
    const key = `${event.knifeId}|${day}`
    const types = careDayTypes.get(key) ?? new Set<MaintenanceType>()
    types.add(event.type)
    careDayTypes.set(key, types)
  }

  const added = all
    .map((knife) => validDate(knife.addedAt))
    .filter((date) => date !== undefined)
  const addedPerDay = tally(added.map(localDayKey))
  const activeDays = new Set<string>([...careDays, ...addedPerDay.keys()])
  for (const event of input.activity ?? []) {
    const date = validDate(event.occurredAt)
    if (date) activeDays.add(localDayKey(date))
  }
  const firstAdded = Math.min(...added.map((date) => date.getTime()))

  const comparisons = input.comparisons ?? []
  const price = input.priceMonitoring ?? null

  return {
    ownedCount: owned.length,
    soldCount: all.length - owned.length,
    pinnedCount: owned.filter((knife) => knife.pinned).length,

    brandCount: brands.size,
    maxPerBrand: maxCount(brands),
    designerCount: designers.size,
    maxPerDesigner: maxCount(designers),

    steelCount: new Set(steels).size,
    superSteelCount: steels.filter((s) =>
      SUPER_STEELS.some((t) => s.includes(t)),
    ).length,
    magnaCutCount: steels.filter((s) => s.includes('magnacut')).length,
    damascusCount: owned.filter((knife) =>
      /damascus|damasteel/i.test(knife.specs.bladeMaterial ?? ''),
    ).length,
    carbonSteelCount: steels.filter((s) => CARBON_STEELS.includes(s)).length,
    budgetSteelCount: steels.filter((s) =>
      BUDGET_STEELS.some((t) => s.includes(t)),
    ).length,

    handleCount: new Set(handles).size,
    carbonFiberCount: handles.filter((h) => /carbonfib/.test(h)).length,
    titaniumCount: owned.filter((knife) =>
      /\b(titanium|ti)\b/i.test(knife.handleMaterial),
    ).length,
    naturalHandleCount: handles.filter((h) =>
      /wood|bone|stag|micarta|horn|antler|ebony/.test(h),
    ).length,
    plasticHandleCount: handles.filter((h) =>
      /frn|zytel|grn|grivory|nylon|polymer/.test(h),
    ).length,

    styleCount: new Set(styles).size,
    tantoCount: styles.filter((s) => s.includes('tanto')).length,
    straightEdgeCount: styles.filter((s) => /wharncliffe|sheepsfoot/.test(s))
      .length,
    lockCount: new Set(locks).size,
    frameLockCount: locks.filter((l) => /framelock|integrallock/.test(l))
      .length,
    slipJointCount: locks.filter((l) => /slipjoint|nonlocking|friction/.test(l))
      .length,

    lightestGrams: Math.min(Infinity, ...known(grams)),
    heaviestGrams: Math.max(0, ...known(grams)),
    totalGrams: known(grams).reduce((sum, value) => sum + value, 0),
    shortestBladeInches: Math.min(Infinity, ...known(bladeInches)),
    longestBladeInches: Math.max(0, ...known(bladeInches)),
    longestOverallInches: Math.max(0, ...known(overallInches)),
    thickestMm: Math.max(0, ...known(thicknessMm)),
    thinnestMm: Math.min(Infinity, ...known(thicknessMm)),
    totalBladeCm:
      known(bladeInches).reduce((sum, value) => sum + value, 0) * 2.54,

    countryCount: new Set(countries.map((country) => country.key)).size,
    continentCount: new Set(
      countries.map((country) => country.continent).filter(Boolean),
    ).size,
    hasJapan: countries.some((country) => country.key === 'japan'),

    fullySpeccedCount: fullySpecced,
    completenessPercent: percentOf(filledFields, totalFields),
    maxPhotos: Math.max(0, ...owned.map((knife) => getKnifeImageCount(knife))),
    totalPhotos: owned.reduce(
      (sum, knife) => sum + getKnifeImageCount(knife),
      0,
    ),
    photographedPercent: percentOf(
      owned.filter((knife) => getKnifeImageCount(knife) > 0).length,
      owned.length,
    ),
    longestDescription: Math.max(
      0,
      ...owned.map((knife) => knife.description?.trim().length ?? 0),
    ),
    noteCount: input.noteCount ?? 0,
    maxCustomFieldUse: maxCount(customFieldUse),
    sourcedCount: owned.filter((knife) => knife.sourceUrl?.trim()).length,

    careCount: maintenance.length,
    careOf: (type: MaintenanceType) => careByType.get(type) ?? 0,
    careStreak: longestDayStreak(careDays),
    sameDayRebuilds: [...careDayTypes.values()].filter(
      (types) => types.has('disassembly') && types.has('reassembly'),
    ).length,
    caredForPercent: percentOf(
      owned.filter((knife) => careKnives.has(knife.id)).length,
      owned.length,
    ),
    openCareReminders: input.openCareReminders ?? null,
    clearedCareReminders: input.clearedCareReminders ?? 0,

    maxAddedInDay: maxCount(addedPerDay),
    addedMonths: new Set(added.map((date) => localDayKey(date).slice(0, 7)))
      .size,
    vaultYears: Number.isFinite(firstAdded)
      ? Math.floor((input.now.getTime() - firstAdded) / (365.25 * DAY_MS))
      : 0,
    nightOwlAdds: added.filter((date) => date.getHours() < 4).length,
    weekendAdds: added.filter((date) => date.getDay() % 6 === 0).length,
    activityStreak: longestDayStreak(activeDays),
    christmasAdds: added.filter(
      (date) => date.getMonth() === 11 && date.getDate() === 25,
    ).length,
    fridayThirteenthAdds: added.filter(
      (date) => date.getDay() === 5 && date.getDate() === 13,
    ).length,

    priceMonitoring: price !== null,
    watchedKnives: price?.watchedKnives ?? 0,
    dropCount: price?.dropPercents.length ?? 0,
    biggestDropPercent: Math.max(
      0,
      ...(price?.dropPercents ?? []).map((value) => Math.abs(value)),
    ),
    backInStock: price?.backInStock ?? 0,
    collectionValue: Math.max(0, ...valueByCurrency.values()),
    mostExpensive: Math.max(0, ...prices.map((p) => p.amount)),
    cheapest: Math.min(Infinity, ...prices.map((p) => p.amount)),

    largestComparison: Math.max(
      0,
      ...comparisons.map((list) => list.knifeIds.length),
    ),
    comparisonCount: comparisons.length,
  }
}
