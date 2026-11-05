'use client'

import { useId, useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  dimensionInputValue,
  splitDimension,
  splitWeight,
} from '@/lib/measurements'
import type { DimensionUnit } from '@/lib/settings-shared'

type InputUnit = 'in' | 'mm' | 'g' | 'oz'
const UNIT_LABELS: Record<InputUnit, string> = {
  in: 'Inches (in)',
  mm: 'Millimeters (mm)',
  g: 'Grams (g)',
  oz: 'Ounces (oz)',
}
const UNIT_EXAMPLES: Record<InputUnit, string> = {
  in: 'e.g. 3.5',
  mm: 'e.g. 88.9',
  g: 'e.g. 85.05',
  oz: 'e.g. 3',
}

export function DimensionInput({
  label,
  value,
  onChange,
  dimensionUnit = 'in',
  kind = 'length',
  list,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  dimensionUnit?: DimensionUnit
  kind?: 'length' | 'weight'
  list?: string
}) {
  const id = useId()
  // Keep an unfinished decimal/fraction editable without rounding the source.
  const [editing, setEditing] = useState<{
    unit: InputUnit
    input: string
    source: string
  }>()
  const length = kind === 'length' ? splitDimension(value) : undefined
  const weight = kind === 'weight' ? splitWeight(value) : undefined
  const values: Record<InputUnit, string> = {
    in: length?.inches ?? '',
    mm: length?.millimeters ?? '',
    g: weight?.grams ?? '',
    oz: weight?.ounces ?? '',
  }
  const metricUnit = kind === 'weight' ? 'g' : 'mm'
  const imperialUnit = kind === 'weight' ? 'oz' : 'in'
  const units: InputUnit[] =
    dimensionUnit === 'both'
      ? [metricUnit, imperialUnit]
      : [dimensionUnit === 'mm' ? metricUnit : imperialUnit]
  const unreadable =
    Boolean(value.trim()) && !values[metricUnit] && !values[imperialUnit]

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-[10px] xl:text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </legend>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2">
        {units.map((unit, index) => {
          const inputId = `${id}-${unit}`
          const inputValue =
            editing?.unit === unit && editing.source === value
              ? editing.input
              : unreadable && index === 0 && editing?.source !== value
                ? value
                : values[unit]
          return (
            <div key={unit} className="min-w-0 space-y-1">
              <label
                htmlFor={inputId}
                className="text-xs text-muted-foreground"
              >
                {UNIT_LABELS[unit]}
              </label>
              <Input
                id={inputId}
                list={list}
                aria-label={`${label} (${unit})`}
                value={inputValue}
                onChange={(event) => {
                  const input = event.target.value
                  const source = dimensionInputValue(input, unit)
                  setEditing({ unit, input, source })
                  onChange(source)
                }}
                onBlur={() => setEditing(undefined)}
                placeholder={UNIT_EXAMPLES[unit]}
                className="bg-background/80"
              />
            </div>
          )
        })}
      </div>
      {unreadable && (
        <p className="text-xs text-muted-foreground">
          This value could not be converted. Enter a number to calculate both
          units.
        </p>
      )}
    </fieldset>
  )
}
