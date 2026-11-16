'use client'

import { useCare } from '@/components/providers/care-provider'
import { useKnives } from '@/components/providers/knives-provider'
import { careBadgeLabel, type CareStatusLevel } from '@/lib/maintenance-due'
import { cn } from '@/lib/utils'

export function careToneTextClass(level: CareStatusLevel | null): string {
  switch (level) {
    case 'overdue':
      return 'text-red-700 dark:text-red-400'
    case 'due-soon':
      return 'text-amber-700 dark:text-amber-400'
    case 'ok':
      return 'text-emerald-700 dark:text-emerald-400'
    default:
      return 'text-muted-foreground'
  }
}

export function careToneDotClass(level: CareStatusLevel | null): string {
  switch (level) {
    case 'overdue':
      return 'bg-red-500'
    case 'due-soon':
      return 'bg-amber-500'
    case 'ok':
      return 'bg-emerald-500'
    default:
      return 'bg-muted-foreground/60'
  }
}

/**
 * Compact care pill for collection cards ("Sharpen overdue · 4d"). Renders
 * nothing unless reminders are on and the Care card field is selected.
 */
export function KnifeCareBadge({
  knifeId,
  className,
}: {
  knifeId: string
  className?: string
}) {
  const { cardFields } = useKnives()
  const { reminders, statusById } = useCare()
  if (!reminders.enabled || !cardFields.includes('care')) return null
  const status = statusById.get(knifeId)
  if (!status) return null
  const label = careBadgeLabel(status)
  if (!label) return null
  return (
    <CareBadgePill level={status.level} label={label} className={className} />
  )
}

export function CareBadgePill({
  level,
  label,
  className,
}: {
  level: CareStatusLevel | null
  label: string
  className?: string
}) {
  return (
    <span
      data-care-badge={level ?? undefined}
      className={cn(
        'inline-flex max-w-full items-start gap-1.5 rounded-[0.625rem] border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] font-medium leading-4',
        careToneTextClass(level),
        className,
      )}
      title={label}
    >
      <span
        aria-hidden
        className={cn(
          'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
          careToneDotClass(level),
        )}
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </span>
  )
}
