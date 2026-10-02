export const APP_LOCK_COOKIE = 'bladevault_unlock'
export const APP_LOCK_HEADER = 'x-bladevault-locked'

export type AppLockStatus = { enabled: boolean; unlocked: boolean }

export function getUnlockDestination(value: string | null): string {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  )
    return '/'
  const url = new URL(value, 'http://bladevault.local')
  if (url.origin !== 'http://bladevault.local' || url.pathname === '/unlock')
    return '/'
  return `${url.pathname}${url.search}${url.hash}`
}
