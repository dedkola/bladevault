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

function combinedSignal(timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

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

async function send(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<string> {
  const signal = combinedSignal(options.timeoutMs, options.signal)
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
    if (options.signal?.aborted)
      throw new AiClientError('cancelled', 'The AI request was cancelled.')
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
    throw new AiClientError(
      'network',
      `Could not reach the AI endpoint${reason ? ` (${reason})` : ''}.`,
    )
  }
  let body: string
  try {
    body = await response.text()
  } catch {
    throw new AiClientError(
      signal.aborted ? 'timeout' : 'network',
      'The AI endpoint stopped answering.',
    )
  }
  if (body.length > MAX_RESPONSE_BYTES)
    throw new AiClientError(
      'invalid_response',
      'The AI endpoint sent a response that is too large.',
    )
  if (!response.ok) {
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
  return body
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
  | 'test'

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

function profileKey(endpoint: AiEndpoint, model: string): string {
  return `${normalizeAiBaseUrl(endpoint.baseUrl) ?? endpoint.baseUrl}\n${model}`
}

/** Whether this model is known (in this process) to reason before answering. */
export function isReasoningModel(endpoint: AiEndpoint, model: string): boolean {
  return modelProfiles().get(profileKey(endpoint, model))?.reasoning ?? false
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
  const startedAt = Date.now()
  const usage = {
    prompt: null as number | null,
    completion: null as number | null,
    attempts: 0,
  }
  const report = (error: unknown) => {
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
        reasoning: isReasoningModel(endpoint, request.model),
      })
    } catch {
      // The journal never breaks a request.
    }
  }
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
  },
  options: { timeoutMs: number; signal?: AbortSignal; fetchImpl?: FetchLike },
  usage: { prompt: number | null; completion: number | null; attempts: number },
): Promise<unknown> {
  const url = endpointUrl(endpoint, '/chat/completions')
  const formats: ResponseFormat[] = ['json_schema', 'json_object', 'none']
  const key = profileKey(endpoint, request.model)
  const baseTokens = request.maxTokens ?? 400
  const profile = (): ModelProfile =>
    modelProfiles().get(key) ?? { reasoning: false }
  let retried = false
  let capped = false
  const learnReasoning = () => {
    modelProfiles().set(key, { ...profile(), reasoning: true })
  }
  /** The answer ceiling for this model: settings, lowered if refused. */
  const ceiling = () =>
    Math.min(
      endpoint.maxAnswerTokens ?? REASONING_MAX_TOKENS,
      profile().answerCap ?? Infinity,
    )
  const budget = () =>
    profile().reasoning
      ? {
          maxTokens: Math.max(baseTokens, ceiling()),
          timeoutMs: Math.max(options.timeoutMs, REASONING_MIN_TIMEOUT_MS),
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
