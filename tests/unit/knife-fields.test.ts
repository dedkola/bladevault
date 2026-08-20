import { describe, expect, it } from 'vitest'
import {
  getKnifeFieldDefinitions,
  validateKnifeChanges,
} from '@/lib/knife-fields'
import { createKnife } from '@/tests/fixtures/knife'

describe('MCP knife fields', () => {
  it('maps product vocabulary onto the existing BladeVault model', () => {
    const result = validateKnifeChanges({
      knife: createKnife(),
      customFields: [{ id: 'condition', name: 'Condition', type: 'text' }],
      changes: [
        { field: 'model', value: 'Bugout Mini' },
        { field: 'steel', value: ' CPM-M4 ' },
        { field: 'customFields.condition', value: ' Used ' },
      ],
    })

    expect(result.changes.map(({ field }) => field)).toEqual([
      'name',
      'specs.bladeMaterial',
      'customFields.condition',
    ])
    expect(result.updates).toMatchObject({
      name: 'Bugout Mini',
      specs: { bladeMaterial: 'CPM-M4' },
      customFields: { condition: 'Used' },
    })
  })

  it('keeps identity, timestamps, and undeclared custom fields closed', () => {
    const knife = createKnife()
    expect(() =>
      validateKnifeChanges({
        knife,
        customFields: [],
        changes: [{ field: 'id', value: 'replacement' }],
      }),
    ).toThrow('read-only')
    expect(() =>
      validateKnifeChanges({
        knife,
        customFields: [],
        changes: [{ field: 'customFields.secret', value: 'value' }],
      }),
    ).toThrow('Unsupported field')
    expect(
      getKnifeFieldDefinitions([]).some(({ path }) => path === 'images'),
    ).toBe(false)
  })
})
