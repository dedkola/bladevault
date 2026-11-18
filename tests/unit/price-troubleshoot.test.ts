import { describe, expect, it } from 'vitest'
import {
  clampTroubleshootPlan,
  troubleshootAllowed,
  troubleshootCheck,
  type TroubleshootInput,
} from '@/lib/price-monitor/troubleshoot'
import { DEFAULT_PRICE_MONITORING } from '@/lib/settings-shared'

const NOW = Date.parse('2026-11-18T12:00:00.000Z')
const MINUTE = 60_000

const challenge: TroubleshootInput = {
  store: 'shop.example',
  errorCode: 'challenge',
  httpStatus: null,
  errorMessage: 'The store showed a bot check (CAPTCHA).',
  blocked: true,
  consecutiveFailures: 1,
  trigger: 'scheduled',
  fetchMode: 'auto',
  defaultRetryMinutes: 24 * 60,
  recent: [],
}

const settings = {
  ...DEFAULT_PRICE_MONITORING.ai,
  enabled: true,
  baseUrl: 'http://localhost:11434/v1',
  model: 'm',
}

describe('clampTroubleshootPlan', () => {
  it('applies a plan within the bounds', () => {
    const plan = clampTroubleshootPlan(
      {
        resetCookies: true,
        useBrowser: true,
        retryInMinutes: 48 * 60,
        pauseSource: false,
        explanation: '  Cloudflare   check;   waiting two days. ',
      },
      challenge,
      NOW,
    )
    expect(plan).toEqual({
      resetCookies: true,
      useBrowser: true,
      nextCheckAt: new Date(NOW + 48 * 60 * MINUTE).toISOString(),
      pauseSource: false,
      explanation: 'Cloudflare check; waiting two days.',
      adjustments: [],
    })
  })

  it('never retries a blocked store sooner than the backoff', () => {
    const plan = clampTroubleshootPlan(
      { retryInMinutes: 5, explanation: 'Try again soon.' },
      challenge,
      NOW,
    )
    expect(plan.nextCheckAt).toBe(
      new Date(NOW + 24 * 60 * MINUTE).toISOString(),
    )
    expect(plan.adjustments).toContain(
      'a blocked store is never retried sooner than the backoff',
    )
  })

  it('lets passing trouble retry sooner, but not within 10 minutes', () => {
    const timeout = {
      ...challenge,
      errorCode: 'timeout',
      blocked: false,
      defaultRetryMinutes: 600,
    }
    expect(
      clampTroubleshootPlan({ retryInMinutes: 30 }, timeout, NOW).nextCheckAt,
    ).toBe(new Date(NOW + 30 * MINUTE).toISOString())
    expect(
      clampTroubleshootPlan({ retryInMinutes: 1 }, timeout, NOW).nextCheckAt,
    ).toBe(new Date(NOW + 10 * MINUTE).toISOString())
    expect(
      clampTroubleshootPlan({ retryInMinutes: 99_999 }, timeout, NOW)
        .nextCheckAt,
    ).toBe(new Date(NOW + 7 * 24 * 60 * MINUTE).toISOString())
  })

  it('drops cookie resets without a block and browser pins the user chose against', () => {
    const plan = clampTroubleshootPlan(
      { resetCookies: true, useBrowser: true },
      { ...challenge, errorCode: 'timeout', blocked: false, fetchMode: 'http' },
      NOW,
    )
    expect(plan.resetCookies).toBe(false)
    expect(plan.useBrowser).toBe(false)
    expect(plan.adjustments).toHaveLength(2)
  })

  it('pauses a source only when its page is gone and keeps failing', () => {
    const gone = {
      ...challenge,
      errorCode: 'http',
      httpStatus: 404,
      blocked: false,
      consecutiveFailures: 2,
    }
    expect(
      clampTroubleshootPlan(
        { pauseSource: true, retryInMinutes: 60 },
        gone,
        NOW,
      ),
    ).toMatchObject({ pauseSource: true, nextCheckAt: null })
    expect(
      clampTroubleshootPlan(
        { pauseSource: true },
        { ...gone, consecutiveFailures: 1 },
        NOW,
      ).pauseSource,
    ).toBe(false)
    expect(
      clampTroubleshootPlan({ pauseSource: true }, challenge, NOW).pauseSource,
    ).toBe(false)
  })

  it('treats junk as no plan', () => {
    for (const junk of [null, 'pause', [1], { retryInMinutes: 'soon' }])
      expect(clampTroubleshootPlan(junk, challenge, NOW)).toMatchObject({
        resetCookies: false,
        useBrowser: false,
        nextCheckAt: null,
        pauseSource: false,
        explanation: '',
      })
  })
})

describe('troubleshootAllowed', () => {
  it('needs AI, the switch, a fixable code and the 24 h pause to be over', () => {
    const base = { settings, errorCode: 'challenge', lastAiAt: null, now: NOW }
    expect(troubleshootAllowed(base)).toBe(true)
    expect(
      troubleshootAllowed({
        ...base,
        settings: { ...settings, resolveErrors: false },
      }),
    ).toBe(false)
    expect(
      troubleshootAllowed({
        ...base,
        settings: { ...settings, enabled: false },
      }),
    ).toBe(false)
    for (const code of ['cancelled', 'invalid_url', 'blocked_url', 'browser'])
      expect(troubleshootAllowed({ ...base, errorCode: code })).toBe(false)
    expect(
      troubleshootAllowed({
        ...base,
        lastAiAt: new Date(NOW - 60 * MINUTE).toISOString(),
      }),
    ).toBe(false)
    expect(
      troubleshootAllowed({
        ...base,
        lastAiAt: new Date(NOW - 25 * 60 * MINUTE).toISOString(),
      }),
    ).toBe(true)
  })
})

describe('troubleshootCheck', () => {
  it('sends only the failure details and clamps the answer', async () => {
    let sent: { messages: Array<{ content: string }> } | null = null
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                resetCookies: true,
                useBrowser: false,
                retryInMinutes: 1,
                pauseSource: false,
                explanation: 'Bot check; cookies reset.',
              }),
            },
          },
        ],
      })
    }) as typeof fetch
    const plan = await troubleshootCheck({
      failure: challenge,
      endpoint: { baseUrl: settings.baseUrl, apiKey: null },
      model: 'm',
      now: NOW,
      fetchImpl,
    })
    expect(plan.resetCookies).toBe(true)
    expect(plan.nextCheckAt).toBe(
      new Date(NOW + 24 * 60 * MINUTE).toISOString(),
    )
    expect(JSON.parse(sent!.messages[1].content)).toEqual(challenge)
  })
})
