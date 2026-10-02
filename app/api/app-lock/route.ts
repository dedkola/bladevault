import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  appLockPasswordMatches,
  createAppUnlockToken,
  getAppLockStatus,
  requireAppUnlock,
  setAppLockPassword,
} from '@/lib/app-lock'
import { APP_LOCK_COOKIE } from '@/lib/app-lock-shared'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('unlock'), password: z.string().max(1024) }),
  z.object({ action: z.literal('lock') }),
  z.object({
    action: z.literal('set-password'),
    currentPassword: z.string().max(1024).optional(),
    password: z.string().min(1, 'Enter a password.').max(1024),
    confirmPassword: z.string().max(1024),
  }),
  z.object({
    action: z.literal('disable'),
    currentPassword: z.string().max(1024),
  }),
])

export async function GET(request: Request) {
  return NextResponse.json(getAppLockStatus(request), {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host') || new URL(request.url).host
  if (origin && new URL(origin).host !== host)
    return NextResponse.json(
      { error: 'Invalid request origin.' },
      { status: 403 },
    )
  const parsed = inputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Enter a password and valid action.' },
      { status: 400 },
    )
  const input = parsed.data
  const status = getAppLockStatus(request)

  if (input.action === 'unlock') {
    if (status.enabled && !appLockPasswordMatches(input.password))
      return NextResponse.json(
        { error: 'Incorrect password.' },
        { status: 401 },
      )
  } else {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    if (input.action === 'set-password' || input.action === 'disable') {
      if (
        status.enabled &&
        !appLockPasswordMatches(input.currentPassword || '')
      )
        return NextResponse.json(
          { error: 'Incorrect current password.' },
          { status: 401 },
        )
      if (
        input.action === 'set-password' &&
        input.password !== input.confirmPassword
      )
        return NextResponse.json(
          { error: 'Passwords do not match.' },
          { status: 400 },
        )
      setAppLockPassword(input.action === 'disable' ? '' : input.password)
    }
  }

  const enabled =
    input.action === 'disable'
      ? false
      : input.action === 'set-password'
        ? true
        : status.enabled
  const unlocked = input.action !== 'lock'
  const response = NextResponse.json(
    { enabled, unlocked },
    { headers: { 'Cache-Control': 'no-store' } },
  )
  response.cookies.set(
    APP_LOCK_COOKIE,
    enabled && unlocked ? createAppUnlockToken() : '',
    {
      httpOnly: true,
      sameSite: 'strict',
      secure:
        (origin ? new URL(origin) : new URL(request.url)).protocol === 'https:',
      path: '/',
      ...(!enabled || !unlocked ? { maxAge: 0 } : {}),
    },
  )
  return response
}
