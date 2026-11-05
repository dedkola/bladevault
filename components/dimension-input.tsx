'use client'

import { useId, useState } from 'react'
import { Input } from '@/components/ui/input'
import { dimensionInputValue, splitDimension } from '@/lib/measurements'
import type { DimensionUnit } from '@/lib/settings-shared'

export function DimensionInput({
  label,
  value,
  onChange,
  dimensionUnit = 'in',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  dimensionUnit?: DimensionUnit
}) {
  const id = useId()
  // Keep an unfinished decimal/fraction editable without rounding the source.
  const [editing, setEditing] = useState<{
    unit: 'in' | 'mm'
    input: string
    source: string
  }>()
  const values = splitDimension(value)
  const units: Array<'in' | 'mm'> =
    dimensionUnit === 'both' ? ['mm', 'in'] : [dimensionUnit]
  const unreadable =
    Boolean(value.trim()) && !values.inches && !values.millimeters

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
                : unit === 'in'
                  ? values.inches
                  : values.millimeters
          return (
            <div key={unit} className="min-w-0 space-y-1">
              <label
                htmlFor={inputId}
                className="text-xs text-muted-foreground"
              >
                {unit === 'mm' ? 'Millimeters (mm)' : 'Inches (in)'}
              </label>
              <Input
                id={inputId}
                aria-label={`${label} (${unit})`}
                value={inputValue}
                onChange={(event) => {
                  const input = event.target.value
                  const source = dimensionInputValue(input, unit)
                  setEditing({ unit, input, source })
                  onChange(source)
                }}
                onBlur={() => setEditing(undefined)}
                placeholder={unit === 'mm' ? 'e.g. 88.9' : 'e.g. 3.5'}
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
