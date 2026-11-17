import { describe, expect, it } from 'vitest'
import {
  buildLatestByKnife,
  careBadgeLabel,
  careDueSummary,
  countCareStatuses,
  formatTrackDueLine,
  getCareStatuses,
  getKnifeCareStatus,
  rankCareAttention,
  resolveCareIntervals,
} from '@/lib/maintenance-due'
import {
  DEFAULT_MAINTENANCE_REMINDERS,
  normalizeCareIntervalOverrides,
  normalizeMaintenanceReminders,
  type MaintenanceReminderSettings,
} from '@/lib/settings-shared'
import { collectionQuery, matchesCollection } from '@/lib/smart-collections'
import { buildChipFilterFields } from '@/lib/chip-filter-fields'
import {
  getCollectionColumns,
  sortKnivesByColumn,
} from '@/lib/collection-columns'
import { createKnife } from '@/tests/fixtures/knife'

const now = new Date(2026, 10, 16, 12)
const daysAgo = (days: number) => {
  const date = new Date(now)
  date.setDate(date.getDate() - days)
  return date.toISOString()
}
const settings = (
  patch: Partial<MaintenanceReminderSettings> = {},
): MaintenanceReminderSettings => ({
  ...DEFAULT_MAINTENANCE_REMINDERS,
  intervals: { ...DEFAULT_MAINTENANCE_REMINDERS.intervals },
  ...patch,
})

describe('care status', () => {
  it('classifies each track against its interval and due-soon window', () => {
    const status = getKnifeCareStatus(
      'pm2',
      {
        sharpening: daysAgo(94),
        cleaning: daysAgo(12),
        lubrication: daysAgo(171),
      },
      settings(),
      undefined,
      now,
    )
    const byTrack = Object.fromEntries(
      status.tracks.map((track) => [track.track, track]),
    )
    expect(byTrack.sharpening).toMatchObject({
      daysSince: 94,
      dueInDays: -4,
      level: 'overdue',
    })
    expect(byTrack.cleaning).toMatchObject({ dueInDays: 48, level: 'ok' })
    expect(byTrack.lubrication).toMatchObject({
      dueInDays: 9,
      level: 'due-soon',
    })
    expect(status.level).toBe('overdue')
    expect(status.worst?.track).toBe('sharpening')
    expect(formatTrackDueLine(byTrack.sharpening)).toBe('Overdue by 4 days')
    expect(formatTrackDueLine(byTrack.lubrication)).toBe('Due in 9 days')
    expect(careBadgeLabel(status)).toBe('Sharpen overdue · 4d')
    expect(careDueSummary(status)).toBe('Sharpen · 4d overdue')
  })

  it('treats the deadline day as due soon and the next day as overdue', () => {
    const onDeadline = getKnifeCareStatus(
      'a',
      {
        sharpening: daysAgo(90),
        cleaning: daysAgo(1),
        lubrication: daysAgo(1),
      },
      settings(),
      undefined,
      now,
    )
    expect(onDeadline.level).toBe('due-soon')
    expect(careBadgeLabel(onDeadline)).toBe('Sharpen due today')
    const dayAfter = getKnifeCareStatus(
      'a',
      {
        sharpening: daysAgo(91),
        cleaning: daysAgo(1),
        lubrication: daysAgo(1),
      },
      settings(),
      undefined,
      now,
    )
    expect(dayAfter.level).toBe('overdue')
  })

  it('lets stropping reset the sharpening timer only when enabled', () => {
    const latest = {
      sharpening: daysAgo(120),
      stropping: daysAgo(5),
      cleaning: daysAgo(1),
      lubrication: daysAgo(1),
    }
    expect(
      getKnifeCareStatus('a', latest, settings(), undefined, now).level,
    ).toBe('ok')
    expect(
      getKnifeCareStatus(
        'a',
        latest,
        settings({ stroppingCountsAsSharpening: false }),
        undefined,
        now,
      ).level,
    ).toBe('overdue')
  })

  it('applies per-knife overrides, including switching a track off', () => {
    expect(
      resolveCareIntervals(settings(), { sharpening: 30, lubrication: null }),
    ).toEqual({ sharpening: 30, cleaning: 60, lubrication: null })
    const status = getKnifeCareStatus(
      'a',
      { sharpening: daysAgo(40), cleaning: daysAgo(1) },
      settings(),
      { sharpening: 30, lubrication: null },
      now,
    )
    expect(status.tracks.map((track) => track.track)).toEqual([
      'sharpening',
      'cleaning',
    ])
    expect(status.level).toBe('overdue')
  })

  it('leaves knives without any maintenance out by default', () => {
    const untouched = getKnifeCareStatus('a', {}, settings(), undefined, now)
    expect(untouched.level).toBeNull()
    expect(untouched.hasHistory).toBe(false)
    expect(careBadgeLabel(untouched)).toBeNull()
    // The knife's own page still lists its tracks.
    expect(untouched.tracks.map((track) => track.level)).toEqual([
      'never',
      'never',
      'never',
    ])

    const otherOnly = getKnifeCareStatus(
      'a',
      { disassembly: daysAgo(3) },
      settings(),
      undefined,
      now,
    )
    expect(otherOnly.level).toBe('never')
    expect(careBadgeLabel(otherOnly)).toBe(
      'Not yet sharpened, cleaned or lubed',
    )
  })

  it('names the missing kind of care on knives with history', () => {
    const partial = getKnifeCareStatus(
      'a',
      { sharpening: daysAgo(1), cleaning: daysAgo(1) },
      settings(),
      undefined,
      now,
    )
    expect(partial.level).toBe('never')
    expect(careBadgeLabel(partial)).toBe('Not yet lubed')
    expect(careDueSummary(partial)).toBe('Not yet lubed')
    const dueSoonWins = getKnifeCareStatus(
      'a',
      { sharpening: daysAgo(80), cleaning: daysAgo(1) },
      settings(),
      undefined,
      now,
    )
    expect(dueSoonWins.level).toBe('due-soon')
  })

  it('flags every knife or none, depending on the setting', () => {
    const everyKnife = getKnifeCareStatus(
      'a',
      {},
      settings({ neverLogged: 'all' }),
      undefined,
      now,
    )
    expect(everyKnife.level).toBe('never')
    expect(careBadgeLabel(everyKnife)).toBe('No care logged')

    const off = settings({ neverLogged: 'off' })
    expect(
      getKnifeCareStatus('a', { cleaning: daysAgo(1) }, off, undefined, now)
        .level,
    ).toBe('ok')
    expect(getKnifeCareStatus('a', {}, off, undefined, now).level).toBeNull()
  })

  it('ignores future and invalid dates', () => {
    const status = getKnifeCareStatus(
      'a',
      { sharpening: daysAgo(-3), cleaning: 'invalid' },
      settings(),
      undefined,
      now,
    )
    expect(status.tracks.every((track) => track.level === 'never')).toBe(true)
    expect(status.level).toBeNull()
  })

  it('skips sold knives and everything when reminders are off', () => {
    const knives = [{ id: 'kept' }, { id: 'sold', sold: true }]
    const latest = buildLatestByKnife([
      { knifeId: 'kept', type: 'sharpening', lastAt: daysAgo(100) },
      { knifeId: 'kept', type: 'sharpening', lastAt: daysAgo(200) },
    ])
    expect(latest.get('kept')?.sharpening).toBe(daysAgo(100))
    const statuses = getCareStatuses(knives, latest, settings(), {}, now)
    expect([...statuses.keys()]).toEqual(['kept'])
    expect(
      getCareStatuses(
        knives,
        latest,
        settings({ skipSoldKnives: false }),
        {},
        now,
      ).size,
    ).toBe(2)
    expect(
      getCareStatuses(knives, latest, settings({ enabled: false }), {}, now)
        .size,
    ).toBe(0)
  })

  it('counts statuses and ranks the most urgent knives first', () => {
    const latest = buildLatestByKnife([
      { knifeId: 'late', type: 'sharpening', lastAt: daysAgo(120) },
      { knifeId: 'later', type: 'sharpening', lastAt: daysAgo(150) },
      { knifeId: 'soon', type: 'sharpening', lastAt: daysAgo(85) },
      { knifeId: 'fine', type: 'sharpening', lastAt: daysAgo(1) },
    ])
    const onlySharpening = settings({
      intervals: { sharpening: 90, cleaning: null, lubrication: null },
    })
    const statuses = getCareStatuses(
      ['late', 'later', 'soon', 'fine', 'none'].map((id) => ({ id })),
      latest,
      onlySharpening,
      {},
      now,
    )
    // 'none' has no maintenance at all, so it is not counted.
    expect(countCareStatuses(statuses)).toEqual({
      ok: 1,
      'due-soon': 1,
      overdue: 2,
      never: 0,
    })
    expect(rankCareAttention(statuses).map((status) => status.knifeId)).toEqual(
      ['later', 'late', 'soon'],
    )
  })
})

describe('care settings normalization', () => {
  it('fills defaults and rejects out-of-range values', () => {
    expect(normalizeMaintenanceReminders(undefined)).toEqual(
      DEFAULT_MAINTENANCE_REMINDERS,
    )
    expect(
      normalizeMaintenanceReminders({
        enabled: false,
        intervals: { sharpening: 0, cleaning: null, lubrication: 45.4 },
        dueSoonDays: -1,
        skipSoldKnives: 'yes',
        neverLogged: 'sometimes',
      }),
    ).toEqual({
      ...DEFAULT_MAINTENANCE_REMINDERS,
      enabled: false,
      intervals: { sharpening: 90, cleaning: null, lubrication: 45 },
    })
    expect(DEFAULT_MAINTENANCE_REMINDERS.neverLogged).toBe('tracked')
    expect(
      normalizeMaintenanceReminders({ neverLogged: 'all' }).neverLogged,
    ).toBe('all')
  })

  it('keeps only valid per-knife overrides', () => {
    expect(
      normalizeCareIntervalOverrides({
        a: { sharpening: 30, cleaning: null, bogus: 4 },
        b: { sharpening: -2 },
        c: 'nope',
      }),
    ).toEqual({ a: { sharpening: 30, cleaning: null } })
    expect(normalizeCareIntervalOverrides([])).toEqual({})
  })
})

describe('care filter', () => {
  const overdue = createKnife({ id: 'overdue' })
  const fine = createKnife({ id: 'fine' })
  const statuses = getCareStatuses(
    [overdue, fine],
    buildLatestByKnife([
      { knifeId: 'overdue', type: 'sharpening', lastAt: daysAgo(200) },
      { knifeId: 'fine', type: 'sharpening', lastAt: daysAgo(1) },
      { knifeId: 'fine', type: 'cleaning', lastAt: daysAgo(1) },
      { knifeId: 'fine', type: 'lubrication', lastAt: daysAgo(1) },
    ]),
    settings(),
    {},
    now,
  )

  it('matches knives by care status and survives Smart Collection saving', () => {
    const params = new URLSearchParams('care=overdue')
    expect(collectionQuery(params)).toBe('care=overdue')
    expect(matchesCollection(overdue, params, statuses)).toBe(true)
    expect(matchesCollection(fine, params, statuses)).toBe(false)
    expect(
      matchesCollection(fine, new URLSearchParams('care=ok'), statuses),
    ).toBe(true)
  })

  it('is ignored when care status is unavailable', () => {
    expect(matchesCollection(fine, new URLSearchParams('care=overdue'))).toBe(
      true,
    )
  })

  it('adds a Care chip field with status counts', () => {
    const fields = buildChipFilterFields([overdue, fine], [], statuses)
    const care = fields.find((field) => field.key === 'care')
    expect(care?.options.map((option) => [option.value, option.count])).toEqual(
      [
        ['overdue', 1],
        ['due-soon', 0],
        ['never', 0],
        ['ok', 1],
      ],
    )
    expect(
      buildChipFilterFields([overdue], []).some(
        (field) => field.key === 'care',
      ),
    ).toBe(false)
  })
})

describe('care table column', () => {
  it('is offered only with care status and sorts the most urgent first', () => {
    const late = createKnife({ id: 'late', name: 'Late' })
    const later = createKnife({ id: 'later', name: 'Later' })
    const fine = createKnife({ id: 'fine', name: 'Fine' })
    const untracked = createKnife({ id: 'untracked', name: 'Untracked' })
    const statuses = getCareStatuses(
      [late, later, fine],
      buildLatestByKnife([
        { knifeId: 'late', type: 'sharpening', lastAt: daysAgo(100) },
        { knifeId: 'later', type: 'sharpening', lastAt: daysAgo(130) },
        { knifeId: 'fine', type: 'sharpening', lastAt: daysAgo(1) },
      ]),
      settings({
        intervals: { sharpening: 90, cleaning: null, lubrication: null },
      }),
      {},
      now,
    )
    expect(
      getCollectionColumns([]).some((column) => column.key === 'care'),
    ).toBe(false)
    const columns = getCollectionColumns([], 'in', statuses)
    const care = columns.find((column) => column.key === 'care')
    expect(care?.getValue(later)).toBe('Sharpen · 40d overdue')
    expect(care?.getValue(untracked)).toBe('')
    expect(
      sortKnivesByColumn(
        [fine, untracked, late, later],
        { key: 'care', direction: 'asc' },
        columns,
      ).map((knife) => knife.id),
    ).toEqual(['later', 'late', 'fine', 'untracked'])
  })
})
