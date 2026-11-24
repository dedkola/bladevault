'use client'

import { ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from '@/components/settings-panels'
import { relativeTime } from '@/components/price-drops/price-format'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import type {
  DiscoveryItemView,
  DiscoveryOverview,
  DiscoveryStatus,
} from '@/lib/price-monitor/discovery-store'
import {
  OTHER_STORE_IDS,
  OTHER_STORE_LABELS,
  type OtherStoreId,
  type PriceOtherStoresSettings,
} from '@/lib/settings-shared'
import { getSafeExternalUrl } from '@/lib/external-url'
import { cn } from '@/lib/utils'

const secondaryButton =
  'h-8 rounded-lg border-border bg-[var(--bladevault-surface-soft)] text-foreground hover:bg-[var(--bladevault-surface-hover)] hover:text-foreground dark:border-input dark:bg-[var(--bladevault-surface-soft)] dark:text-[var(--bladevault-gold)] dark:hover:bg-[var(--bladevault-surface-hover)] dark:hover:text-[var(--bladevault-gold)]'

const POLL_MS = 15_000

type StoreOverview = DiscoveryOverview & {
  label: string
  active: boolean
  running: boolean
}
type Overview = { active: boolean; running: boolean; stores: StoreOverview[] }

const STORE_DESCRIPTION: Record<OtherStoreId, string> = {
  bladehq:
    'Searches bladehq.com (US prices). A knife that already has a Blade HQ source is skipped. Searches share Blade HQ’s pace with its price checks.',
  smkw: 'Searches smkw.com, Smoky Mountain Knife Works (US prices). A knife that already has an SMKW source is skipped. Searches share SMKW’s pace with its price checks.',
  dlttrading:
    'Searches dlttrading.com (US prices). A knife that already has a DLT Trading source is skipped. Searches share DLT Trading’s pace with its price checks.',
  knifejoy:
    'Searches knifejoy.com through its Shopify search data (US prices), at most one search every 15 minutes. A knife that already has a KnifeJoy source is skipped. Searches share KnifeJoy’s pace with its price checks.',
  northwestknives:
    'Searches northwestknives.com through its Shopify search data (US prices), at most one search every 15 minutes. A knife that already has a Northwest Knives source is skipped. Searches share Northwest Knives’ pace with its price checks.',
  amazon:
    'Searches amazon.com as a shopper with a US delivery address (postcode 90210, US prices), without the browser, at most one search every 15 minutes. Sponsored results are left out, and a listing is added only when its page shows the knife’s model number. A knife that already has an Amazon source is skipped. Searches share Amazon’s pace with its price checks.',
}

const STATUS_LABEL: Record<DiscoveryStatus, string> = {
  found: 'Found',
  not_found: 'Not found',
  rejected: 'Not the same knife',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
}

const STATUS_CLASS: Record<DiscoveryStatus, string> = {
  found: 'text-[var(--bladevault-gold)]',
  not_found: 'text-muted-foreground',
  rejected: 'text-muted-foreground',
  failed: 'text-destructive',
  blocked: 'text-destructive',
  skipped: 'text-muted-foreground',
}

function summary(overview: StoreOverview): string {
  const { counts, waiting } = overview
  const parts = [`${counts.found} found`]
  const missing = counts.not_found + counts.rejected
  if (missing) parts.push(`${missing} not found`)
  const problems = counts.failed + counts.blocked
  if (problems) parts.push(`${problems} failed`)
  if (waiting) parts.push(`${waiting} waiting`)
  return parts.join(' · ')
}

/**
 * Settings → Price monitoring → Other stores: AI looks for every monitored
 * knife at other stores, confirms the listing and adds it as a price
 * source. Works only while AI assistance is connected.
 */
export function OtherStoresSettings({
  settings,
  aiReady,
  disabled,
  onChange,
}: {
  settings: PriceOtherStoresSettings
  /** AI assistance is on with a base URL and a model. */
  aiReady: boolean
  disabled?: boolean
  onChange: (next: PriceOtherStoresSettings) => void
}) {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{
    tone: 'ok' | 'error'
    text: string
  } | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/prices/discovery', {
        cache: 'no-store',
      })
      if (!response.ok) return
      const data = (await response.json()) as { discovery: Overview }
      setOverview(data.discovery)
    } catch {
      // The status list is optional; the settings still work.
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = () => {
      if (!cancelled) void load()
    }
    run()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') run()
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [load, settings.enabled, settings.stores])

  const update = (patch: Partial<PriceOtherStoresSettings>) =>
    onChange({ ...settings, ...patch })
  const off = disabled || !settings.enabled

  const searchAgain = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch('/api/prices/discovery', {
        method: 'POST',
        cache: 'no-store',
      })
      const data = await readJsonResponse<{
        reset: number
        discovery: Overview
        error?: string
      }>(response)
      if (!response.ok)
        throw new Error(getApiErrorMessage(data, 'Could not search again.'))
      setOverview(data.discovery)
      setNotice({
        tone: 'ok',
        text: data.reset
          ? `${data.reset} ${data.reset === 1 ? 'search' : 'searches'} will run again at each store’s normal pace.`
          : 'Every knife searched so far was found.',
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  const runningStore = overview?.stores.find((store) => store.running)
  const status = !settings.enabled
    ? null
    : !aiReady
      ? 'Waiting for AI: turn on Use AI in AI assistance and choose a base URL and model. Nothing is searched until then.'
      : !OTHER_STORE_IDS.some((id) => settings.stores[id])
        ? 'Turn on at least one store below.'
        : runningStore
          ? `Searching ${runningStore.label} now…`
          : null
  const shown =
    overview?.stores.filter(
      (store) =>
        store.recent.length || (settings.stores[store.store] && store.waiting),
    ) ?? []
  const recent: Array<DiscoveryItemView & { storeLabel: string }> = shown
    .flatMap((store) =>
      store.recent.map((item) => ({ ...item, storeLabel: store.label })),
    )
    .sort((a, b) => b.lastAttemptAt.localeCompare(a.lastAttemptAt))
    .slice(0, 20)

  return (
    <SettingsSection
      title="Other stores"
      description="A knife’s own store is often sold out. AI looks for every monitored knife at the stores turned on below, checks that the listing is the same knife, and adds it as a price source. From then on it is checked like any other source, and AI reads the price when the page parsers cannot."
    >
      <SettingsRow
        inline
        label="Look for knives at other stores"
        description="Covers every knife that price monitoring covers, also knives without a product link. Searches run in the background with scheduled checks, one knife at a time at each store’s normal pace. AI gets the knife’s brand, name and specs and the store’s listing titles; never the regular price, notes or photos."
      >
        <SettingsSwitch
          aria-label="Look for knives at other stores"
          checked={settings.enabled}
          disabled={disabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
        />
      </SettingsRow>
      {status ? (
        <p role="status" className="py-2 text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
      {OTHER_STORE_IDS.map((id) => (
        <SettingsRow
          key={id}
          label={OTHER_STORE_LABELS[id]}
          description={STORE_DESCRIPTION[id]}
        >
          <SettingsSwitch
            aria-label={`Look for knives on ${OTHER_STORE_LABELS[id]}`}
            checked={settings.stores[id]}
            disabled={off}
            onCheckedChange={(checked) =>
              update({ stores: { ...settings.stores, [id]: checked } })
            }
          />
        </SettingsRow>
      ))}
      {shown.length ? (
        <SettingsRow
          label="Results"
          description={shown
            .map((store) => `${store.label}: ${summary(store)}`)
            .join(' · ')}
        >
          <Button
            type="button"
            variant="outline"
            className={secondaryButton}
            disabled={off || busy}
            onClick={() => void searchAgain()}
          >
            {busy ? 'Resetting…' : 'Search again for missing'}
          </Button>
          {notice ? (
            <p
              role="status"
              className={cn(
                'w-full text-xs',
                notice.tone === 'error'
                  ? 'text-destructive'
                  : 'text-muted-foreground',
              )}
            >
              {notice.text}
            </p>
          ) : null}
        </SettingsRow>
      ) : null}
      {recent.length ? (
        <ul className="divide-y divide-[var(--bladevault-line)] py-1 text-xs">
          {recent.map((item) => {
            const safeUrl = item.url ? getSafeExternalUrl(item.url) : null
            return (
              <li
                key={`${item.storeLabel}-${item.knifeId}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
              >
                <span className="min-w-0 flex-1 font-medium text-foreground">
                  {[item.brand, item.knifeName].filter(Boolean).join(' ')}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {item.storeLabel}
                </span>
                <span className={cn('shrink-0', STATUS_CLASS[item.status])}>
                  {STATUS_LABEL[item.status]}
                  {item.status === 'found' && !item.sourceActive
                    ? ' (source removed)'
                    : ''}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {relativeTime(item.lastAttemptAt)}
                </span>
                {item.title || item.detail ? (
                  <span className="basis-full text-muted-foreground [overflow-wrap:anywhere]">
                    {safeUrl ? (
                      <a
                        href={safeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {item.title ?? item.url}
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    ) : null}
                    {item.detail && item.status !== 'found' ? (
                      <span className="block">{item.detail}</span>
                    ) : null}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </SettingsSection>
  )
}
