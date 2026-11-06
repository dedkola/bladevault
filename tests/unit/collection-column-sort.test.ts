import { describe, expect, it } from 'vitest'
import {
  getCollectionColumns,
  sortKnivesByColumn,
} from '@/lib/collection-columns'
import { createKnife } from '../fixtures/knife'

const columns = getCollectionColumns([
  { id: 'paid', name: 'Paid', type: 'number' },
])
const names = (knives: { name: string }[]) => knives.map((knife) => knife.name)

describe('sortKnivesByColumn', () => {
  it('compares blade lengths numerically across units', () => {
    const knives = [
      createKnife({
        id: 'a',
        name: 'Long',
        specs: { ...createKnife().specs, bladeLength: '100 mm' },
      }),
      createKnife({
        id: 'b',
        name: 'Short',
        specs: { ...createKnife().specs, bladeLength: '2.5 in' },
      }),
      createKnife({
        id: 'c',
        name: 'Mid',
        specs: { ...createKnife().specs, bladeLength: '3.25 in' },
      }),
    ]
    expect(
      names(
        sortKnivesByColumn(knives, { key: 'blade', direction: 'asc' }, columns),
      ),
    ).toEqual(['Short', 'Mid', 'Long'])
    expect(
      names(
        sortKnivesByColumn(
          knives,
          { key: 'blade', direction: 'desc' },
          columns,
        ),
      ),
    ).toEqual(['Long', 'Mid', 'Short'])
  })

  it('keeps empty values last in both directions', () => {
    const knives = [
      createKnife({ id: 'a', name: 'Empty', brand: '' }),
      createKnife({ id: 'b', name: 'Zed', brand: 'Zero Tolerance' }),
      createKnife({ id: 'c', name: 'Ace', brand: 'Benchmade' }),
    ]
    expect(
      names(
        sortKnivesByColumn(knives, { key: 'maker', direction: 'asc' }, columns),
      ),
    ).toEqual(['Ace', 'Zed', 'Empty'])
    expect(
      names(
        sortKnivesByColumn(
          knives,
          { key: 'maker', direction: 'desc' },
          columns,
        ),
      ),
    ).toEqual(['Zed', 'Ace', 'Empty'])
  })

  it('sorts the knife column by name and number custom fields numerically', () => {
    const knives = [
      createKnife({ id: 'a', name: 'b', customFields: { paid: '1,200' } }),
      createKnife({ id: 'b', name: 'A', customFields: { paid: '95' } }),
    ]
    expect(
      names(
        sortKnivesByColumn(knives, { key: 'knife', direction: 'asc' }, columns),
      ),
    ).toEqual(['A', 'b'])
    expect(
      names(
        sortKnivesByColumn(
          knives,
          { key: 'custom:paid', direction: 'desc' },
          columns,
        ),
      ),
    ).toEqual(['b', 'A'])
  })

  it('leaves the order unchanged for unsortable or unknown columns', () => {
    const knives = [
      createKnife({ id: 'a', name: 'Z' }),
      createKnife({ id: 'b', name: 'A' }),
    ]
    expect(
      names(
        sortKnivesByColumn(
          knives,
          { key: 'description', direction: 'asc' },
          columns,
        ),
      ),
    ).toEqual(['Z', 'A'])
    expect(
      names(
        sortKnivesByColumn(
          knives,
          { key: 'custom:gone', direction: 'asc' },
          columns,
        ),
      ),
    ).toEqual(['Z', 'A'])
  })
})
