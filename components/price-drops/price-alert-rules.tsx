'use client'

import { useId, useState } from 'react'
import { BellOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  formatMoney,
  fromMinorUnits,
  isIsoCurrencyCode,
  toMinorUnits,
} from '@/lib/price-monitor/money'
import type {
  PriceAlertRulesUpdate,
  PriceWatchView,
} from '@/lib/price-monitor/shared'
import { cn } from '@/lib/utils'

/** The currency a new target price uses: the stores', then the purchase's. */
function defaultCurrency(watch: PriceWatchView): string {
  return (
    watch.alerts.targetPrice?.currency ??
    watch.sources.find((source) => source.lastCurrency)?.lastCurrency ??
    (watch.paid?.currency || 'USD')
  )
}

/**
 * The settings switch, styled inline: its stylesheet only loads on the
 * Settings page, and these rules also appear on knife pages.
 */
function RuleSwitch({
  checked,
  disabled,
  onCheckedChange,
  'aria-label': ariaLabel,
}: {
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  'aria-label': string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative h-5 w-9 flex-none rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        "after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:content-['']",
        checked ? 'bg-primary after:translate-x-4' : 'bg-foreground/20',
      )}
    />
  )
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/**
 * A knife's own notification rules: mute it, notify only at or below a
 * target price, or only below what was paid. Shown in the edit-mode price
 * monitoring editor and the Market tab; changes save right away.
 */
export function PriceAlertRules({
  watch,
  busy,
  onChange,
  onUnmuteSource,
  className,
}: {
  watch: PriceWatchView
  busy: boolean
  onChange: (alerts: PriceAlertRulesUpdate) => void
  /** Ends a store mute set from the Inbox. */
  onUnmuteSource?: (sourceId: number) => void
  className?: string
}) {
  const id = useId()
  const { alerts, paid } = watch
  const target = alerts.targetPrice
  const [draft, setDraft] = useState<string | null>(null)
  const [currency, setCurrency] = useState<string | null>(null)
  const shownCurrency = currency ?? defaultCurrency(watch)
  const shownAmount =
    draft ??
    (target ? String(fromMinorUnits(target.minor, target.currency)) : '')
  const mutedSources = watch.sources.filter((source) => source.notifyMutedUntil)

  const commitTarget = () => {
    if (draft === null && currency === null) return
    const text = (draft ?? shownAmount).trim().replace(',', '.')
    const code = shownCurrency.trim().toUpperCase()
    setDraft(null)
    setCurrency(null)
    if (!text) {
      if (target) onChange({ targetPrice: null })
      return
    }
    const amount = Number(text)
    if (!Number.isFinite(amount) || amount <= 0 || !isIsoCurrencyCode(code))
      return
    if (
      target &&
      target.currency === code &&
      fromMinorUnits(target.minor, code) === amount
    )
      return
    onChange({ targetPrice: { amount, currency: code } })
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitTarget()
    }
    if (event.key === 'Escape') {
      setDraft(null)
      setCurrency(null)
    }
  }

  return (
    <div data-price-alert-rules className={cn('space-y-2.5', className)}>
      <span className="text-[10px] xl:text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Alerts for this knife
      </span>
      <div className="flex items-start justify-between gap-3 text-sm">
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block font-medium text-foreground">
            Mute this knife
          </span>
          <span className="block text-xs text-muted-foreground">
            Checks and history continue; no new Inbox or desktop messages.
          </span>
        </span>
        <RuleSwitch
          aria-label="Mute this knife"
          checked={alerts.muted}
          disabled={busy}
          onCheckedChange={(checked) => onChange({ muted: checked })}
        />
      </div>
      <div
        className={cn('space-y-2.5', alerts.muted && 'opacity-60')}
        aria-disabled={alerts.muted || undefined}
      >
        <div className="space-y-1">
          <label
            htmlFor={`${id}-target`}
            className="block text-sm font-medium text-foreground"
          >
            Target price
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-target`}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder="Any price"
              value={shownAmount}
              disabled={busy || alerts.muted}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitTarget}
              onKeyDown={onKeyDown}
              className="h-8 w-32 bg-background/80 text-right tabular-nums"
            />
            <Input
              aria-label="Target price currency"
              value={shownCurrency}
              maxLength={3}
              disabled={busy || alerts.muted}
              onChange={(event) =>
                setCurrency(event.target.value.toUpperCase())
              }
              onBlur={commitTarget}
              onKeyDown={onKeyDown}
              className="h-8 w-16 bg-background/80 uppercase"
            />
            {target ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy || alerts.muted}
                onClick={() => {
                  setDraft(null)
                  setCurrency(null)
                  onChange({ targetPrice: null })
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {target
              ? `Drops notify only at ${formatMoney(target.minor, target.currency)} or less; reaching it always notifies. Stores in other currencies are not compared.`
              : 'Leave empty to be notified about any drop above the minimum change.'}
          </p>
        </div>
        <div className="flex items-start justify-between gap-3 text-sm">
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block font-medium text-foreground">
              Only below regular price
            </span>
            <span className="block text-xs text-muted-foreground">
              {paid
                ? `Drops notify only under ${paid.currency ? formatMoney(toMinorUnits(paid.amount, paid.currency), paid.currency) : paid.amount}. Stores in other currencies are not compared.`
                : 'Needs a regular price on the knife; until then drops notify as usual.'}
            </span>
          </span>
          <RuleSwitch
            aria-label="Only below regular price"
            checked={alerts.belowPaid}
            disabled={busy || alerts.muted}
            onCheckedChange={(checked) => onChange({ belowPaid: checked })}
          />
        </div>
      </div>
      {mutedSources.length ? (
        <ul className="space-y-1">
          {mutedSources.map((source) => (
            <li
              key={source.id}
              className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            >
              <BellOff className="size-3" aria-hidden="true" />
              {source.storeName} muted until{' '}
              {formatDay(source.notifyMutedUntil!)}
              {onUnmuteSource ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => onUnmuteSource(source.id)}
                >
                  Unmute
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
