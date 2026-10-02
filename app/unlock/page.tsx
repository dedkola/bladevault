import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { isAppUnlocked } from '@/lib/app-lock'
import { APP_LOCK_COOKIE } from '@/lib/app-lock-shared'

export default async function UnlockPage() {
  if (isAppUnlocked((await cookies()).get(APP_LOCK_COOKIE)?.value))
    redirect('/')
  return null
}
