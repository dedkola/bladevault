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
}

export type AiErrorCode =
  'config' | 'network' | 'timeout' | 'cancelled' | 'http' | 'invalid_response'

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
 */
export const REASONING_MAX_TOKENS = 4096
const REASONING_MIN_TIMEOUT_MS = 60_000

type ChatChoice = {
  finish_reason?: unknown
  message?: {
    content?: unknown
    reasoning_content?: unknown
    reasoning?: unknown
  }
}

/** The model stopped at the token limit or spent the answer on reasoning. */
function ranOutOnReasoning(choice: ChatChoice | undefined): boolean {
  const reasoning =
    messageText(choice?.message?.reasoning_content) ||
    messageText(choice?.message?.reasoning)
  return choice?.finish_reason === 'length' || reasoning.trim().length > 0
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
  const trimmed = text
    .trim()
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

/**
 * One chat completion that must answer with JSON. Asks for a strict JSON
 * schema first and falls back to `json_object`, then to plain prompting,
 * for endpoints that reject the response format.
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
  },
  options: { timeoutMs: number; signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<unknown> {
  if (!request.model.trim())
    throw new AiClientError('config', 'Choose an AI model first.')
  const url = endpointUrl(endpoint, '/chat/completions')
  const formats: ResponseFormat[] = ['json_schema', 'json_object', 'none']
  const baseTokens = request.maxTokens ?? 400
  let maxTokens = baseTokens
  let timeoutMs = options.timeoutMs
  let lastError: unknown = null
  for (let index = 0; index < formats.length; index++) {
    const format = formats[index]
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
      throw error
    }
    let parsed: { choices?: ChatChoice[] }
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new AiClientError(
        'invalid_response',
        'The AI endpoint sent a response BladeVault could not read.',
      )
    }
    const choice = parsed?.choices?.[0]
    const text = messageText(choice?.message?.content)
    if (!text.trim()) {
      if (maxTokens < REASONING_MAX_TOKENS) {
        // Same format again, with room for the model's reasoning.
        maxTokens = Math.max(baseTokens, REASONING_MAX_TOKENS)
        timeoutMs = Math.max(options.timeoutMs, REASONING_MIN_TIMEOUT_MS)
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
    return parseJsonAnswer(text)
  }
  throw lastError instanceof Error
    ? lastError
    : new AiClientError('invalid_response', 'The AI request failed.')
}
