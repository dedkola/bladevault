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
import { useKnives } from '@/components/providers/knives-provider'
import { clockTime } from '@/components/price-drops/price-format'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import { getHourCycle } from '@/lib/time-format'
import {
  formatAiHeaders,
  normalizeAiBaseUrl,
  normalizeAiModel,
  parseAiHeaders,
  PRICE_AI_LIMITS,
  type PriceAiSettings,
  type PriceAiUsage,
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
export function TextField({
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
  today: { calls: number; tokens: number }
}

const PURPOSE_LABELS: Record<string, string> = {
  extraction: 'price reading',
  solver: 'error solving',
  vision: 'screenshot reading',
  troubleshoot: 'recovery',
  advisor: 'pacing review',
  discovery_search: 'store search',
  discovery_verify: 'listing check',
  verify: 'price check',
  digest: 'daily summary',
  agent: 'supervisor',
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
/** Today's use against the Limited budget, or the Unlimited note. */
function budgetLine(
  usage: PriceAiUsage,
  today: AiCallSummary['today'],
): string {
  const used = `${today.calls} ${today.calls === 1 ? 'request' : 'requests'}, ${formatCount(today.tokens)} tokens`
  if (usage.mode === 'unlimited')
    return `Today: ${used}. Unlimited: no daily cap.`
  const caps = [
    usage.dailyCalls > 0 ? `${usage.dailyCalls} requests` : null,
    usage.dailyTokens > 0 ? `${formatCount(usage.dailyTokens)} tokens` : null,
  ].filter(Boolean)
  const spent =
    (usage.dailyCalls > 0 && today.calls >= usage.dailyCalls) ||
    (usage.dailyTokens > 0 && today.tokens >= usage.dailyTokens)
  return `Today: ${used}${caps.length ? ` of ${caps.join(' and ')}` : ''}.${spent ? ' The budget is used up: AI continues tomorrow.' : ''}`
}

function AiActivity({
  version,
  usage,
}: {
  version: number
  usage: PriceAiUsage
}) {
  const [summary, setSummary] = useState<AiCallSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hourCycle = getHourCycle(useKnives().timeFormat)

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
      <div className="flex w-full flex-col gap-1 text-xs text-muted-foreground">
        <p>No AI requests in the last 24 hours.</p>
        <p className="tabular-nums">{budgetLine(usage, summary.today)}</p>
      </div>
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
      <p className="tabular-nums">{budgetLine(usage, summary.today)}</p>
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
          , {clockTime(summary.lastError.at, hourCycle)}):{' '}
          {summary.lastError.message}
        </p>
      ) : null}
    </div>
  )
}

type AgentRunView = {
  id: number
  startedAt: string
  trigger: 'scheduled' | 'manual' | 'event'
  mode: 'observe' | 'act'
  durationMs: number
  ok: boolean
  summary: string | null
  actions: Array<{
    kind: string
    sourceId?: number
    knifeId?: string
    status: 'applied' | 'proposed' | 'refused'
    note: string | null
  }>
  error: string | null
}

/** The supervisor's latest run, in one or two lines. */
function AgentLastRun({ version }: { version: number }) {
  const [run, setRun] = useState<AgentRunView | null | undefined>(undefined)
  const hourCycle = getHourCycle(useKnives().timeFormat)
  useEffect(() => {
    let cancelled = false
    callJson<{ runs: AgentRunView[] }>(
      '/api/prices/agent',
      { method: 'GET' },
      'Could not read the AI supervisor runs.',
    )
      .then((data) => {
        if (!cancelled) setRun(data.runs[0] ?? null)
      })
      .catch(() => {
        if (!cancelled) setRun(null)
      })
    return () => {
      cancelled = true
    }
  }, [version])
  if (run === undefined) return null
  if (run === null)
    return <p className="w-full text-xs text-muted-foreground">No runs yet.</p>
  const count = (status: string) =>
    run.actions.filter((action) => action.status === status).length
  const done = run.mode === 'act' ? count('applied') : count('proposed')
  const refused = count('refused')
  const when = clockTime(run.startedAt, hourCycle)
  return (
    <div className="flex w-full flex-col gap-1 text-xs text-muted-foreground">
      <p className="tabular-nums text-foreground">
        Last run {when}:{' '}
        {run.ok
          ? `${done} ${run.mode === 'act' ? 'actions applied' : 'actions proposed'}${refused ? `, ${refused} refused` : ''}`
          : 'failed'}
      </p>
      {run.ok && run.summary ? <p>{run.summary}</p> : null}
      {!run.ok && run.error ? (
        <p className="text-destructive">{run.error}</p>
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
  const [busy, setBusy] = useState<
    'models' | 'test' | 'advisor' | 'agent' | null
  >(null)
  const [agentNotice, setAgentNotice] = useState<Notice>(null)
  const [agentVersion, setAgentVersion] = useState(0)
  const [modelNotice, setModelNotice] = useState<Notice>(null)
  const [testNotice, setTestNotice] = useState<Notice>(null)
  const [advisorNotice, setAdvisorNotice] = useState<Notice>(null)
  const [activityVersion, setActivityVersion] = useState(0)

  const update = (patch: Partial<PriceAiSettings>) =>
    onChange({ ...settings, ...patch })
  const updateUsage = (patch: Partial<PriceAiUsage>) =>
    update({ usage: { ...settings.usage, ...patch } })
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

  const runAgent = async () => {
    setBusy('agent')
    setAgentNotice(null)
    try {
      const data = await callJson<{ run: AgentRunView }>(
        '/api/prices/agent',
        { method: 'POST' },
        'The AI supervisor run failed.',
      )
      setAgentNotice(
        data.run.ok
          ? { tone: 'ok', text: data.run.summary || 'Done.' }
          : { tone: 'error', text: data.run.error || 'The run failed.' },
      )
    } catch (error) {
      setAgentNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
      setAgentVersion((value) => value + 1)
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
        label="AI usage"
        description="Limited caps AI per day and per product, for paid APIs and slow local models. Unlimited lets AI run all day without saving requests or tokens, for cheap or local models; store pacing and bot-check pauses still apply."
      >
        <Select
          value={settings.usage.mode}
          disabled={off}
          onValueChange={(mode) => {
            if (mode === 'limited' || mode === 'unlimited')
              updateUsage({ mode })
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="AI usage"
            className="w-full min-w-0 sm:w-64"
          >
            <SelectValue>
              {settings.usage.mode === 'unlimited'
                ? 'Unlimited (always run)'
                : 'Limited (daily budget)'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="limited">Limited (daily budget)</SelectItem>
            <SelectItem value="unlimited">Unlimited (always run)</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      {settings.usage.mode === 'limited' ? (
        <>
          <SettingsRow
            label="Requests per day"
            description="At most this many AI requests a day, counted from midnight on the server. 0 means no request limit. Test connection does not count."
          >
            <TextField
              aria-label="AI requests per day"
              value={String(settings.usage.dailyCalls)}
              disabled={off}
              validate={(value) =>
                integerInRange(value, PRICE_AI_LIMITS.dailyCalls) === null
                  ? `Enter a whole number from 0 to ${PRICE_AI_LIMITS.dailyCalls[1].toLocaleString('en-US')}.`
                  : null
              }
              onCommit={(value) => {
                const parsed = integerInRange(value, PRICE_AI_LIMITS.dailyCalls)
                if (parsed !== null) updateUsage({ dailyCalls: parsed })
              }}
            />
          </SettingsRow>
          <SettingsRow
            label="Tokens per day"
            description="At most this many tokens a day (page sent plus answer), as the endpoint reports them. 0 means no token limit."
          >
            <TextField
              aria-label="AI tokens per day"
              value={String(settings.usage.dailyTokens)}
              disabled={off}
              validate={(value) =>
                integerInRange(value, PRICE_AI_LIMITS.dailyTokens) === null
                  ? `Enter a whole number from 0 to ${PRICE_AI_LIMITS.dailyTokens[1].toLocaleString('en-US')}.`
                  : null
              }
              onCommit={(value) => {
                const parsed = integerInRange(
                  value,
                  PRICE_AI_LIMITS.dailyTokens,
                )
                if (parsed !== null) updateUsage({ dailyTokens: parsed })
              }}
            />
          </SettingsRow>
          <SettingsRow
            label="AI per product at most every (hours)"
            description={`How long a product waits after AI worked on it before AI may try it again, ${PRICE_AI_LIMITS.sourceCooldownHours[0]}–${PRICE_AI_LIMITS.sourceCooldownHours[1]} hours.`}
          >
            <TextField
              aria-label="Hours between AI attempts per product"
              value={String(settings.usage.sourceCooldownHours)}
              disabled={off}
              validate={(value) =>
                integerInRange(value, PRICE_AI_LIMITS.sourceCooldownHours) ===
                null
                  ? `Enter a whole number from ${PRICE_AI_LIMITS.sourceCooldownHours[0]} to ${PRICE_AI_LIMITS.sourceCooldownHours[1]}.`
                  : null
              }
              onCommit={(value) => {
                const parsed = integerInRange(
                  value,
                  PRICE_AI_LIMITS.sourceCooldownHours,
                )
                if (parsed !== null)
                  updateUsage({ sourceCooldownHours: parsed })
              }}
            />
          </SettingsRow>
        </>
      ) : null}
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
        <AiActivity version={activityVersion} usage={settings.usage} />
      </SettingsRow>
      <SettingsRow
        inline
        label="Read prices the page parsers miss"
        description="Sends the cleaned product page, up to the page size above, within the AI usage limits. The price must appear on the page as written, or it is ignored."
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
        description="When a check cannot read a price, AI works the product page in the monitoring browser: it can wait, scroll, accept or reject cookie banners, confirm age prompts, close pop-ups, pick a variant or region, open the store's own product data, and read the price. Steps that work are remembered for the store and tried first next time, without AI. After an HTTP error or a timeout it also chooses how long to wait and whether to reset the store's cookies. Within the AI usage limits. AI never buys, signs in, fills forms or solves a bot check: for a bot check, use Solve in browser on Price Drops."
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
        label="AI supervisor"
        description="AI looks over every monitored product and store and decides what needs attention: which products to check first, which failing pages to give to AI, when a page should load in the browser, which gone pages to pause, and which knives to look for on other stores. Observe only records what it would do; Act does it within fixed limits. It runs when prices, stock or store pages change (at most every 10 minutes with Unlimited AI, every hour with Limited), and at least every hour with Unlimited or every 6 hours with Limited. Checks still run one at a time per store at the store's safe pace."
      >
        <Select
          value={settings.agentMode}
          disabled={off}
          onValueChange={(mode) => {
            if (mode === 'off' || mode === 'observe' || mode === 'act')
              update({ agentMode: mode })
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="AI supervisor"
            className="w-full min-w-0 sm:w-64"
          >
            <SelectValue>
              {settings.agentMode === 'act'
                ? 'Act'
                : settings.agentMode === 'observe'
                  ? 'Observe (record only)'
                  : 'Off'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="observe">Observe (record only)</SelectItem>
            <SelectItem value="act">Act</SelectItem>
          </SelectContent>
        </Select>
        {settings.agentMode !== 'off' ? (
          <>
            <Button
              type="button"
              variant="outline"
              className={secondaryButton}
              disabled={off || !ready || busy !== null}
              onClick={() => void runAgent()}
            >
              {busy === 'agent' ? 'Running…' : 'Run now'}
            </Button>
            <NoticeText notice={agentNotice} />
            <AgentLastRun version={agentVersion} />
          </>
        ) : null}
      </SettingsRow>
      <SettingsRow
        inline
        label="Confirm price changes"
        description="Before a price change notifies you, or a price jumps far more than usual, AI checks it against the product page: the same variant and currency, for one item, not a bundle or accessory. A change AI rejects is kept as unconfirmed, does not notify, and the reason appears in the check history. When AI is unavailable or the daily budget is used up, changes notify as before. Sends the cleaned page, the old and new price, and the knife's brand, name and specs; never the regular price or notes."
      >
        <SettingsSwitch
          aria-label="Let AI confirm price changes before notifying"
          checked={settings.confirmChanges}
          disabled={off}
          onCheckedChange={(checked) => update({ confirmChanges: checked })}
        />
      </SettingsRow>
      <SettingsRow
        inline
        label="Spot-check page readings"
        description={
          settings.usage.mode === 'unlimited'
            ? "AI also checks the page parsers' readings: every reading on a product's first check, and every reading where the price changed. When AI is sure the reading is wrong, the store page is marked AI doubts the price under Needs attention. The parser's price is kept."
            : 'Works with AI usage set to Unlimited: AI then checks the page parsers’ readings on a product’s first check and whenever the price changes.'
        }
      >
        <SettingsSwitch
          aria-label="Let AI spot-check page readings"
          checked={settings.spotCheck}
          disabled={off || settings.usage.mode !== 'unlimited'}
          onCheckedChange={(checked) => update({ spotCheck: checked })}
        />
      </SettingsRow>
      <SettingsRow
        inline
        label="Daily summary in the Inbox"
        description="Once a day, AI writes a short summary: the best current prices against regular prices, drops and restocks of the last 24 hours, store pages that broke, and what AI fixed. Each day's summary replaces the last. Only knife names, store names and prices are sent: no notes, photos or links."
      >
        <SettingsSwitch
          aria-label="Let AI write a daily price summary in the Inbox"
          checked={settings.dailyDigest}
          disabled={off}
          onCheckedChange={(checked) => update({ dailyDigest: checked })}
        />
      </SettingsRow>
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
