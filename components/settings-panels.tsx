import * as React from 'react'
import { cn } from '@/lib/utils'

export function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('settings-section', className)}>
      {title || description ? (
        <div className="settings-section-head">
          {title ? <h3 className="settings-section-title">{title}</h3> : null}
          {description ? (
            <p className="settings-section-description">{description}</p>
          ) : null}
        </div>
      ) : null}
      <div className="settings-section-body">{children}</div>
    </section>
  )
}

export function SettingsRow({
  label,
  description,
  children,
  className,
  inline = false,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  className?: string
  /** Keep a small control (a switch) beside the label at every width. */
  inline?: boolean
}) {
  return (
    <div
      className={cn('settings-row', inline && 'settings-row-inline', className)}
    >
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children ? (
        <div className="settings-row-control flex min-w-0 flex-wrap items-center gap-2">
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function SettingsSwitch({
  checked,
  onCheckedChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  'aria-label': string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className="settings-switch"
      onClick={() => onCheckedChange(!checked)}
    />
  )
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onValueChange: (value: T) => void
  disabled?: boolean
  'aria-label': string
}) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (!step || disabled) return
    event.preventDefault()
    const index = options.findIndex((option) => option.value === value)
    const next = options[(index + step + options.length) % options.length]
    onValueChange(next.value)
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)
      ?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className="settings-segmented"
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-value={option.value}
            tabIndex={isActive ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!isActive) onValueChange(option.value)
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function MonoValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="break-all font-mono text-xs text-muted-foreground">
      {children}
    </div>
  )
}
