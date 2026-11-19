'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from '@/components/settings-panels'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  formatAiHeaders,
  normalizeAiBaseUrl,
  normalizeAiModel,
  parseAiHeaders,
  PRICE_AI_LIMITS,
  type PriceAiSettings,
} from '@/lib/settings-shared'

const secondaryButton =
  'h-8 rounded-lg border-border bg-[var(--bladevault-surface-soft)] text-foreground hover:bg-[var(--bladevault-surface-hover)] hover:text-foreground dark:border-input dark:bg-[var(--bladevault-surface-soft)] dark:text-[var(--bladevault-gold)] dark:hover:bg-[var(--bladevault-surface-hover)] dark:hover:text-[var(--bladevault-gold)]'

type KeyStatus = {
  hasKey: boolean
  last4: string
  source: 'env' | 'file' | null
}

type Notice = { tone: 'ok' | 'error'; text: string } | null

async function callJson<T>(
  url: string,
  init: RequestInit,
  fallback: string,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  const data = await readJsonResponse<T & { error?: string }>(response)
  if (!response.ok) throw new Error(getApiErrorMessage(data, fallback))
  return data
}

function NoticeText({ notice }: { notice: Notice }) {
  if (!notice) return null
  return (
    <p
      role="status"
      className={
        notice.tone === 'error'
          ? 'w-full text-xs text-destructive'
          : 'w-full text-xs text-muted-foreground'
      }
    >
      {notice.text}
    </p>
  )
}

/** A text setting that saves on blur or Enter; Escape reverts. */
function TextField({
  value,
  placeholder,
  disabled,
  validate,
  onCommit,
  'aria-label': ariaLabel,
}: {
  value: string
  placeholder?: string
  disabled?: boolean
  validate: (value: string) => string | null
  onCommit: (value: string) => void
  'aria-label': string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const trimmed = draft.trim()
    const problem = validate(trimmed)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setDraft(null)
    if (trimmed !== value) onCommit(trimmed)
  }
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-80">
      <Input
        value={draft ?? value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        className="h-8"
        onChange={(event) => {
          setDraft(event.target.value)
          setError(null)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') {
            setDraft(null)
            setError(null)
          }
        }}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

function ApiKeyControl({ disabled }: { disabled?: boolean }) {
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  useEffect(() => {
    let cancelled = false
    callJson<{ key: KeyStatus }>(
      '/api/settings/price-ai-key',
      { method: 'GET' },
      'Could not read the API key status.',
    )
      .then((data) => {
        if (!cancelled) setStatus(data.key)
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setNotice({
            tone: 'error',
            text: error instanceof Error ? error.message : String(error),
          })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const run = async (action: () => Promise<{ key: KeyStatus }>, ok: string) => {
    setBusy(true)
    setNotice(null)
    try {
      const data = await action()
      setStatus(data.key)
      setEditing(false)
      setDraft('')
      setNotice({ tone: 'ok', text: ok })
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }
  const save = () =>
    run(
      () =>
        callJson(
          '/api/settings/price-ai-key',
          { method: 'POST', body: JSON.stringify({ apiKey: draft }) },
          'Could not save the API key.',
        ),
      'API key saved.',
    )
  const remove = () =>
    run(
      () =>
        callJson(
          '/api/settings/price-ai-key',
          { method: 'DELETE' },
          'Could not remove the API key.',
        ),
      'API key removed.',
    )

  if (status?.source === 'env')
    return (
      <span className="text-xs text-muted-foreground">
        Key set by the server
        {status.last4 ? ` ••••${status.last4}` : ''} (
        <code>BLADEVAULT_PRICE_AI_API_KEY</code>)
      </span>
    )

  const showForm = editing || (status !== null && !status.hasKey)
  return (
    <>
      {showForm ? (
        <form
          className="flex w-full min-w-0 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (draft.trim()) void save()
          }}
        >
          <Input
            type="password"
            value={draft}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
            aria-label="API key"
            disabled={disabled || busy}
            className="h-8 min-w-0 flex-1 sm:max-w-64"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            className={secondaryButton}
            disabled={disabled || busy || !draft.trim()}
          >
            Save key
          </Button>
          {editing ? (
            <Button
              type="button"
              variant="outline"
              className={secondaryButton}
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setDraft('')
              }}
            >
              Cancel
            </Button>
          ) : null}
        </form>
      ) : status ? (
        <>
          <span className="text-sm tabular-nums text-foreground">
            Key set{status.last4 ? ` ••••${status.last4}` : ''}
          </span>
          <Button
            type="button"
            variant="outline"
            className={secondaryButton}
            disabled={disabled || busy}
            onClick={() => {
              setEditing(true)
              setNotice(null)
            }}
          >
            Replace
          </Button>
          <Button
            type="button"
            variant="outline"
            className={secondaryButton}
            disabled={disabled || busy}
            onClick={() => void remove()}
          >
            Remove
          </Button>
        </>
      ) : null}
      <NoticeText notice={notice} />
    </>
  )
}

type AiCallSummary = {
  calls: number
  failed: number
  medianMs: number | null
  promptTokens: number
  completionTokens: number
  byPurpose: Array<{ purpose: string; calls: number; failed: number }>
  lastCallAt: string | null
  lastError: { at: string; purpose: string; message: string } | null
  reasoning: boolean
}

const PURPOSE_LABELS: Record<string, string> = {
  extraction: 'price reading',
  solver: 'error solving',
  vision: 'screenshot reading',
  troubleshoot: 'recovery',
  advisor: 'pacing review',
  discovery_search: 'store search',
  discovery_verify: 'listing check',
  test: 'connection test',
}

/** A whole number within the range, from a typed value; null otherwise. */
function integerInRange(
  value: string,
  [min, max]: readonly [number, number],
): number | null {
  const text = value.replace(/[\s,_]/g, '')
  if (!/^\d+$/.test(text)) return null
  const parsed = Number(text)
  return parsed >= min && parsed <= max ? parsed : null
}

const formatCount = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact' }).format(value)

/** What AI did in the last 24 hours, from the AI call journal. */
function AiActivity({ version }: { version: number }) {
  const [summary, setSummary] = useState<AiCallSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    callJson<AiCallSummary>(
      '/api/prices/ai-calls',
      { method: 'GET' },
      'Could not read the AI activity.',
    )
      .then((data) => {
        if (cancelled) return
        setSummary(data)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [version])

  if (error) return <p className="w-full text-xs text-destructive">{error}</p>
  if (!summary) return null
  if (!summary.calls)
    return (
      <p className="w-full text-xs text-muted-foreground">
        No AI requests in the last 24 hours.
      </p>
    )
  const tokens = summary.promptTokens + summary.completionTokens
  const parts = [
    `${summary.calls} ${summary.calls === 1 ? 'request' : 'requests'}`,
    summary.failed ? `${summary.failed} failed` : 'none failed',
    summary.medianMs !== null
      ? `typically ${(summary.medianMs / 1000).toFixed(1)} s`
      : null,
    tokens ? `${formatCount(tokens)} tokens` : null,
  ].filter(Boolean)
  return (
    <div className="flex w-full flex-col gap-1 text-xs text-muted-foreground">
      <p className="tabular-nums text-foreground">{parts.join(' · ')}</p>
      <p>
        {summary.byPurpose
          .map(
            (entry) =>
              `${PURPOSE_LABELS[entry.purpose] ?? entry.purpose} ${entry.calls}${entry.failed ? ` (${entry.failed} failed)` : ''}`,
          )
          .join(', ')}
      </p>
      {summary.reasoning ? (
        <p>
          The model reasons before it answers, so each request gets more time
          and tokens.
        </p>
      ) : null}
      {summary.lastError ? (
        <p className="text-destructive">
          Last error (
          {PURPOSE_LABELS[summary.lastError.purpose] ??
            summary.lastError.purpose}
          , {new Date(summary.lastError.at).toLocaleTimeString()}):{' '}
          {summary.lastError.message}
        </p>
      ) : null}
    </div>
  )
}

export type AdvisorLaneAdvice = {
  minGapMs: number | null
  pauseUntil: string | null
  quietHours: [number, number] | null
  reason: string
  expiresAt: string
}

/**
 * Settings → Price monitoring → AI: an optional OpenAI-compatible endpoint
 * for reading prices the page parsers miss and for reviewing store pacing.
 * The key is write-only; only its last four characters are ever shown.
 */
export function PriceAiSettingsSection({
  settings,
  disabled,
  onChange,
  onAdviceApplied,
}: {
  settings: PriceAiSettings
  disabled?: boolean
  onChange: (next: PriceAiSettings) => void
  onAdviceApplied?: () => void
}) {
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState<'models' | 'test' | 'advisor' | null>(null)
  const [modelNotice, setModelNotice] = useState<Notice>(null)
  const [testNotice, setTestNotice] = useState<Notice>(null)
  const [advisorNotice, setAdvisorNotice] = useState<Notice>(null)
  const [activityVersion, setActivityVersion] = useState(0)

  const update = (patch: Partial<PriceAiSettings>) =>
    onChange({ ...settings, ...patch })
  const off = disabled || !settings.enabled
  const ready = Boolean(settings.baseUrl && settings.model)

  const discover = async () => {
    setBusy('models')
    setModelNotice(null)
    try {
      const data = await callJson<{ models: string[] }>(
        '/api/settings/price-ai-models',
        { method: 'POST', body: '{}' },
        'Could not load the model list.',
      )
      setModels(data.models)
      setModelNotice(
        data.models.length
          ? { tone: 'ok', text: `${data.models.length} models found.` }
          : { tone: 'error', text: 'The endpoint listed no models.' },
      )
    } catch (error) {
      setModelNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy('test')
    setTestNotice(null)
    try {
      const data = await callJson<{
        ok: boolean
        message: string
        latencyMs: number
      }>(
        '/api/settings/price-ai-test',
        { method: 'POST', body: '{}' },
        'The test request failed.',
      )
      setTestNotice({
        tone: data.ok ? 'ok' : 'error',
        text: `${data.message} (${(data.latencyMs / 1000).toFixed(1)} s)`,
      })
    } catch (error) {
      setTestNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
      setActivityVersion((value) => value + 1)
    }
  }

  const review = async () => {
    setBusy('advisor')
    setAdvisorNotice(null)
    try {
      const data = await callJson<{ advice: { lanes: unknown[] } }>(
        '/api/prices/advisor',
        { method: 'POST' },
        'The pacing review failed.',
      )
      const count = data.advice.lanes.length
      setAdvisorNotice({
        tone: 'ok',
        text: count
          ? `AI adjusted ${count} ${count === 1 ? 'store' : 'stores'}. See the store table below.`
          : 'AI found nothing to change.',
      })
      onAdviceApplied?.()
    } catch (error) {
      setAdvisorNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
      setActivityVersion((value) => value + 1)
    }
  }

  // The list appears after Discover models; the typed ID stays available.
  const modelOptions =
    models.length && settings.model && !models.includes(settings.model)
      ? [settings.model, ...models]
      : models

  return (
    <SettingsSection
      title="AI assistance"
      description="Optional. Any OpenAI-compatible endpoint works: a cloud provider, a gateway, or a local Ollama or LM Studio server. Price monitoring works fully without it."
    >
      <SettingsRow
        inline
        label="Use AI"
        description="Nothing is sent to an AI service while this is off."
      >
        <SettingsSwitch
          aria-label="Use AI for price monitoring"
          checked={settings.enabled}
          disabled={disabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
        />
      </SettingsRow>
      <SettingsRow
        label="Base URL"
        description="For example https://api.openai.com/v1 or http://localhost:11434/v1 for Ollama."
      >
        <TextField
          aria-label="AI base URL"
          value={settings.baseUrl}
          placeholder="https://api.openai.com/v1"
          disabled={off}
          validate={(value) =>
            !value || normalizeAiBaseUrl(value)
              ? null
              : 'Enter an http or https URL without a query.'
          }
          onCommit={(value) =>
            update({ baseUrl: value ? (normalizeAiBaseUrl(value) ?? '') : '' })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="API key"
        description="Stored on this server outside the vault, so it is never part of a backup. Local servers usually need none."
      >
        <ApiKeyControl disabled={off} />
      </SettingsRow>
      <SettingsRow
        label="Custom headers"
        description='Optional JSON object of extra HTTP headers sent with every AI request, for gateways that need them, e.g. {"x-opencode-session": "bladevault"} for OpenCode Go. Saved with the settings, so do not put keys here.'
      >
        <TextField
          aria-label="AI custom headers (JSON)"
          value={formatAiHeaders(settings.headers)}
          placeholder='{"X-Org": "acme"}'
          disabled={off}
          validate={(value) => {
            const parsed = parseAiHeaders(value)
            return parsed.ok ? null : parsed.error
          }}
          onCommit={(value) => {
            const parsed = parseAiHeaders(value)
            if (parsed.ok) update({ headers: parsed.headers })
          }}
        />
      </SettingsRow>
      <SettingsRow
        label="Model"
        description="Discover models asks the endpoint for its list; you can also type a model ID."
      >
        {modelOptions.length ? (
          <Select
            value={settings.model || undefined}
            disabled={off}
            onValueChange={(model) => {
              if (model) update({ model })
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Choose a model"
              className="w-full min-w-0 sm:w-64"
            >
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <TextField
          aria-label="Model ID"
          value={settings.model}
          placeholder="gpt-4o-mini"
          disabled={off}
          validate={(value) =>
            normalizeAiModel(value) === null
              ? 'This is not a valid model ID.'
              : null
          }
          onCommit={(model) => update({ model })}
        />
        <Button
          type="button"
          variant="outline"
          className={secondaryButton}
          disabled={off || !settings.baseUrl || busy !== null}
          onClick={() => void discover()}
        >
          {busy === 'models' ? 'Discovering…' : 'Discover models'}
        </Button>
        <NoticeText notice={modelNotice} />
      </SettingsRow>
      <SettingsRow
        label="Page size AI reads (KB)"
        description={`How much of a product page AI reads when it reads a price, ${PRICE_AI_LIMITS.maxPageKb[0]}–${PRICE_AI_LIMITS.maxPageKb[1]} KB of cleaned HTML. Price elements come first, then the rest of the page. Models with a large context window (1M tokens) handle 200–500 KB; small local models need about 8–16 KB.`}
      >
        <TextField
          aria-label="Page size AI reads, in KB"
          value={String(settings.maxPageKb)}
          disabled={off}
          validate={(value) =>
            integerInRange(value, PRICE_AI_LIMITS.maxPageKb) === null
              ? `Enter a whole number from ${PRICE_AI_LIMITS.maxPageKb[0]} to ${PRICE_AI_LIMITS.maxPageKb[1]}.`
              : null
          }
          onCommit={(value) => {
            const parsed = integerInRange(value, PRICE_AI_LIMITS.maxPageKb)
            if (parsed !== null) update({ maxPageKb: parsed })
          }}
        />
      </SettingsRow>
      <SettingsRow
        label="Answer limit for reasoning models (tokens)"
        description={`The most a model that reasons before it answers may write per request, ${formatCount(PRICE_AI_LIMITS.maxAnswerTokens[0])}–${formatCount(PRICE_AI_LIMITS.maxAnswerTokens[1])} tokens. It limits the answer only, not the page sent. If the endpoint refuses it as above the model's own limit, BladeVault lowers it to 4,096 for that model.`}
      >
        <TextField
          aria-label="Answer limit for reasoning models, in tokens"
          value={String(settings.maxAnswerTokens)}
          disabled={off}
          validate={(value) =>
            integerInRange(value, PRICE_AI_LIMITS.maxAnswerTokens) === null
              ? `Enter a whole number from ${PRICE_AI_LIMITS.maxAnswerTokens[0]} to ${PRICE_AI_LIMITS.maxAnswerTokens[1]}.`
              : null
          }
          onCommit={(value) => {
            const parsed = integerInRange(
              value,
              PRICE_AI_LIMITS.maxAnswerTokens,
            )
            if (parsed !== null) update({ maxAnswerTokens: parsed })
          }}
        />
      </SettingsRow>
      <SettingsRow
        label="Test connection"
        description="Sends a made-up product page and checks that the model reads its price."
      >
        <Button
          type="button"
          variant="outline"
          className={secondaryButton}
          disabled={off || !ready || busy !== null}
          onClick={() => void test()}
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        <NoticeText notice={testNotice} />
      </SettingsRow>
      <SettingsRow
        label="AI activity"
        description="Requests in the last 24 hours, from a journal that keeps no page content, answers or keys."
      >
        <AiActivity version={activityVersion} />
      </SettingsRow>
      <SettingsRow
        inline
        label="Read prices the page parsers miss"
        description="Sends the cleaned product page, up to the page size above, at most once a day per product. The price must appear on the page as written, or it is ignored."
      >
        <SettingsSwitch
          aria-label="Read prices with AI when the page parsers find none"
          checked={settings.extractionFallback}
          disabled={off}
          onCheckedChange={(checked) => update({ extractionFallback: checked })}
        />
      </SettingsRow>
      <SettingsRow
        inline
        label="Resolve check errors"
        description="When a check cannot read a price, AI works the product page in the monitoring browser: it can wait, scroll, accept or reject cookie banners, confirm age prompts, close pop-ups, pick a variant or region, open the store's own product data, and read the price. Steps that work are remembered for the store and tried first next time, without AI. After an HTTP error or a timeout it also chooses how long to wait and whether to reset the store's cookies. At most once a day per product. AI never buys, signs in, fills forms or solves a bot check: for a bot check, use Solve in browser on Price Drops."
      >
        <SettingsSwitch
          aria-label="Let AI resolve failed price checks"
          checked={settings.resolveErrors}
          disabled={off}
          onCheckedChange={(checked) => update({ resolveErrors: checked })}
        />
      </SettingsRow>
      {settings.resolveErrors ? (
        <SettingsRow
          inline
          label="The model reads images"
          description="Lets AI read a price from a screenshot of the page when it is drawn as an image. Turn on only for a vision model, such as gpt-4o-mini or llava. A price read this way must be very confident."
        >
          <SettingsSwitch
            aria-label="Let AI read prices from screenshots"
            checked={settings.vision}
            disabled={off}
            onCheckedChange={(checked) => update({ vision: checked })}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow
        inline
        label="Pacing advisor"
        description="Once a day, or after a store blocked checks twice, AI reviews each store's check statistics and may slow a store down, pause it or set quiet hours, within fixed limits. Only store host names and statistics are sent: no product links, knife names or keys."
      >
        <SettingsSwitch
          aria-label="Let AI review store pacing"
          checked={settings.advisor}
          disabled={off}
          onCheckedChange={(checked) => update({ advisor: checked })}
        />
      </SettingsRow>
      {settings.advisor ? (
        <SettingsRow
          label="Review pacing now"
          description="Advice lasts 48 hours. AI can never speed a store up or shorten a pause after a bot check."
        >
          <Button
            type="button"
            variant="outline"
            className={secondaryButton}
            disabled={off || !ready || busy !== null}
            onClick={() => void review()}
          >
            {busy === 'advisor' ? 'Reviewing…' : 'Ask AI to review pacing'}
          </Button>
          <NoticeText notice={advisorNotice} />
        </SettingsRow>
      ) : null}
    </SettingsSection>
  )
}
