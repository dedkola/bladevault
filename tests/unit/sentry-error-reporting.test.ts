import type { ErrorEvent } from '@sentry/nextjs'
import { describe, expect, it } from 'vitest'
import {
  getErrorReportingConfig,
  getErrorReportingMode,
  getErrorReportingRuntime,
  isErrorReportingAllowed,
} from '@/lib/sentry/server'
import { setErrorReportingConsentGranted } from '@/lib/sentry/consent-state'
import {
  parseErrorReportingConfig,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  stripUrlQuery,
} from '@/lib/sentry/shared'

const DSN = 'https://public@o1.ingest.sentry.io/2'

describe('error reporting config', () => {
  it('stays off without a DSN', () => {
    expect(getErrorReportingConfig({})).toBeNull()
    expect(getErrorReportingConfig({ SENTRY_DSN: '' })).toBeNull()
    expect(getErrorReportingConfig({ SENTRY_DSN: '  ' })).toBeNull()
    expect(getErrorReportingConfig({ SENTRY_DSN: 'not-a-dsn' })).toBeNull()
  })

  it('reads the DSN, environment, and runtime', () => {
    expect(
      getErrorReportingConfig({
        SENTRY_DSN: ` ${DSN} `,
        BLADEVAULT_DOCKER_RUNTIME: '1',
      }),
    ).toEqual({ dsn: DSN, environment: 'production', runtime: 'docker' })

    expect(
      getErrorReportingConfig({
        SENTRY_DSN: DSN,
        SENTRY_ENVIRONMENT: 'staging',
      }),
    ).toEqual({ dsn: DSN, environment: 'staging', runtime: 'server' })
  })

  it('prefers the desktop runtime label', () => {
    expect(
      getErrorReportingRuntime({
        BLADEVAULT_DESKTOP_RUNTIME: '1',
        BLADEVAULT_DOCKER_RUNTIME: '1',
      }),
    ).toBe('desktop')
  })

  it('round-trips the config passed to the browser', () => {
    const config = { dsn: DSN, environment: 'production', runtime: 'docker' }
    expect(parseErrorReportingConfig(JSON.stringify(config))).toEqual(config)
  })

  it('rejects malformed browser config', () => {
    expect(parseErrorReportingConfig(null)).toBeNull()
    expect(parseErrorReportingConfig('{')).toBeNull()
    expect(
      parseErrorReportingConfig(
        JSON.stringify({ dsn: DSN, environment: 'x', runtime: 'other' }),
      ),
    ).toBeNull()
    expect(
      parseErrorReportingConfig(
        JSON.stringify({
          dsn: 'javascript:alert(1)',
          environment: 'x',
          runtime: 'docker',
        }),
      ),
    ).toBeNull()
  })
})

describe('error reporting modes', () => {
  const DEFAULT_DSN = 'https://default@o1.ingest.de.sentry.io/9'
  const docker = {
    BLADEVAULT_DOCKER_RUNTIME: '1',
    BLADEVAULT_DEFAULT_SENTRY_DSN: DEFAULT_DSN,
  }

  it('asks for consent in the official Docker image', () => {
    expect(getErrorReportingMode(docker)).toBe('consent')
    expect(getErrorReportingConfig(docker)).toEqual({
      dsn: DEFAULT_DSN,
      environment: 'production',
      runtime: 'docker',
    })
  })

  it('lets an operator DSN replace the default without asking', () => {
    const env = { ...docker, SENTRY_DSN: DSN }
    expect(getErrorReportingMode(env)).toBe('managed')
    expect(getErrorReportingConfig(env)?.dsn).toBe(DSN)
    expect(isErrorReportingAllowed(env)).toBe(true)
  })

  it('turns off with BLADEVAULT_ERROR_REPORTING=off', () => {
    const env = { ...docker, BLADEVAULT_ERROR_REPORTING: 'OFF' }
    expect(getErrorReportingMode(env)).toBe('off')
    expect(getErrorReportingConfig(env)).toBeNull()
  })

  it('ignores the default DSN outside Docker', () => {
    expect(
      getErrorReportingMode({ BLADEVAULT_DEFAULT_SENTRY_DSN: DEFAULT_DSN }),
    ).toBe('off')
    expect(
      getErrorReportingMode({
        BLADEVAULT_DESKTOP_RUNTIME: '1',
        BLADEVAULT_DEFAULT_SENTRY_DSN: DEFAULT_DSN,
        SENTRY_DSN: '',
      }),
    ).toBe('off')
  })

  it('sends in consent mode only after a yes', () => {
    setErrorReportingConsentGranted(false)
    expect(isErrorReportingAllowed(docker)).toBe(false)
    setErrorReportingConsentGranted(true)
    expect(isErrorReportingAllowed(docker)).toBe(true)
    setErrorReportingConsentGranted(false)
  })
})

describe('error report scrubbing', () => {
  it('redacts tokens, emails, and the home folder', () => {
    const text = scrubText(
      'Failed for kola@example.com at /Users/kola/BladeVault/data with Bearer abc.def-123 ' +
        'and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl?token=secret123&id=7',
      '/Users/kola',
    )

    expect(text).not.toContain('kola@example.com')
    expect(text).not.toContain('/Users/kola')
    expect(text).not.toContain('abc.def-123')
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(text).not.toContain('secret123')
    expect(text).toContain('~/BladeVault/data')
    expect(text).toContain('id=7')
  })

  it('handles Windows home folders with either slash', () => {
    const home = 'C:\\Users\\Kola'
    expect(scrubText('C:\\Users\\Kola\\BladeVault', home)).toBe('~\\BladeVault')
    expect(scrubText('c:/users/kola/BladeVault', home)).toBe('~/BladeVault')
  })

  it('strips URL queries and fragments', () => {
    expect(stripUrlQuery('http://127.0.0.1:3000/api/x?token=1#y')).toBe(
      'http://127.0.0.1:3000/api/x',
    )
    expect(stripUrlQuery('/api/knives')).toBe('/api/knives')
  })

  it('removes request details, user data, and frame variables', () => {
    const event = {
      type: undefined,
      server_name: 'Kolas-MacBook',
      user: { email: 'kola@example.com', ip_address: '10.0.0.1' },
      request: {
        method: 'POST',
        url: 'http://localhost:5500/api/knives?session=abc',
        headers: { authorization: 'Bearer abc', cookie: 'bladevault=1' },
        cookies: { bladevault: '1' },
        data: '{"name":"Secret knife"}',
        query_string: 'session=abc',
      },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'ENOENT: /Users/kola/BladeVault/data/bladevault.sqlite',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/kola/app/lib/local-db.ts',
                  abs_path: '/Users/kola/app/lib/local-db.ts',
                  vars: { password: 'hunter2' },
                },
              ],
            },
          },
        ],
      },
      extra: { nested: { note: 'mail kola@example.com' } },
      breadcrumbs: [
        {
          category: 'fetch',
          data: {
            method: 'GET',
            url: '/api/cloud-backup?accessToken=abc',
            status_code: 500,
            body: '{"secret":true}',
          },
        },
      ],
    } as unknown as ErrorEvent

    const result = scrubEvent(event, '/Users/kola')

    expect(result.user).toBeUndefined()
    expect(result.server_name).toBeUndefined()
    expect(result.request).toEqual({
      method: 'POST',
      url: 'http://localhost:5500/api/knives',
    })

    const exception = result.exception?.values?.[0]
    expect(exception?.value).toBe('ENOENT: ~/BladeVault/data/bladevault.sqlite')
    const frame = exception?.stacktrace?.frames?.[0]
    expect(frame?.vars).toBeUndefined()
    expect(frame?.filename).toBe('~/app/lib/local-db.ts')

    expect(JSON.stringify(result.extra)).not.toContain('kola@example.com')
    expect(result.breadcrumbs?.[0]?.data).toEqual({
      method: 'GET',
      url: '/api/cloud-backup',
      status_code: 500,
    })
  })

  it('drops console arguments from breadcrumbs', () => {
    expect(
      scrubBreadcrumb({
        category: 'console',
        message: 'token=abc',
        data: { arguments: ['secret'], logger: 'console' },
      }),
    ).toEqual({ category: 'console', message: 'token=[redacted]', data: {} })
  })
})
