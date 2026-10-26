import { describe, expect, it } from 'vitest'
import { buildCarryPoints, buildCatalogueSeries } from '@/lib/modern-insights'
import { createKnife } from '@/tests/fixtures/knife'

function datedKnife(id: string, year: number, month: number, day = 1) {
  return createKnife({
    id,
    addedAt: new Date(year, month, day, 12).toISOString(),
  })
}

describe('modern Insights catalogue series', () => {
  it('covers every month from the earliest record for the true all-time range', () => {
    const series = buildCatalogueSeries(
      [
        datedKnife('first', 2024, 0),
        datedKnife('second', 2025, 1),
        datedKnife('third', 2026, 2),
      ],
      'all',
      new Date(2026, 2, 15, 12),
    )

    expect(series.points).toHaveLength(27)
    expect(series.points[0]).toEqual({
      monthKey: '2024-01',
      label: 'Jan 2024',
      added: 1,
      total: 1,
    })
    expect(series.points[12]).toEqual({
      monthKey: '2025-01',
      label: 'Jan 2025',
      added: 0,
      total: 1,
    })
    expect(series.points.at(-1)).toEqual({
      monthKey: '2026-03',
      label: 'Mar 2026',
      added: 1,
      total: 3,
    })
    expect(series).toMatchObject({
      datedCount: 3,
      excludedCount: 0,
      addedInRange: 3,
    })
  })

  it('includes the earlier baseline and excludes invalid and future timestamps', () => {
    const now = new Date(2026, 9, 24, 12)
    const series = buildCatalogueSeries(
      [
        datedKnife('baseline-1', 2024, 0),
        datedKnife('baseline-2', 2026, 3),
        datedKnife('first-in-range', 2026, 4),
        datedKnife('same-month', 2026, 4, 21),
        datedKnife('last', 2026, 9),
        createKnife({ id: 'at-now', addedAt: now.toISOString() }),
        createKnife({ id: 'invalid', addedAt: 'not a date' }),
        createKnife({
          id: 'future-today',
          addedAt: new Date(now.getTime() + 1).toISOString(),
        }),
        datedKnife('future-month', 2026, 10),
      ],
      '6m',
      now,
    )

    expect(series.points.map(({ monthKey }) => monthKey)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ])
    expect(series.points.map(({ added }) => added)).toEqual([2, 0, 0, 0, 0, 2])
    expect(series.points.map(({ total }) => total)).toEqual([4, 4, 4, 4, 4, 6])
    expect(series).toMatchObject({
      datedCount: 6,
      excludedCount: 3,
      addedInRange: 4,
    })
  })

  it('uses exactly twelve calendar months and preserves older records in the total', () => {
    const series = buildCatalogueSeries(
      [
        datedKnife('older', 2025, 9, 31),
        datedKnife('start', 2025, 10),
        datedKnife('new', 2026, 9, 20),
      ],
      '12m',
      new Date(2026, 9, 24, 12),
    )

    expect(series.points).toHaveLength(12)
    expect(series.points[0]).toMatchObject({
      monthKey: '2025-11',
      added: 1,
      total: 2,
    })
    expect(series.points.at(-1)?.total).toBe(3)
    expect(series.addedInRange).toBe(2)
  })

  it('provides a zero point for an empty all-time catalogue', () => {
    const series = buildCatalogueSeries([], 'all', new Date(2026, 9, 24, 12))
    expect(series).toEqual({
      points: [{ monthKey: '2026-10', label: 'Oct 2026', added: 0, total: 0 }],
      datedCount: 0,
      excludedCount: 0,
      addedInRange: 0,
    })
  })
})

describe('modern Insights carry measurements', () => {
  it('normalizes metric and dual-unit measurements and preserves record identity', () => {
    const metric = createKnife({
      id: 'metric',
      name: '<Compact & light>',
      brand: 'Maker',
      specs: {
        ...createKnife().specs,
        bladeLength: '88.9 mm',
        weight: '100 g',
      },
    })
    const dual = createKnife({
      id: 'dual',
      specs: {
        ...createKnife().specs,
        bladeLength: '3 in / 76.2 mm',
        weight: '4.5 oz / 127.5 g',
      },
    })
    const points = buildCarryPoints([metric, dual])

    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({
      id: 'metric',
      name: '<Compact & light>',
      brand: 'Maker',
    })
    expect(points[0].bladeLength).toBeCloseTo(3.5)
    expect(points[0].weight).toBeCloseTo(3.527396195)
    expect(points[1]).toMatchObject({
      id: 'dual',
      bladeLength: 3,
      weight: 4.5,
    })
    expect(metric.specs.bladeLength).toBe('88.9 mm')
    expect(metric.specs.weight).toBe('100 g')
  })

  it.each([
    ['0 in', '2 oz'],
    ['3 in', '0 g'],
    ['-3 in', '2 oz'],
    ['3 in', '-2 oz'],
    ['', '2 oz'],
    ['3 in', ''],
    ['unknown', '2 oz'],
    ['3 in', 'balance'],
    ['1e3 in', '2 oz'],
    ['3 in', 'Infinity oz'],
  ])('excludes an unusable pair: %s, %s', (bladeLength, weight) => {
    const invalid = createKnife({
      specs: { ...createKnife().specs, bladeLength, weight },
    })
    expect(buildCarryPoints([invalid])).toEqual([])
  })

  it('does not turn absent records or measurements into zero-valued points', () => {
    expect(buildCarryPoints([])).toEqual([])
    const invalid = createKnife({
      id: 'unknown',
      specs: { ...createKnife().specs, bladeLength: '', weight: '' },
    })
    const valid = createKnife({ id: 'valid' })
    expect(buildCarryPoints([invalid, valid]).map(({ id }) => id)).toEqual([
      'valid',
    ])
  })
})
