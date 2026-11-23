import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'
import { captureAppLockAccessSnapshot } from '@/lib/app-lock'
import { getLocalDb } from '@/lib/local-db'
import { saveSettings } from '@/lib/settings'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null
afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('opening the app root', () => {
  it('redirects to the start page before any page renders', async () => {
    vault = await createTempVault('bladevault-start-page-redirect-')
    getLocalDb()
    captureAppLockAccessSnapshot()
    saveSettings({ startPage: 'collection' })

    const response = proxy(
      new NextRequest('http://127.0.0.1:5501/', {
        headers: { host: '127.0.0.1:5501' },
      }),
    )!
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://127.0.0.1:5501/collection',
    )

    const page = proxy(new NextRequest('http://127.0.0.1:5501/insights'))!
    expect(page.status).toBe(200)
  })
})
