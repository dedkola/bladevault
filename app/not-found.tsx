import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-start gap-4 p-6 sm:p-10">
      <p className="text-sm font-medium text-muted-foreground">
        404 · Page not found
      </p>
      <h1 className="text-2xl font-semibold text-foreground">
        This page is unavailable
      </h1>
      <p className="text-muted-foreground">
        The link may be incorrect, or this record may have been removed from
        your vault.
      </p>
      <Link href="/collection" className={buttonVariants()}>
        Back to collection
      </Link>
    </div>
  )
}
