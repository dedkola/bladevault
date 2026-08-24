'use client'

import * as React from 'react'
import { Popover } from '@base-ui/react/popover'
import {
  DayFlag,
  DayPicker,
  SelectionState,
  UI,
  type ClassNames,
  type Matcher,
} from 'react-day-picker'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const dayPickerClassNames: Partial<ClassNames> = {
  [UI.Root]: 'text-foreground',
  [UI.Months]: 'flex',
  [UI.Month]: 'space-y-2',
  [UI.MonthCaption]: 'relative flex h-9 items-center justify-center px-11',
  [UI.CaptionLabel]: 'pointer-events-none text-sm font-medium',
  [UI.Nav]:
    'absolute inset-x-1 top-1 z-10 flex h-7 items-center justify-between',
  [UI.PreviousMonthButton]:
    'inline-flex size-6 items-center justify-center rounded-md border border-[var(--bladevault-line)]/80 bg-background text-foreground shadow-sm transition-colors hover:border-[var(--bladevault-line)] hover:bg-[var(--bladevault-surface-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
  [UI.NextMonthButton]:
    'inline-flex size-6 items-center justify-center rounded-md border border-[var(--bladevault-line)]/80 bg-background text-foreground shadow-sm transition-colors hover:border-[var(--bladevault-line)] hover:bg-[var(--bladevault-surface-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
  [UI.MonthGrid]: 'w-full border-collapse',
  [UI.Weekdays]: 'mb-1 flex',
  [UI.Weekday]:
    'w-9 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
  [UI.Weeks]: 'space-y-0.5',
  [UI.Week]: 'flex',
  [UI.Day]: 'size-9 p-0 text-center text-sm',
  [UI.DayButton]:
    'inline-flex size-9 items-center justify-center rounded-md text-sm text-foreground transition-colors hover:bg-[var(--bladevault-surface-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40',
  [DayFlag.outside]: 'text-muted-foreground/50',
  [DayFlag.today]: 'font-semibold text-[var(--bladevault-title)]',
  [SelectionState.selected]:
    'bg-[var(--bladevault-gold)] text-[var(--bladevault-olive)] hover:bg-[var(--bladevault-title)] hover:text-[var(--bladevault-olive)]',
}

type DateInputProps = Omit<React.ComponentProps<'input'>, 'type'>

function toDateString(value: unknown): string {
  if (typeof value !== 'string') return ''
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

function parseDateString(value: string): Date | undefined {
  if (!value) return undefined
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return undefined
  const date = new Date(year, month - 1, day)
  if (Number.isNaN(date.getTime())) return undefined
  return date
}

function formatDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatDateLabel(date: Date | undefined): string {
  if (!date) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(date)
  } catch {
    return formatDateString(date)
  }
}

const DateInput = React.forwardRef<HTMLInputElement, DateInputProps>(
  (
    {
      className,
      value,
      defaultValue,
      onChange,
      placeholder,
      disabled,
      required,
      id,
      name,
      min,
      max,
      'aria-invalid': ariaInvalid,
      ...props
    },
    ref,
  ) => {
    const [open, setOpen] = React.useState(false)

    const rawValue = toDateString(value) || toDateString(defaultValue)
    const selectedDate = parseDateString(rawValue)
    const minDate = parseDateString(toDateString(min))
    const maxDate = parseDateString(toDateString(max))
    const [month, setMonth] = React.useState<Date>(selectedDate ?? new Date())

    React.useEffect(() => {
      const nextMonth = parseDateString(rawValue)
      if (!nextMonth) return

      setMonth((currentMonth) =>
        currentMonth.getFullYear() === nextMonth.getFullYear() &&
        currentMonth.getMonth() === nextMonth.getMonth()
          ? currentMonth
          : nextMonth,
      )
    }, [rawValue])

    const disabledDays = React.useMemo<Matcher[]>(() => {
      const matchers: Matcher[] = []
      if (minDate) matchers.push({ before: minDate })
      if (maxDate) matchers.push({ after: maxDate })
      return matchers
    }, [minDate, maxDate])

    const triggerLabel = formatDateLabel(selectedDate)

    const emitChange = React.useCallback(
      (nextValue: string) => {
        if (!onChange) return
        onChange({
          target: { value: nextValue, name, id },
          currentTarget: { value: nextValue, name, id },
        } as React.ChangeEvent<HTMLInputElement>)
      },
      [id, name, onChange],
    )

    const handleSelect = (date: Date | undefined) => {
      emitChange(date ? formatDateString(date) : '')
      setOpen(false)
    }

    const showPlaceholder = !triggerLabel

    return (
      <>
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger
            type="button"
            disabled={disabled}
            aria-invalid={ariaInvalid}
            className={cn(
              'relative flex h-8 w-full min-w-0 items-center rounded-lg border border-input bg-transparent px-2.5 pr-9 text-left text-sm tabular-nums transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
              className,
            )}
          >
            <span
              className={cn(
                'truncate',
                showPlaceholder ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {showPlaceholder ? placeholder || 'Select date' : triggerLabel}
            </span>
            <span className="pointer-events-none absolute right-2 inline-flex items-center gap-0.5 text-muted-foreground/90">
              <Calendar className="size-3.5" />
              <ChevronDown className="size-3" />
            </span>
          </Popover.Trigger>

          <Popover.Portal>
            <Popover.Positioner side="bottom" align="start" sideOffset={6}>
              <Popover.Popup
                className="z-50 rounded-xl border border-[var(--bladevault-line)] bg-popover p-2.5 pt-1.5 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
                initialFocus={false}
              >
                <DayPicker
                  mode="single"
                  month={month}
                  onMonthChange={setMonth}
                  selected={selectedDate}
                  onSelect={handleSelect}
                  disabled={disabledDays.length > 0 ? disabledDays : undefined}
                  showOutsideDays
                  classNames={dayPickerClassNames}
                  components={{
                    Chevron: ({ orientation, className: chevronClassName }) => {
                      const chevronClass = cn('size-4', chevronClassName)

                      switch (orientation) {
                        case 'left':
                          return <ChevronLeft className={chevronClass} />
                        case 'right':
                          return <ChevronRight className={chevronClass} />
                        case 'up':
                          return (
                            <ChevronRight
                              className={cn(chevronClass, 'rotate-[-90deg]')}
                            />
                          )
                        case 'down':
                          return (
                            <ChevronRight
                              className={cn(chevronClass, 'rotate-90')}
                            />
                          )
                        default:
                          return <ChevronRight className={chevronClass} />
                      }
                    },
                  }}
                />

                <div className="mt-2 flex items-center justify-between border-t border-[var(--bladevault-line)]/60 pt-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => handleSelect(undefined)}
                    disabled={!rawValue}
                  >
                    Clear
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    onClick={() => {
                      const today = new Date()
                      setMonth(today)
                      handleSelect(today)
                    }}
                  >
                    Today
                  </Button>
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>

        <input
          {...props}
          ref={ref}
          id={id}
          name={name}
          type="hidden"
          value={rawValue}
          required={required}
          readOnly
        />
      </>
    )
  },
)

DateInput.displayName = 'DateInput'

export { DateInput }
