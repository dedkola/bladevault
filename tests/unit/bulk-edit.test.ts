import { describe, expect, it } from 'vitest'
import {
  builtInBulkEditFields,
  createBulkKnifeUpdates,
  getBulkEditFieldValue,
  getCustomBulkEditFieldId,
  isBuiltInBulkEditFieldKey,
} from '@/lib/bulk-edit'
import { createKnife } from '@/tests/fixtures/knife'

describe('bulk edit helpers', () => {
  it('offers model name as a built-in field', () => {
    expect(builtInBulkEditFields).toContainEqual({
      key: 'name',
      label: 'Model Name',
      type: 'text',
    })
  })

  it('maps built-in, spec, and custom fields to partial updates', () => {
    expect(createBulkKnifeUpdates('name', 'Para 3')).toEqual({
      name: 'Para 3',
    })
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
    expect(getBulkEditFieldValue(knife, 'name')).toBe('Bugout')
    expect(getBulkEditFieldValue(knife, 'brand')).toBe('Benchmade')
    expect(getBulkEditFieldValue(knife, 'specs.country')).toBe('USA')
    expect(getBulkEditFieldValue(knife, 'customFields.box')).toBe('Yes')
  })

  it('validates field identifiers', () => {
    expect(isBuiltInBulkEditFieldKey('specs.price')).toBe(true)
    expect(isBuiltInBulkEditFieldKey('name')).toBe(true)
    expect(isBuiltInBulkEditFieldKey('description')).toBe(false)
    expect(getCustomBulkEditFieldId('customFields.box')).toBe('box')
    expect(getCustomBulkEditFieldId('customFields.')).toBeNull()
  })
})
