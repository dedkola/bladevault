// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DimensionInput } from '@/components/dimension-input'
import type { DimensionUnit } from '@/lib/settings-shared'

afterEach(cleanup)

function Editor({
  initial = '',
  unit = 'both',
  kind = 'length',
}: {
  initial?: string
  unit?: DimensionUnit
  kind?: 'length' | 'weight'
}) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <DimensionInput
        label={kind === 'weight' ? 'Weight' : 'Blade Length'}
        value={value}
        onChange={setValue}
        dimensionUnit={unit}
        kind={kind}
      />
      <output aria-label="Stored dimension">{value}</output>
    </>
  )
}

describe('linked dimension inputs', () => {
  it('fills the alternate unit in both directions and clears both together', async () => {
    const user = userEvent.setup()
    render(<Editor />)
    const inches = screen.getByRole('textbox', { name: 'Blade Length (in)' })
    const mm = screen.getByRole('textbox', { name: 'Blade Length (mm)' })
    await user.type(inches, '3.5')
    expect(inches).toHaveValue('3.5')
    expect(mm).toHaveValue('88.9')
    expect(screen.getByLabelText('Stored dimension')).toHaveTextContent(
      '3.5 in',
    )
    await user.clear(mm)
    expect(inches).toHaveValue('')
    await user.type(mm, '101.6')
    expect(inches).toHaveValue('4')
    expect(screen.getByLabelText('Stored dimension')).toHaveTextContent(
      '101.6 mm',
    )
  })

  it('keeps unfinished decimals and fractions editable without rounding the source', async () => {
    const user = userEvent.setup()
    render(<Editor />)
    const inches = screen.getByRole('textbox', { name: 'Blade Length (in)' })
    await user.type(inches, '3.')
    expect(inches).toHaveValue('3.')
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (mm)' }),
    ).toHaveValue('')
    await user.clear(inches)
    await user.type(inches, '0.09000')
    expect(inches).toHaveValue('0.09000')
    expect(screen.getByLabelText('Stored dimension')).toHaveTextContent(
      '0.09000 in',
    )
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (mm)' }),
    ).toHaveValue('2.286')
    await user.clear(inches)
    await user.type(inches, '3 1/2')
    expect(inches).toHaveValue('3 1/2')
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (mm)' }),
    ).toHaveValue('88.9')
  })

  it('separates an imported pair without changing its stored text', () => {
    render(<Editor initial={'3.40" / 86 mm'} />)
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (mm)' }),
    ).toHaveValue('86')
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (in)' }),
    ).toHaveValue('3.4')
    expect(screen.getByLabelText('Stored dimension')).toHaveTextContent(
      '3.40" / 86 mm',
    )
  })

  it('normalizes a pasted unit on blur while retaining its source precision', async () => {
    const user = userEvent.setup()
    render(<Editor />)
    const inches = screen.getByRole('textbox', { name: 'Blade Length (in)' })
    await user.type(inches, '88.900 mm')
    await user.tab()
    expect(inches).toHaveValue('3.5')
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (mm)' }),
    ).toHaveValue('88.9')
    expect(screen.getByLabelText('Stored dimension')).toHaveTextContent(
      '88.900 mm',
    )
  })

  it.each(['in', 'mm'] as const)(
    'shows only the preferred %s field',
    (unit) => {
      render(<Editor initial="88.9 mm" unit={unit} />)
      expect(screen.getAllByRole('textbox')).toHaveLength(1)
      expect(
        screen.getByRole('textbox', { name: `Blade Length (${unit})` }),
      ).toHaveValue(unit === 'in' ? '3.5' : '88.9')
    },
  )

  it('uses a replacement imported value after editing', () => {
    const onChange = () => {}
    const { rerender } = render(
      <DimensionInput
        label="Blade Length"
        value="3 in"
        onChange={onChange}
        dimensionUnit="both"
      />,
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Blade Length (in)' }),
      { target: { value: '4' } },
    )
    rerender(
      <DimensionInput
        label="Blade Length"
        value="127 mm"
        onChange={onChange}
        dimensionUnit="both"
      />,
    )
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (in)' }),
    ).toHaveValue('5')
    expect(
      screen.getByRole('textbox', { name: 'Blade Length (mm)' }),
    ).toHaveValue('127')
  })
})

describe('linked weight inputs', () => {
  it('shows separate imported grams and ounces and keeps the original source', () => {
    render(<Editor initial="5.04oz / 142.8g" kind="weight" />)
    expect(screen.getByRole('textbox', { name: 'Weight (g)' })).toHaveValue(
      '142.8',
    )
    expect(screen.getByRole('textbox', { name: 'Weight (oz)' })).toHaveValue(
      '5.04',
    )
    expect(screen.getByLabelText('Stored dimension')).toHaveTextContent(
      '5.04oz / 142.8g',
    )
  })

  it('calculates in both directions and clears the alternative value', async () => {
    const user = userEvent.setup()
    render(<Editor kind="weight" />)
    const grams = screen.getByRole('textbox', { name: 'Weight (g)' })
    const ounces = screen.getByRole('textbox', { name: 'Weight (oz)' })
    await user.type(ounces, '1')
    expect(grams).toHaveValue('28.35')
    await user.clear(grams)
    expect(ounces).toHaveValue('')
    await user.type(grams, '100')
    expect(ounces).toHaveValue('3.5274')
    expect(screen.getByLabelText('Stored dimension')).toHaveTextContent('100 g')
  })

  it.each(['in', 'mm'] as const)(
    'shows only the weight field for %s mode',
    (unit) => {
      render(<Editor initial="5.04oz / 142.8g" unit={unit} kind="weight" />)
      expect(screen.getAllByRole('textbox')).toHaveLength(1)
      expect(
        screen.getByRole('textbox', {
          name: unit === 'mm' ? 'Weight (g)' : 'Weight (oz)',
        }),
      ).toHaveValue(unit === 'mm' ? '142.8' : '5.04')
    },
  )
})
