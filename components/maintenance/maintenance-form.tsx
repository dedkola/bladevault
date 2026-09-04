'use client'

import { useState } from 'react'
import {
  MaintenanceEvent,
  MaintenanceEventInput,
  MaintenanceType,
  MAINTENANCE_TYPES,
  maintenanceTypeLabel,
} from '@/lib/data'
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
import { Textarea } from '@/components/ui/textarea'

const SHARPENING_TYPES: MaintenanceType[] = ['sharpening', 'stropping']

function formatDateForInput(isoString: string): string {
  try {
    const date = new Date(isoString)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  } catch {
    return ''
  }
}

function parseDateToISO(value: string): string {
  if (!value) return new Date().toISOString()
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).toISOString()
}

type MaintenanceFormData = {
  type: MaintenanceType
  occurredAt: string
  notes: string
  grit: string
  angle: string
  system: string
  passes: string
  ceramic: string
  strop: string
  compound: string
  sharpeningNotes: string
}

function eventToFormData(event: MaintenanceEvent): MaintenanceFormData {
  const details = event.sharpeningDetails
  return {
    type: event.type,
    occurredAt: formatDateForInput(event.occurredAt),
    notes: event.notes ?? '',
    grit: details?.grit ?? '',
    angle: details?.angle ?? '',
    system: details?.system ?? '',
    passes: details?.passes?.toString() ?? '',
    ceramic: details?.ceramic ?? '',
    strop: details?.strop ?? '',
    compound: details?.compound ?? '',
    sharpeningNotes: details?.notes ?? '',
  }
}

function emptyFormData(): MaintenanceFormData {
  return {
    type: 'cleaning',
    occurredAt: formatDateForInput(new Date().toISOString()),
    notes: '',
    grit: '',
    angle: '',
    system: '',
    passes: '',
    ceramic: '',
    strop: '',
    compound: '',
    sharpeningNotes: '',
  }
}

function formDataToInput(data: MaintenanceFormData): MaintenanceEventInput {
  const input: MaintenanceEventInput = {
    type: data.type,
    occurredAt: parseDateToISO(data.occurredAt),
    notes: data.notes.trim(),
  }

  if (SHARPENING_TYPES.includes(data.type)) {
    const sharpeningDetails: NonNullable<
      MaintenanceEventInput['sharpeningDetails']
    > = {}
    if (data.grit.trim()) sharpeningDetails.grit = data.grit.trim()
    if (data.angle.trim()) sharpeningDetails.angle = data.angle.trim()
    if (data.system.trim()) sharpeningDetails.system = data.system.trim()
    if (data.passes.trim()) {
      const passes = Number(data.passes)
      if (Number.isFinite(passes) && passes >= 0) {
        sharpeningDetails.passes = passes
      }
    }
    if (data.ceramic.trim()) sharpeningDetails.ceramic = data.ceramic.trim()
    if (data.strop.trim()) sharpeningDetails.strop = data.strop.trim()
    if (data.compound.trim()) sharpeningDetails.compound = data.compound.trim()
    if (data.sharpeningNotes.trim())
      sharpeningDetails.notes = data.sharpeningNotes.trim()

    if (Object.keys(sharpeningDetails).length > 0) {
      input.sharpeningDetails = sharpeningDetails
    }
  }

  return input
}

type MaintenanceFormProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  event?: MaintenanceEvent
  onSubmit: (input: MaintenanceEventInput) => Promise<void>
  isSubmitting: boolean
  error: string | null
}

export function MaintenanceForm({
  open,
  onOpenChange,
  event,
  onSubmit,
  isSubmitting,
  error,
}: MaintenanceFormProps) {
  const [data, setData] = useState<MaintenanceFormData>(() =>
    event ? eventToFormData(event) : emptyFormData(),
  )

  const isEditing = Boolean(event)
  const showSharpeningFields = SHARPENING_TYPES.includes(data.type)

  const updateField = <K extends keyof MaintenanceFormData>(
    field: K,
    value: MaintenanceFormData[K],
  ) => {
    setData((current) => ({ ...current, [field]: value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await onSubmit(formDataToInput(data))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEditing ? 'Edit maintenance' : 'Add maintenance'}
            </DialogTitle>
            <DialogDescription>
              {isEditing
                ? 'Update the logged maintenance event.'
                : 'Record care performed on this knife.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="maintenance-date"
                  className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                >
                  Date
                </label>
                <Input
                  id="maintenance-date"
                  type="date"
                  value={data.occurredAt}
                  onChange={(e) => updateField('occurredAt', e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label
                  className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                  htmlFor="maintenance-type"
                >
                  Type
                </label>
                <Select
                  value={data.type}
                  onValueChange={(value) =>
                    updateField('type', value as MaintenanceType)
                  }
                >
                  <SelectTrigger id="maintenance-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MAINTENANCE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {maintenanceTypeLabel(type)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {showSharpeningFields && (
              <div className="space-y-3 rounded-lg border border-[var(--bladevault-line)]/70 bg-[color:var(--bladevault-surface-soft)]/40 p-3">
                <div className="text-xs font-medium text-foreground">
                  Sharpening details
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label
                      className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                      htmlFor="maintenance-grit"
                    >
                      Grit
                    </label>
                    <Input
                      id="maintenance-grit"
                      placeholder="e.g. 600"
                      value={data.grit}
                      onChange={(e) => updateField('grit', e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                      htmlFor="maintenance-angle"
                    >
                      Angle
                    </label>
                    <Input
                      id="maintenance-angle"
                      placeholder="e.g. 20°"
                      value={data.angle}
                      onChange={(e) => updateField('angle', e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                      htmlFor="maintenance-system"
                    >
                      System
                    </label>
                    <Input
                      id="maintenance-system"
                      placeholder="e.g. KME"
                      value={data.system}
                      onChange={(e) => updateField('system', e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                      htmlFor="maintenance-passes"
                    >
                      Passes
                    </label>
                    <Input
                      id="maintenance-passes"
                      type="number"
                      min={0}
                      step={1}
                      placeholder="e.g. 50"
                      value={data.passes}
                      onChange={(e) => updateField('passes', e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                      htmlFor="maintenance-ceramic"
                    >
                      Ceramic
                    </label>
                    <Input
                      id="maintenance-ceramic"
                      placeholder="e.g. Spyderco white"
                      value={data.ceramic}
                      onChange={(e) => updateField('ceramic', e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                      htmlFor="maintenance-strop"
                    >
                      Strop
                    </label>
                    <Input
                      id="maintenance-strop"
                      placeholder="e.g. Leather"
                      value={data.strop}
                      onChange={(e) => updateField('strop', e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label
                    className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                    htmlFor="maintenance-compound"
                  >
                    Compound
                  </label>
                  <Input
                    id="maintenance-compound"
                    placeholder="e.g. Green chromium oxide"
                    value={data.compound}
                    onChange={(e) => updateField('compound', e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                    htmlFor="maintenance-sharpening-notes"
                  >
                    Sharpening notes
                  </label>
                  <Textarea
                    id="maintenance-sharpening-notes"
                    placeholder="Any extra sharpening observations"
                    value={data.sharpeningNotes}
                    onChange={(e) =>
                      updateField('sharpeningNotes', e.target.value)
                    }
                    className="min-h-16"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label
                className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                htmlFor="maintenance-notes"
              >
                Notes
              </label>
              <Textarea
                id="maintenance-notes"
                placeholder="What did you do? Any observations?"
                value={data.notes}
                onChange={(e) => updateField('notes', e.target.value)}
                className="min-h-20"
              />
            </div>

            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : isEditing ? 'Save changes' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
