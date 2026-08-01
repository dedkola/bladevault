import { describe, expect, it } from 'vitest'
import {
  createBulkKnifeUpdates,
  getBulkEditFieldValue,
  getCustomBulkEditFieldId,
  isBuiltInBulkEditFieldKey,
} from '@/lib/bulk-edit'
import { createKnife } from '@/tests/fixtures/knife'

describe('bulk edit helpers', () => {
  it('maps built-in, spec, and custom fields to partial updates', () => {
    expect(createBulkKnifeUpdates('brand', 'Spyderco')).toEqual({
      brand: 'Spyderco',
    })
    expect(createBulkKnifeUpdates('specs.country', 'Japan')).toEqual({
      specs: { country: 'Japan' },
    })
    expect(createBulkKnifeUpdates('customFields.box', 'Yes')).toEqual({
      customFields: { box: 'Yes' },
    })
  })

  it('reads values from every supported field shape', () => {
    const knife = createKnife({ customFields: { box: 'Yes' } })
    expect(getBulkEditFieldValue(knife, 'brand')).toBe('Benchmade')
    expect(getBulkEditFieldValue(knife, 'specs.country')).toBe('USA')
    expect(getBulkEditFieldValue(knife, 'customFields.box')).toBe('Yes')
  })

  it('validates field identifiers', () => {
    expect(isBuiltInBulkEditFieldKey('specs.price')).toBe(true)
    expect(isBuiltInBulkEditFieldKey('name')).toBe(false)
    expect(getCustomBulkEditFieldId('customFields.box')).toBe('box')
    expect(getCustomBulkEditFieldId('customFields.')).toBeNull()
  })
})
