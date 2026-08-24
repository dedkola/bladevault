'use client'

import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { MaintenanceType, maintenanceTypeLabel } from '@/lib/data'
import { Button } from '@/components/ui/button'

const quickActionTypes: MaintenanceType[] = [
  'cleaning',
  'lubrication',
  'sharpening',
  'disassembly',
]

export function MaintenanceQuickActions({
  onQuickAdd,
  onOpenForm,
}: {
  onQuickAdd: (type: MaintenanceType) => Promise<void>
  onOpenForm: () => void
}) {
  const [loadingType, setLoadingType] = useState<MaintenanceType | null>(null)

  const handleQuickAdd = async (
    type: MaintenanceType,
    trigger: HTMLButtonElement,
  ) => {
    setLoadingType(type)
    try {
      await onQuickAdd(type)
    } finally {
      setLoadingType(null)
      requestAnimationFrame(() => trigger.focus({ preventScroll: true }))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {quickActionTypes.map((type) => {
        const isLoading = loadingType === type
        return (
          <Button
            key={type}
            type="button"
            variant="outline"
            size="xs"
            onClick={(event) => handleQuickAdd(type, event.currentTarget)}
            disabled={loadingType !== null}
          >
            {isLoading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Plus className="size-3" />
            )}
            {maintenanceTypeLabel(type)}
          </Button>
        )
      })}
      <Button
        type="button"
        size="xs"
        onClick={onOpenForm}
        disabled={loadingType !== null}
      >
        <Plus className="size-3" />
        Add maintenance
      </Button>
    </div>
  )
}
