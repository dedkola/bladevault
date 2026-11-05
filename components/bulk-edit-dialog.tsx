'use client'

import { useMemo, useState } from 'react'
import type { Knife } from '@/lib/data'
import { useKnives } from '@/components/providers/knives-provider'
import { DimensionInput } from '@/components/dimension-input'
import { formatDimension, formatWeight } from '@/lib/measurements'
import {
  type BulkEditFieldDefinition,
  type BulkEditFieldKey,
  getBulkEditFieldValue,
} from '@/lib/bulk-edit'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type BulkEditDialogProps = {
  open: boolean
  selectedKnives: Knife[]
  allKnives: Knife[]
  fields: BulkEditFieldDefinition[]
  onOpenChange: (open: boolean) => void
  onApply: (field: BulkEditFieldKey, value: string) => Promise<void>
}

export function BulkEditDialog({
  open,
  selectedKnives,
  allKnives,
  fields,
  onOpenChange,
  onApply,
}: BulkEditDialogProps) {
  const { dimensionUnit = 'in' } = useKnives()
  const [fieldKey, setFieldKey] = useState<BulkEditFieldKey | ''>('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const resetForm = () => {
    setFieldKey('')
    setValue('')
    setError(null)
    setIsSaving(false)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (isSaving) return
      resetForm()
    }
    onOpenChange(nextOpen)
  }

  const selectedField = fields.find((field) => field.key === fieldKey)
  const measurementKind =
    fieldKey === 'specs.weight'
      ? 'weight'
      : [
            'specs.overallLength',
            'specs.bladeLength',
            'specs.bladeThickness',
            'specs.handleLength',
          ].includes(fieldKey)
        ? 'length'
        : undefined
  const formatCurrentValue = (currentValue: string) =>
    measurementKind === 'weight'
      ? formatWeight(currentValue, dimensionUnit)
      : measurementKind === 'length'
        ? formatDimension(currentValue, dimensionUnit)
        : currentValue
  const currentValueSummary = useMemo(() => {
    if (!fieldKey) return []

    const counts = new Map<string, number>()
    for (const knife of selectedKnives) {
      const currentValue = getBulkEditFieldValue(knife, fieldKey).trim()
      const label = currentValue || 'Not set'
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }

    return Array.from(counts.entries()).sort((left, right) => {
      if (left[0] === 'Not set') return -1
      if (right[0] === 'Not set') return 1
      return right[1] - left[1] || left[0].localeCompare(right[0])
    })
  }, [fieldKey, selectedKnives])

  const suggestions = useMemo(() => {
    if (!fieldKey) return []
    return Array.from(
      new Set(
        allKnives
          .map((knife) => getBulkEditFieldValue(knife, fieldKey).trim())
          .filter(Boolean),
      ),
    ).sort((left, right) => left.localeCompare(right))
  }, [allKnives, fieldKey])

  const handleApply = async () => {
    if (!fieldKey) {
      setError('Choose a field to update.')
      return
    }

    const nextValue = value.trim()
    if (!nextValue) {
      setError('Enter a replacement value.')
      return
    }

    setError(null)
    setIsSaving(true)
    try {
      await onApply(fieldKey, nextValue)
      resetForm()
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : 'Could not update the selected knives.',
      )
      setIsSaving(false)
    }
  }

  const selectedCount = selectedKnives.length
  const listId = fieldKey ? `bulk-edit-values-${fieldKey}` : undefined

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bulk edit {selectedCount} knives</DialogTitle>
          <DialogDescription>
            Choose one field and replace it for every selected knife.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <label className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Field
            </label>
            <Select
              value={fieldKey || null}
              onValueChange={(nextValue) => {
                setFieldKey((nextValue ?? '') as BulkEditFieldKey | '')
                setValue('')
                setError(null)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a field">
                  {selectedField?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {fields.map((field) => (
                  <SelectItem key={field.key} value={field.key}>
                    {field.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {fieldKey && (
            <div className="rounded-lg border border-[var(--bladevault-line)]/70 bg-[color:var(--bladevault-surface-soft)]/40 p-3">
              <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Current values
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {currentValueSummary.map(([currentValue, count]) => (
                  <span
                    key={currentValue}
                    className="rounded-full border border-border/80 bg-background/80 px-2 py-1 text-xs text-foreground"
                  >
                    {count} {formatCurrentValue(currentValue)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            {measurementKind && selectedField ? (
              <fieldset disabled={isSaving}>
                <DimensionInput
                  key={fieldKey}
                  label={`New ${selectedField.label.toLowerCase()}`}
                  value={value}
                  onChange={(nextValue) => {
                    setValue(nextValue)
                    setError(null)
                  }}
                  kind={measurementKind}
                  dimensionUnit={dimensionUnit}
                  list={listId}
                />
              </fieldset>
            ) : (
              <>
                <label
                  htmlFor="bulk-edit-value"
                  className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                >
                  New value
                </label>
                <Input
                  id="bulk-edit-value"
                  type={selectedField?.type ?? 'text'}
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value)
                    setError(null)
                  }}
                  placeholder={
                    selectedField
                      ? `Enter ${selectedField.label.toLowerCase()}`
                      : 'Choose a field first'
                  }
                  list={selectedField?.type === 'text' ? listId : undefined}
                  disabled={!fieldKey || isSaving}
                  aria-invalid={Boolean(error)}
                  autoFocus={false}
                />
              </>
            )}
            {suggestions.length > 0 && selectedField?.type === 'text' && (
              <datalist id={listId}>
                {suggestions.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            )}
            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleApply()}
            disabled={!fieldKey || !value.trim() || isSaving}
          >
            {isSaving
              ? 'Updating…'
              : `Update ${selectedCount} ${selectedCount === 1 ? 'knife' : 'knives'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
