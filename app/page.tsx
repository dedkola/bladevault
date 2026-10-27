import { redirect } from 'next/navigation'
import { getSettings } from '@/lib/settings'

export default function Page() {
  redirect(`/${getSettings().startPage}`)
}
