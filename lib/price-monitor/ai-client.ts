import {
  clockMark,
  noteAiNetworkFailure,
  powerSignal,
  sleptSince,
} from '@/lib/price-monitor/power'
import { redactSecrets } from '@/lib/price-monitor/secret-registry'
import { normalizeAiBaseUrl } from '@/lib/settings-shared'

/**
 * A small client for OpenAI-compatible endpoints (OpenAI, Ollama, LM Studio,
 * gateways), shared by the extraction fallback and the pacing advisor. The
 * base URL may point to localhost on purpose; this exception from the
 * external-URL rules applies to the AI client only. Errors never contain
 * the key.
 */
export type AiEndpoint = {
  baseUrl: string
  apiKey: string | null
  /** Extra headers from settings (already validated by parseAiHeaders). */
  headers?: Record<string, string>
  /**
   * Answer ceiling for reasoning models (settings' maxAnswerTokens); limits
   * the answer only. REASONING_MAX_TOKENS when unset.
   */
  maxAnswerTokens?: number
}

export type AiErrorCode =
  | 'config'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'http'
  | 'invalid_response'
  /** The daily AI budget is used up (Limited mode); nothing was sent. */
  | 'budget'
  /**
   * The computer slept during the request (or went to sleep and stopped
   * it). Not the endpoint's fault: neutral, and the source was not tried.
   */
  | 'suspended'
  /** The endpoint refused a request with tools: use the JSON mode instead. */
  | 'tools_unsupported'

export class AiClientError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(redactSecrets(message))
    this.name = 'AiClientError'
  }
}

export type FetchLike = typeof fetch

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 500

function endpointUrl(endpoint: AiEndpoint, suffix: string): string {
  const base = normalizeAiBaseUrl(endpoint.baseUrl)
  if (!base) throw new AiClientError('config', 'Set a valid AI base URL.')
  return `${base}${suffix}`
}

function headers(endpoint: AiEndpoint, json: boolean): Headers {
  const result = new Headers({ Accept: 'application/json' })
  for (const [name, value] of Object.entries(endpoint.headers ?? {}))
    result.set(name, value)
  if (json) result.set('Content-Type', 'application/json')
  if (endpoint.apiKey) result.set('Authorization', `Bearer ${endpoint.apiKey}`)
  return result
}

/**
 * The caller's signal, the timeout and the sleep signal. Node timers run on
 * the monotonic clock, so the timeout counts awake time only.
 */
function combinedSignal(timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return AbortSignal.any(
    signal ? [signal, timeout, powerSignal()] : [timeout, powerSignal()],
  )
}

/**
 * The AI client errors that mean the model was never reached or asked:
 * nothing configured, no route to the endpoint, the budget refused it, or
 * the computer slept. They do not start a source's AI pause.
 */
export function aiNotReached(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'AiClientError') return false
  const code = (error as { code?: unknown }).code
  return (
    code === 'config' ||
    code === 'network' ||
    code === 'budget' ||
    code === 'suspended'
  )
}

const suspendedError = () =>
  new AiClientError(
    'suspended',
    'The computer went to sleep during the AI request; it runs again after wake.',
  )

/** The provider's own error text, shortened and without secrets. */
function providerMessage(body: string): string {
  let text = body
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string
      message?: unknown
    }
    const candidate =
      typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error?.message ?? parsed.message)
    if (typeof candidate === 'string') text = candidate
  } catch {
    // Not JSON: keep the text.
  }
  const cleaned = redactSecrets(text.replace(/\s+/g, ' ').trim())
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned
}

type SendOptions = {
  timeoutMs: number
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

/**
 * Sends one request and returns the response once its status is OK; an
 * error status throws with the provider's (redacted) message. `signal`
 * already combines the caller's signal with the timeouts; `callerSignal` is
 * the caller's own, to tell a cancel from a timeout.
 */
async function open(
  url: string,
  init: RequestInit,
  options: {
    signal: AbortSignal
    callerSignal?: AbortSignal
    fetchImpl?: FetchLike
    mark: ReturnType<typeof clockMark>
  },
): Promise<Response> {
  const { signal, mark } = options
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      signal,
      cache: 'no-store',
      // A redirect could carry the key to another host.
      redirect: 'error',
    })
  } catch (error) {
    if (options.callerSignal?.aborted)
      throw new AiClientError('cancelled', 'The AI request was cancelled.')
    // Sleep ends requests with timeouts and dead sockets alike.
    if (sleptSince(mark)) throw suspendedError()
    if (signal.aborted)
      throw new AiClientError(
        'timeout',
        'The AI endpoint did not answer in time.',
      )
    const reason =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : error instanceof Error
          ? error.message
          : ''
    noteAiNetworkFailure(reason)
    throw new AiClientError(
      'network',
      `Could not reach the AI endpoint${reason ? ` (${reason})` : ''}.`,
    )
  }
  if (!response.ok) {
    const body = await readBody(response, options).catch((error) => {
      if (error instanceof AiClientError && error.code !== 'invalid_response')
        throw error
      return ''
    })
    const detail = providerMessage(body)
    const hint =
      response.status === 401 || response.status === 403
        ? ' Check the API key.'
        : response.status === 404
          ? ' Check the base URL and the model.'
          : ''
    throw new AiClientError(
      'http',
      `The AI endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}${hint}`,
      response.status,
    )
  }
  return response
}

/** The whole response body, at most MAX_RESPONSE_BYTES. */
async function readBody(
  response: Response,
  options: {
    signal: AbortSignal
    callerSignal?: AbortSignal
    mark: ReturnType<typeof clockMark>
  },
): Promise<string> {
  let body: string
  try {
    body = await response.text()
  } catch {
    if (options.callerSignal?.aborted)
      throw new AiClientError('cancelled', 'The AI request was cancelled.')
    if (sleptSince(options.mark)) throw suspendedError()
    throw new AiClientError(
      options.signal.aborted ? 'timeout' : 'network',
      'The AI endpoint stopped answering.',
    )
  }
  if (body.length > MAX_RESPONSE_BYTES)
    throw new AiClientError(
      'invalid_response',
      'The AI endpoint sent a response that is too large.',
    )
  return body
}

async function send(
  url: string,
  init: RequestInit,
  options: SendOptions,
): Promise<string> {
  const signal = combinedSignal(options.timeoutMs, options.signal)
  const context = {
    signal,
    callerSignal: options.signal,
    fetchImpl: options.fetchImpl,
    mark: clockMark(),
  }
  const response = await open(url, init, context)
  return readBody(response, context)
}

/** Model ids from `{baseUrl}/models`; never returns the key. */
export async function listAiModels(
  endpoint: AiEndpoint,
  options: {
    signal?: AbortSignal
    fetchImpl?: FetchLike
    timeoutMs?: number
  } = {},
): Promise<string[]> {
  const body = await send(
    endpointUrl(endpoint, '/models'),
    { method: 'GET', headers: headers(endpoint, false) },
    { timeoutMs: options.timeoutMs ?? 15_000, ...options },
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new AiClientError(
      'invalid_response',
      'The AI endpoint did not return a model list.',
    )
  }
  const record = (parsed ?? {}) as { data?: unknown; models?: unknown }
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(parsed)
        ? parsed
        : null
  if (!entries)
    throw new AiClientError(
      'invalid_response',
      'The AI endpoint did not return a model list.',
    )
  const ids = new Set<string>()
  for (const entry of entries) {
    const value =
      typeof entry === 'string'
        ? entry
        : ((entry as { id?: unknown; name?: unknown } | null)?.id ??
          (entry as { name?: unknown } | null)?.name)
    if (typeof value === 'string' && value.trim() && value.length <= 200)
      ids.add(value.trim())
    if (ids.size >= MAX_MODELS) break
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export type JsonSchema = Record<string, unknown>

/** OpenAI chat content parts: text, and images for vision models. */
export type UserContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

type ResponseFormat = 'json_schema' | 'json_object' | 'none'

/**
 * Reasoning models (GLM, DeepSeek R1, Qwen3, o-series, …) spend tokens on
 * hidden thinking before the answer. A small budget is then used up by the
 * thinking alone and the answer comes back empty, so an empty answer is
 * retried once with this budget (a ceiling, not a cost) and more time.
 * Settings can change it per endpoint (AiEndpoint.maxAnswerTokens).
 */
export const REASONING_MAX_TOKENS = 16_384
/**
 * The ceiling used once an endpoint refused a larger max_tokens (above the
 * model's own answer limit); most models accept it.
 */
export const SAFE_ANSWER_TOKENS = 4096
/** Endpoint errors that mean max_tokens is above what the model allows. */
const TOKEN_LIMIT_ERROR =
  /max_tokens|max_completion_tokens|max_output_tokens|maximum[^.]*tokens|tokens?[^.]*(?:limit|exceed|too large|at most)/i
export const REASONING_MIN_TIMEOUT_MS = 60_000
/**
 * How long a planning task's request may take (see REASONING_PURPOSES): a
 * model that thinks over every monitored product needed up to two and a
 * half minutes in practice, so this leaves room without hanging for long.
 */
export const PLANNING_TIMEOUT_MS = 6 * 60_000

/** What a request is for; recorded in the AI call journal. */
export type AiPurpose =
  | 'extraction'
  | 'solver'
  | 'vision'
  | 'troubleshoot'
  | 'advisor'
  | 'discovery_search'
  | 'discovery_verify'
  /** Checks a reading against its page before it is trusted. */
  | 'verify'
  /** The daily Inbox summary. */
  | 'digest'
  | 'agent'
  /** The in-app Chat page; has its own daily limit. */
  | 'chat'
  | 'test'

/**
 * Planning tasks: a few calls an hour that weigh many products or stores at
 * once (the supervisor, the pacing advisor, the daily summary). The model
 * may reason before it answers: they never ask it not to think, and start
 * with the reasoning budget and PLANNING_TIMEOUT_MS. Every other purpose
 * reads a page or checks one fact, often, behind code checks of its own;
 * those ask the model not to reason where the endpoint supports it.
 */
export const REASONING_PURPOSES: ReadonlySet<AiPurpose> = new Set<AiPurpose>([
  'agent',
  'advisor',
  'digest',
])

const plansWith = (purpose: AiPurpose | undefined) =>
  purpose !== undefined && REASONING_PURPOSES.has(purpose)

/** One finished chat completion call (all its attempts), without content. */
export type AiCallEvent = {
  purpose: AiPurpose
  model: string
  startedAt: number
  durationMs: number
  attempts: number
  ok: boolean
  errorCode: AiErrorCode | null
  error: string | null
  promptTokens: number | null
  completionTokens: number | null
  /** The model is known to reason before it answers. */
  reasoning: boolean
}

export type AiCallObserver = (event: AiCallEvent) => void

const OBSERVER = Symbol.for('bladevault.price-ai.call-observer')
const GATE = Symbol.for('bladevault.price-ai.budget-gate')

/**
 * Decides whether a request may be sent: null to send it, or the reason it
 * may not (the daily budget is used up). Connection tests always pass.
 */
export type AiBudgetGate = (purpose: AiPurpose) => string | null
const PROFILES = Symbol.for('bladevault.price-ai.model-profiles')

type Scope = typeof globalThis & {
  [OBSERVER]?: AiCallObserver | null
  [GATE]?: AiBudgetGate | null
  [PROFILES]?: Map<string, ModelProfile>
}

type ModelProfile = {
  reasoning: boolean
  /** The endpoint refused a larger answer ceiling for this model. */
  answerCap?: number
  /** The endpoint refused the request field that turns thinking off. */
  thinkingOffRejected?: boolean
  /** Chat: the endpoint refused `tools` (function calling). */
  toolsRejected?: boolean
  /** Chat: the endpoint refused `stream: true`. */
  streamRejected?: boolean
  /** Chat: the endpoint refused `stream_options` (usage in the stream). */
  streamUsageRejected?: boolean
}

/**
 * Gateways whose models take `thinking: { type: "disabled" }` to answer
 * without reasoning. OpenCode Go/Zen serve GLM, Kimi and DeepSeek over Chat
 * Completions (their own APIs use this field) and translate it for the
 * models it serves through Anthropic Messages (Qwen, Claude). Its docs list
 * no Go-specific switch, so an endpoint that refuses the field gets the
 * request again without it, once per model.
 */
const THINKING_OFF_HOSTS = /(^|\.)opencode\.ai$/i

/**
 * Whether requests to this endpoint ask the model not to reason; planning
 * tasks (REASONING_PURPOSES) never do.
 */
export function sendsThinkingOff(
  endpoint: AiEndpoint,
  purpose?: AiPurpose,
): boolean {
  if (plansWith(purpose)) return false
  const base = normalizeAiBaseUrl(endpoint.baseUrl)
  if (!base) return false
  try {
    return THINKING_OFF_HOSTS.test(new URL(base).hostname)
  } catch {
    return false
  }
}

/** Receives every finished call (process-wide; null removes it). */
export function setAiBudgetGate(gate: AiBudgetGate | null) {
  ;(globalThis as Scope)[GATE] = gate
}

/**
 * Why a request for this purpose may not be sent now (the daily budget is
 * used up), or null. Connection tests always pass; without a gate, nothing
 * is refused.
 */
export function aiBudgetRefusal(purpose: AiPurpose): string | null {
  const gate = (globalThis as Scope)[GATE]
  if (!gate || purpose === 'test') return null
  try {
    return gate(purpose)
  } catch {
    // A broken gate never blocks AI.
    return null
  }
}

export function setAiCallObserver(observer: AiCallObserver | null) {
  ;(globalThis as Scope)[OBSERVER] = observer
}

function modelProfiles(): Map<string, ModelProfile> {
  return ((globalThis as Scope)[PROFILES] ??= new Map())
}

/**
 * What is learned about a model is kept apart for requests that ask it not
 * to think: a model that reasons for planning tasks may answer page reads
 * at once, and a lower answer cap learned there must not starve planning.
 */
function profileKey(
  endpoint: AiEndpoint,
  model: string,
  purpose?: AiPurpose,
): string {
  const base = `${normalizeAiBaseUrl(endpoint.baseUrl) ?? endpoint.baseUrl}\n${model}`
  return sendsThinkingOff(endpoint, purpose) ? `${base}\nthinking-off` : base
}

/**
 * Whether this model is known (in this process) to reason before answering
 * requests for this purpose (left out: a page read or connection test).
 */
export function isReasoningModel(
  endpoint: AiEndpoint,
  model: string,
  purpose?: AiPurpose,
): boolean {
  return (
    modelProfiles().get(profileKey(endpoint, model, purpose))?.reasoning ??
    false
  )
}

/** Forgets what was learned about models; for tests. */
export function resetAiModelProfiles() {
  modelProfiles().clear()
}

type ChatChoice = {
  finish_reason?: unknown
  message?: {
    content?: unknown
    reasoning_content?: unknown
    reasoning?: unknown
  }
}

type ChatResponse = {
  choices?: ChatChoice[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
}

function reasoningText(choice: ChatChoice | undefined): string {
  return (
    messageText(choice?.message?.reasoning_content) ||
    messageText(choice?.message?.reasoning)
  ).trim()
}

/** The model stopped at the token limit or spent the answer on reasoning. */
function ranOutOnReasoning(choice: ChatChoice | undefined): boolean {
  return choice?.finish_reason === 'length' || reasoningText(choice).length > 0
}

const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi
const OPEN_THINK = /<think(?:ing)?>[\s\S]*$/i

/** Answer text without inline `<think>` blocks (some gateways inline them). */
export function stripThinking(text: string): string {
  return text.replace(THINK_BLOCK, '').replace(OPEN_THINK, '').trim()
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('')
  return ''
}

/** The JSON object in a model answer, tolerating code fences and prose. */
export function parseJsonAnswer(text: string): unknown {
  const trimmed = stripThinking(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start)
      throw new AiClientError('invalid_response', 'The AI answer was not JSON.')
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      throw new AiClientError('invalid_response', 'The AI answer was not JSON.')
    }
  }
}

const tokenCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null

type CallUsage = {
  prompt: number | null
  completion: number | null
  attempts: number
}

const newUsage = (): CallUsage => ({
  prompt: null,
  completion: null,
  attempts: 0,
})

/**
 * Reports one finished call (all its attempts) to the journal observer,
 * without content. Calls without a purpose are not journaled.
 */
function callReporter(
  endpoint: AiEndpoint,
  request: { model: string; purpose?: AiPurpose },
  usage: CallUsage,
) {
  const startedAt = Date.now()
  return (error: unknown) => {
    const observer = (globalThis as Scope)[OBSERVER]
    if (!observer || !request.purpose) return
    try {
      observer({
        purpose: request.purpose,
        model: request.model,
        startedAt,
        durationMs: Date.now() - startedAt,
        attempts: usage.attempts,
        ok: error === null,
        errorCode:
          error === null
            ? null
            : error instanceof AiClientError
              ? error.code
              : 'invalid_response',
        error:
          error === null
            ? null
            : redactSecrets(
                error instanceof Error ? error.message : String(error),
              ).slice(0, 300),
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        reasoning: isReasoningModel(endpoint, request.model, request.purpose),
      })
    } catch {
      // The journal never breaks a request.
    }
  }
}

/**
 * One chat completion that must answer with JSON. Asks for a strict JSON
 * schema first and falls back to `json_object`, then to plain prompting,
 * for endpoints that reject the response format.
 *
 * Reasoning models are learned per base URL and model (in this process):
 * an empty answer, an answer cut off at the token limit, a timeout, or
 * reasoning text in the answer marks the model, and the request is retried
 * once with REASONING_MAX_TOKENS and at least REASONING_MIN_TIMEOUT_MS. Later
 * requests to that model start with that budget, so they need one request.
 */
export async function requestJsonCompletion(
  endpoint: AiEndpoint,
  request: {
    model: string
    system: string
    user: UserContent
    schemaName: string
    schema: JsonSchema
    maxTokens?: number
    purpose?: AiPurpose
  },
  options: { timeoutMs: number; signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<unknown> {
  if (!request.model.trim())
    throw new AiClientError('config', 'Choose an AI model first.')
  // Limited mode: no request once the day's budget is used up.
  const refusal = request.purpose ? aiBudgetRefusal(request.purpose) : null
  if (refusal) throw new AiClientError('budget', refusal)
  const usage = newUsage()
  const report = callReporter(endpoint, request, usage)
  try {
    const result = await completeJson(endpoint, request, options, usage)
    report(null)
    return result
  } catch (error) {
    report(error)
    throw error
  }
}

async function completeJson(
  endpoint: AiEndpoint,
  request: {
    model: string
    system: string
    user: UserContent
    schemaName: string
    schema: JsonSchema
    maxTokens?: number
    purpose?: AiPurpose
  },
  options: { timeoutMs: number; signal?: AbortSignal; fetchImpl?: FetchLike },
  usage: CallUsage,
): Promise<unknown> {
  const url = endpointUrl(endpoint, '/chat/completions')
  const formats: ResponseFormat[] = ['json_schema', 'json_object', 'none']
  const key = profileKey(endpoint, request.model, request.purpose)
  const planning = plansWith(request.purpose)
  const baseTokens = request.maxTokens ?? 400
  const profile = (): ModelProfile =>
    modelProfiles().get(key) ?? { reasoning: false }
  let retried = false
  let capped = false
  const thinkingOff = () =>
    sendsThinkingOff(endpoint, request.purpose) &&
    !profile().thinkingOffRejected
  const learnReasoning = () => {
    modelProfiles().set(key, { ...profile(), reasoning: true })
  }
  /** The answer ceiling for this model: settings, lowered if refused. */
  const ceiling = () =>
    Math.min(
      endpoint.maxAnswerTokens ?? REASONING_MAX_TOKENS,
      profile().answerCap ?? Infinity,
    )
  // Planning tasks expect the model to think: room and time from the start.
  const budget = () =>
    planning || profile().reasoning
      ? {
          maxTokens: Math.max(baseTokens, ceiling()),
          timeoutMs: Math.max(
            options.timeoutMs,
            planning ? PLANNING_TIMEOUT_MS : REASONING_MIN_TIMEOUT_MS,
          ),
        }
      : { maxTokens: baseTokens, timeoutMs: options.timeoutMs }
  /** One more try with the reasoning budget, if it would give more room. */
  const canRetry = () =>
    !retried && !options.signal?.aborted && budget().maxTokens < ceiling()
  let lastError: unknown = null
  for (let index = 0; index < formats.length; index++) {
    const format = formats[index]
    const { maxTokens, timeoutMs } = budget()
    const payload: Record<string, unknown> = {
      model: request.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    }
    const sentThinkingOff = thinkingOff()
    if (sentThinkingOff) payload.thinking = { type: 'disabled' }
    if (format === 'json_schema')
      payload.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          strict: true,
          schema: request.schema,
        },
      }
    else if (format === 'json_object')
      payload.response_format = { type: 'json_object' }
    let body: string
    usage.attempts++
    try {
      body = await send(
        url,
        {
          method: 'POST',
          headers: headers(endpoint, true),
          body: JSON.stringify(payload),
        },
        { ...options, timeoutMs },
      )
    } catch (error) {
      // The endpoint does not take the thinking switch: drop it for this
      // model and send the same request again. A 400 that does not name it
      // is retried without it once the formats have run out.
      if (
        sentThinkingOff &&
        error instanceof AiClientError &&
        error.code === 'http' &&
        (error.status === 400 || error.status === 422) &&
        (/thinking/i.test(error.message) || format === 'none')
      ) {
        modelProfiles().set(key, { ...profile(), thinkingOffRejected: true })
        index--
        continue
      }
      // The answer ceiling is above the model's own limit: lower it once
      // and remember that for this model.
      if (
        error instanceof AiClientError &&
        error.code === 'http' &&
        (error.status === 400 || error.status === 422) &&
        !capped &&
        maxTokens > SAFE_ANSWER_TOKENS &&
        TOKEN_LIMIT_ERROR.test(error.message)
      ) {
        capped = true
        modelProfiles().set(key, {
          ...profile(),
          answerCap: Math.max(baseTokens, SAFE_ANSWER_TOKENS),
        })
        index--
        continue
      }
      // 400/422: most likely the response format is not supported.
      if (
        error instanceof AiClientError &&
        error.code === 'http' &&
        (error.status === 400 || error.status === 422) &&
        format !== 'none'
      ) {
        lastError = error
        continue
      }
      // A model that thinks before answering may need more than the
      // caller's short timeout: learn that and try once more.
      if (
        error instanceof AiClientError &&
        error.code === 'timeout' &&
        canRetry()
      ) {
        learnReasoning()
        retried = true
        index--
        continue
      }
      throw error
    }
    let parsed: ChatResponse
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new AiClientError(
        'invalid_response',
        'The AI endpoint sent a response BladeVault could not read.',
      )
    }
    const prompt = tokenCount(parsed?.usage?.prompt_tokens)
    const completion = tokenCount(parsed?.usage?.completion_tokens)
    if (prompt !== null) usage.prompt = (usage.prompt ?? 0) + prompt
    if (completion !== null)
      usage.completion = (usage.completion ?? 0) + completion
    const choice = parsed?.choices?.[0]
    const text = stripThinking(messageText(choice?.message?.content))
    const cutOff = choice?.finish_reason === 'length'
    if (!text) {
      if (canRetry()) {
        // Same format again, with room for the model's reasoning.
        learnReasoning()
        retried = true
        index--
        continue
      }
      throw new AiClientError(
        'invalid_response',
        ranOutOnReasoning(choice)
          ? 'The AI answer was empty: the model used its whole answer budget on reasoning. Choose a model without reasoning, or turn reasoning off for it.'
          : 'The AI answer was empty.',
      )
    }
    let answer: unknown
    try {
      answer = parseJsonAnswer(text)
    } catch (error) {
      // The answer was cut off at the token limit: give it more room once.
      if (cutOff && canRetry()) {
        learnReasoning()
        retried = true
        index--
        continue
      }
      throw error
    }
    // It answered, but thought first: start its next requests with room.
    if (!profile().reasoning && reasoningText(choice)) learnReasoning()
    return answer
  }
  throw lastError instanceof Error
    ? lastError
    : new AiClientError('invalid_response', 'The AI request failed.')
}

// ---------------------------------------------------------------------------
// Chat: multi-turn messages, function calling and streaming (the Chat page).
// ---------------------------------------------------------------------------

export type ChatToolCall = {
  id: string
  name: string
  /** The model's raw JSON arguments text. */
  arguments: string
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export type ChatToolDefinition = {
  name: string
  description: string
  parameters: JsonSchema
}

export type ChatCompletion = {
  /** The answer text without inline thinking. */
  text: string
  toolCalls: ChatToolCall[]
  finishReason: string | null
  /** Tokens of all attempts, when the endpoint reported them. */
  promptTokens?: number | null
  completionTokens?: number | null
}

/** A chat answer's default ceiling; a reasoning model gets the endpoint's. */
export const CHAT_ANSWER_TOKENS = 4096
/** A streamed answer fails when no chunk arrives for this long. */
export const CHAT_IDLE_TIMEOUT_MS = 90_000

const TOOLS_REFUSED =
  /\btools?\b|function|tool_choice|not supported|unsupported|unknown (?:parameter|field|argument)|unrecognized/i
const STREAM_USAGE_REFUSED = /stream_options|include_usage/i
const STREAM_REFUSED = /\bstream/i

function chatProfileKey(
  endpoint: AiEndpoint,
  model: string,
  thinkingOff: boolean,
) {
  const base = `${normalizeAiBaseUrl(endpoint.baseUrl) ?? endpoint.baseUrl}\n${model}`
  return thinkingOff ? `${base}\nthinking-off` : base
}

function chatThinkingOff(endpoint: AiEndpoint, allowThinking: boolean) {
  return !allowThinking && sendsThinkingOff(endpoint, 'chat')
}

/**
 * Whether this endpoint refused function calling for the model (learned in
 * this process); the chat then uses its JSON mode.
 */
export function chatToolsRejected(
  endpoint: AiEndpoint,
  model: string,
  allowThinking = false,
): boolean {
  const key = chatProfileKey(
    endpoint,
    model,
    chatThinkingOff(endpoint, allowThinking),
  )
  return modelProfiles().get(key)?.toolsRejected ?? false
}

function wireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'assistant':
      return message.toolCalls?.length
        ? {
            role: 'assistant',
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : { role: 'assistant', content: message.content }
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      }
    default:
      return { role: message.role, content: message.content }
  }
}

const PARTIAL_THINK_TAG = /<(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?$/i

/**
 * The part of a growing answer that may be shown: inline `<think>` blocks
 * (closed or still open) are hidden, and a tag cut in half is held back.
 */
export function visibleAnswer(raw: string): string {
  const text = raw.replace(THINK_BLOCK, '').replace(OPEN_THINK, '').trimStart()
  return text.replace(PARTIAL_THINK_TAG, '')
}

type ToolCallDraft = { id: string; name: string; arguments: string }

type StreamChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown
      tool_calls?: Array<{
        index?: unknown
        id?: unknown
        function?: { name?: unknown; arguments?: unknown }
      }>
    }
    finish_reason?: unknown
  }>
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  error?: { message?: unknown } | string
}

type CompletionMessage = {
  content?: unknown
  tool_calls?: Array<{
    id?: unknown
    function?: { name?: unknown; arguments?: unknown }
  }>
}

function finishToolCalls(drafts: Map<number, ToolCallDraft>): ChatToolCall[] {
  return [...drafts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, draft]) => ({
      id: draft.id || `call_${index}`,
      name: draft.name,
      arguments: draft.arguments || '{}',
    }))
    .filter((call) => call.name)
}

/**
 * Reads an OpenAI-style server-sent event stream: text deltas (passed on
 * as they arrive, without inline thinking), tool call deltas joined by
 * index, the finish reason and usage. Each chunk restarts the idle timer.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onTextDelta?: (delta: string) => void
    onActivity?: () => void
    onUsage?: (prompt: number | null, completion: number | null) => void
  },
): Promise<ChatCompletion> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const drafts = new Map<number, ToolCallDraft>()
  let buffer = ''
  let raw = ''
  let shown = ''
  let finishReason: string | null = null
  let bytes = 0
  let done = false

  const handleData = (data: string) => {
    if (data === '[DONE]') {
      done = true
      return
    }
    let chunk: StreamChunk
    try {
      chunk = JSON.parse(data) as StreamChunk
    } catch {
      return
    }
    if (chunk.error) {
      const message =
        typeof chunk.error === 'string'
          ? chunk.error
          : typeof chunk.error.message === 'string'
            ? chunk.error.message
            : 'unknown error'
      throw new AiClientError(
        'http',
        `The AI endpoint reported an error: ${providerMessage(JSON.stringify({ error: message }))}`,
      )
    }
    if (chunk.usage)
      handlers.onUsage?.(
        tokenCount(chunk.usage.prompt_tokens),
        tokenCount(chunk.usage.completion_tokens),
      )
    const choice = chunk.choices?.[0]
    if (!choice) return
    if (typeof choice.finish_reason === 'string')
      finishReason = choice.finish_reason
    const delta = choice.delta
    if (!delta) return
    const content = messageText(delta.content)
    if (content) {
      raw += content
      const visible = visibleAnswer(raw)
      if (visible.length > shown.length && visible.startsWith(shown)) {
        handlers.onTextDelta?.(visible.slice(shown.length))
        shown = visible
      }
    }
    for (const part of delta.tool_calls ?? []) {
      const index = typeof part.index === 'number' ? part.index : drafts.size
      const draft = drafts.get(index) ?? { id: '', name: '', arguments: '' }
      if (typeof part.id === 'string' && part.id) draft.id = part.id
      if (typeof part.function?.name === 'string')
        draft.name += part.function.name
      if (typeof part.function?.arguments === 'string')
        draft.arguments += part.function.arguments
      drafts.set(index, draft)
    }
  }

  while (!done) {
    const { value, done: ended } = await reader.read()
    if (ended) break
    handlers.onActivity?.()
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new AiClientError(
        'invalid_response',
        'The AI endpoint sent a response that is too large.',
      )
    }
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) handleData(line.slice(5).trim())
      if (done) break
      newline = buffer.indexOf('\n')
    }
  }
  if (!done && buffer.startsWith('data:')) handleData(buffer.slice(5).trim())
  if (done) await reader.cancel().catch(() => {})
  const text = stripThinking(raw)
  // The rest of the answer the stream held back (a lone "<" at the end).
  if (text.length > shown.length && text.startsWith(shown))
    handlers.onTextDelta?.(text.slice(shown.length))
  return { text, toolCalls: finishToolCalls(drafts), finishReason }
}

function parseCompletion(body: string): {
  completion: ChatCompletion
  prompt: number | null
  completionTokens: number | null
} {
  let parsed: {
    choices?: Array<{ finish_reason?: unknown; message?: CompletionMessage }>
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  }
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new AiClientError(
      'invalid_response',
      'The AI endpoint sent a response BladeVault could not read.',
    )
  }
  const choice = parsed?.choices?.[0]
  const drafts = new Map<number, ToolCallDraft>()
  ;(choice?.message?.tool_calls ?? []).forEach((call, index) => {
    drafts.set(index, {
      id: typeof call.id === 'string' ? call.id : '',
      name: typeof call.function?.name === 'string' ? call.function.name : '',
      arguments:
        typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : call.function?.arguments
            ? JSON.stringify(call.function.arguments)
            : '',
    })
  })
  return {
    completion: {
      text: stripThinking(messageText(choice?.message?.content)),
      toolCalls: finishToolCalls(drafts),
      finishReason:
        typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    },
    prompt: tokenCount(parsed?.usage?.prompt_tokens),
    completionTokens: tokenCount(parsed?.usage?.completion_tokens),
  }
}

/**
 * One chat completion with the conversation so far and, optionally, tools
 * the model may call. Streams by default (text deltas go to `onTextDelta`)
 * and falls back to a plain request for endpoints that refuse streaming.
 * Counted against the budget of `purpose` and journaled like every call.
 *
 * Learned per model (in this process), like requestJsonCompletion: the
 * thinking switch, a lower answer ceiling, streaming support, and whether
 * the endpoint takes tools. A refused `tools` field throws
 * `tools_unsupported`, so the caller can switch to its JSON mode.
 */
export async function requestChatCompletion(
  endpoint: AiEndpoint,
  request: {
    model: string
    messages: ChatMessage[]
    tools?: ChatToolDefinition[]
    maxTokens?: number
    purpose: AiPurpose
    /** Let the model reason first (no thinking-off switch). */
    allowThinking?: boolean
  },
  options: {
    /** Time to the first byte, and the plain request's whole time. */
    timeoutMs: number
    /** Longest pause between streamed chunks. */
    idleTimeoutMs?: number
    signal?: AbortSignal
    fetchImpl?: FetchLike
    onTextDelta?: (delta: string) => void
  },
): Promise<ChatCompletion> {
  if (!request.model.trim())
    throw new AiClientError('config', 'Choose an AI model first.')
  const refusal = aiBudgetRefusal(request.purpose)
  if (refusal) throw new AiClientError('budget', refusal)
  const usage = newUsage()
  const report = callReporter(endpoint, request, usage)
  try {
    const result = await completeChat(endpoint, request, options, usage)
    report(null)
    return {
      ...result,
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
    }
  } catch (error) {
    report(error)
    throw error
  }
}

async function completeChat(
  endpoint: AiEndpoint,
  request: {
    model: string
    messages: ChatMessage[]
    tools?: ChatToolDefinition[]
    maxTokens?: number
    purpose: AiPurpose
    allowThinking?: boolean
  },
  options: {
    timeoutMs: number
    idleTimeoutMs?: number
    signal?: AbortSignal
    fetchImpl?: FetchLike
    onTextDelta?: (delta: string) => void
  },
  usage: CallUsage,
): Promise<ChatCompletion> {
  const url = endpointUrl(endpoint, '/chat/completions')
  const allowThinking = request.allowThinking ?? false
  const key = chatProfileKey(
    endpoint,
    request.model,
    chatThinkingOff(endpoint, allowThinking),
  )
  const profile = (): ModelProfile =>
    modelProfiles().get(key) ?? { reasoning: false }
  const learn = (patch: Partial<ModelProfile>) =>
    modelProfiles().set(key, { ...profile(), ...patch })
  const tools = request.tools?.length ? request.tools : null
  if (tools && profile().toolsRejected)
    throw new AiClientError(
      'tools_unsupported',
      'This AI endpoint does not take tools (function calling).',
    )
  const ceiling = () =>
    Math.min(
      endpoint.maxAnswerTokens ?? REASONING_MAX_TOKENS,
      profile().answerCap ?? Infinity,
    )
  const baseTokens = request.maxTokens ?? CHAT_ANSWER_TOKENS
  // A model that thinks first needs the endpoint's whole answer ceiling.
  const maxTokens = () =>
    profile().reasoning || allowThinking
      ? ceiling()
      : Math.min(baseTokens, ceiling())
  let capped = false
  let retriedEmpty = false

  for (let attempt = 0; attempt < 8; attempt++) {
    const stream = !profile().streamRejected
    const streamUsage = stream && !profile().streamUsageRejected
    const thinkingOff =
      chatThinkingOff(endpoint, allowThinking) && !profile().thinkingOffRejected
    const tokens = maxTokens()
    const payload: Record<string, unknown> = {
      model: request.model,
      temperature: 0,
      max_tokens: tokens,
      messages: request.messages.map(wireMessage),
    }
    if (tools) {
      payload.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
      payload.tool_choice = 'auto'
    }
    if (stream) payload.stream = true
    if (streamUsage) payload.stream_options = { include_usage: true }
    if (thinkingOff) payload.thinking = { type: 'disabled' }

    // The first byte must come within timeoutMs; a stream then only needs
    // to keep sending chunks.
    const idle = new AbortController()
    const idleMs = options.idleTimeoutMs ?? CHAT_IDLE_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => idle.abort(),
      Math.max(
        options.timeoutMs,
        profile().reasoning ? REASONING_MIN_TIMEOUT_MS : 0,
      ),
    )
    const restartTimer = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => idle.abort(), idleMs)
    }
    const signal = AbortSignal.any(
      options.signal
        ? [options.signal, idle.signal, powerSignal()]
        : [idle.signal, powerSignal()],
    )
    const context = {
      signal,
      callerSignal: options.signal,
      fetchImpl: options.fetchImpl,
      mark: clockMark(),
    }
    usage.attempts++
    let streamedText = false
    try {
      const response = await open(
        url,
        {
          method: 'POST',
          headers: headers(endpoint, true),
          body: JSON.stringify(payload),
        },
        context,
      )
      let result: ChatCompletion
      const eventStream =
        stream &&
        response.body &&
        (response.headers.get('content-type') ?? '').includes(
          'text/event-stream',
        )
      if (eventStream && response.body) {
        restartTimer()
        try {
          result = await readChatStream(response.body, {
            onActivity: restartTimer,
            onTextDelta: (delta) => {
              streamedText = true
              options.onTextDelta?.(delta)
            },
            onUsage: (prompt, completion) => {
              if (prompt !== null) usage.prompt = (usage.prompt ?? 0) + prompt
              if (completion !== null)
                usage.completion = (usage.completion ?? 0) + completion
            },
          })
        } catch (error) {
          if (error instanceof AiClientError) throw error
          if (options.signal?.aborted)
            throw new AiClientError(
              'cancelled',
              'The AI request was cancelled.',
            )
          if (sleptSince(context.mark)) throw suspendedError()
          throw new AiClientError(
            idle.signal.aborted ? 'timeout' : 'network',
            idle.signal.aborted
              ? 'The AI endpoint stopped sending its answer.'
              : 'The AI endpoint stopped answering.',
          )
        }
      } else {
        const parsed = parseCompletion(await readBody(response, context))
        if (parsed.prompt !== null)
          usage.prompt = (usage.prompt ?? 0) + parsed.prompt
        if (parsed.completionTokens !== null)
          usage.completion = (usage.completion ?? 0) + parsed.completionTokens
        result = parsed.completion
        if (result.text) {
          streamedText = true
          options.onTextDelta?.(result.text)
        }
      }
      if (!result.text && !result.toolCalls.length) {
        // A reasoning model used the whole budget on thinking: once more
        // with the endpoint's ceiling, and remember the model.
        if (!retriedEmpty && !options.signal?.aborted && tokens < ceiling()) {
          retriedEmpty = true
          learn({ reasoning: true })
          continue
        }
        throw new AiClientError(
          'invalid_response',
          result.finishReason === 'length'
            ? 'The AI answer was empty: the model used its whole answer budget on reasoning. Turn off "Let the model think" for chat, or choose a model without reasoning.'
            : 'The AI answer was empty.',
        )
      }
      return result
    } catch (error) {
      const refused =
        error instanceof AiClientError &&
        error.code === 'http' &&
        (error.status === 400 || error.status === 422) &&
        !streamedText
      if (refused && thinkingOff && /thinking/i.test(error.message)) {
        learn({ thinkingOffRejected: true })
        continue
      }
      if (
        refused &&
        !capped &&
        tokens > SAFE_ANSWER_TOKENS &&
        TOKEN_LIMIT_ERROR.test(error.message)
      ) {
        capped = true
        learn({ answerCap: SAFE_ANSWER_TOKENS })
        continue
      }
      if (refused && streamUsage && STREAM_USAGE_REFUSED.test(error.message)) {
        learn({ streamUsageRejected: true })
        continue
      }
      if (refused && stream && STREAM_REFUSED.test(error.message)) {
        learn({ streamRejected: true })
        continue
      }
      if (refused && tools && TOOLS_REFUSED.test(error.message)) {
        learn({ toolsRejected: true })
        throw new AiClientError(
          'tools_unsupported',
          'This AI endpoint does not take tools (function calling).',
        )
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
  throw new AiClientError('invalid_response', 'The AI request failed.')
}
