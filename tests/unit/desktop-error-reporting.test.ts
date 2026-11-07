import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const loadCommonJs = createRequire(import.meta.url)
const errorReporting = loadCommonJs('../../electron/error-reporting.cjs')

const DESKTOP_DSN = 'https://desktop@o1.ingest.de.sentry.io/1'
const APP_DSN = 'https://app@o1.ingest.de.sentry.io/2'
const RELEASE_PACKAGE = {
  bladevaultErrorReporting: { desktopDsn: DESKTOP_DSN, appDsn: APP_DSN },
}

const tempDirs: string[] = []
function makeUserDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-consent-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('desktop error reporting consent', () => {
  it('defaults to off when no choice is stored', () => {
    expect(errorReporting.readConsent(makeUserDataDir())).toBe(false)
  })

  it('stores and reads the choice', () => {
    const dir = makeUserDataDir()
    expect(errorReporting.writeConsent(dir, true)).toBe(true)
    expect(errorReporting.readConsent(dir)).toBe(true)
    errorReporting.writeConsent(dir, false)
    expect(errorReporting.readConsent(dir)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([errorReporting.CONSENT_FILE])
  })

  it('treats a corrupt consent file as off', () => {
    const dir = makeUserDataDir()
    fs.writeFileSync(path.join(dir, errorReporting.CONSENT_FILE), '{nope')
    expect(errorReporting.readConsent(dir)).toBe(false)
  })
})

describe('desktop error reporting availability', () => {
  it('is available only in packaged release builds with both DSNs', () => {
    const dir = makeUserDataDir()
    const base = { userDataDir: dir, isPackaged: true, smokeTest: false }

    expect(
      errorReporting.getErrorReportingState({
        ...base,
        packageJson: RELEASE_PACKAGE,
      }).available,
    ).toBe(true)
    expect(
      errorReporting.getErrorReportingState({ ...base, packageJson: {} })
        .available,
    ).toBe(false)
    expect(
      errorReporting.getErrorReportingState({
        ...base,
        packageJson: {
          bladevaultErrorReporting: { desktopDsn: DESKTOP_DSN, appDsn: '' },
        },
      }).available,
    ).toBe(false)
    expect(
      errorReporting.getErrorReportingState({
        ...base,
        isPackaged: false,
        packageJson: RELEASE_PACKAGE,
      }).available,
    ).toBe(false)
    expect(
      errorReporting.getErrorReportingState({
        ...base,
        smokeTest: true,
        packageJson: RELEASE_PACKAGE,
      }).available,
    ).toBe(false)
  })

  it('enables reporting only after the user opts in', () => {
    const dir = makeUserDataDir()
    const options = {
      userDataDir: dir,
      packageJson: RELEASE_PACKAGE,
      isPackaged: true,
      smokeTest: false,
    }

    const before = errorReporting.getErrorReportingState(options)
    expect(before.enabled).toBe(false)
    expect(errorReporting.getEmbeddedServerEnv(before)).toEqual({
      SENTRY_DSN: '',
    })

    errorReporting.writeConsent(dir, true)
    const after = errorReporting.getErrorReportingState(options)
    expect(after.enabled).toBe(true)
    expect(errorReporting.getEmbeddedServerEnv(after)).toEqual({
      SENTRY_DSN: APP_DSN,
      SENTRY_ENVIRONMENT: 'production',
    })
  })
})

describe('desktop Sentry options', () => {
  it('excludes integrations that reach into the app window', () => {
    const options = errorReporting.getSentryOptions(
      { desktopDsn: DESKTOP_DSN },
      { release: 'bladevault@2.1.0', homeDir: '/Users/kola' },
    )
    const kept = options
      .integrations([
        { name: 'SentryMinidump' },
        { name: 'PreloadInjection' },
        { name: 'Screenshots' },
        { name: 'RendererEventLoopBlock' },
        { name: 'MainProcessSession' },
      ])
      .map((integration: { name: string }) => integration.name)

    expect(kept).toEqual(['SentryMinidump', 'MainProcessSession'])
    expect(options.dsn).toBe(DESKTOP_DSN)
    expect(options.attachScreenshot).toBe(false)
    expect(options.dataCollection.httpHeaders).toBe(false)
  })

  it('scrubs paths, tokens, and request details from events', () => {
    const event = errorReporting.scrubEvent(
      {
        user: { ip_address: '10.0.0.1' },
        server_name: 'Kolas-MacBook',
        request: {
          url: 'https://auth.bladevault.pro/token?code=abc',
          headers: { cookie: 'x' },
        },
        exception: {
          values: [
            {
              value: 'EACCES C:\\Users\\Kola\\BladeVault token=secret',
              stacktrace: {
                frames: [
                  { filename: 'c:/users/kola/app/main.cjs', vars: { a: 1 } },
                ],
              },
            },
          ],
        },
        breadcrumbs: [
          {
            category: 'electron.net',
            data: { url: 'https://example.com/a?x=1', body: 'secret' },
          },
        ],
      },
      'C:\\Users\\Kola',
    )

    expect(event.user).toBeUndefined()
    expect(event.server_name).toBeUndefined()
    expect(event.request).toEqual({
      url: 'https://auth.bladevault.pro/token',
    })
    expect(event.exception.values[0].value).toBe(
      'EACCES ~\\BladeVault token=[redacted]',
    )
    expect(event.exception.values[0].stacktrace.frames[0]).toEqual({
      filename: '~/app/main.cjs',
    })
    expect(event.breadcrumbs[0].data).toEqual({
      url: 'https://example.com/a',
    })
  })
})
