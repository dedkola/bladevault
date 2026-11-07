'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import './globals.css'

// Replaces the root layout when it fails to render. Reports the error only
// when the server enabled error reporting (see instrumentation-client.ts).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body className="bg-background text-foreground min-h-dvh font-sans">
        <main className="mx-auto flex w-full max-w-xl flex-col items-start gap-4 p-6 sm:p-10">
          <p className="text-muted-foreground text-sm font-medium">
            Unexpected error
          </p>
          <h1 className="text-foreground text-2xl font-semibold">
            BladeVault could not load this page
          </h1>
          <p className="text-muted-foreground">
            Your collection is stored locally and was not changed. Try again, or
            restart BladeVault if the problem continues.
          </p>
          <Button onClick={reset}>Try again</Button>
        </main>
      </body>
    </html>
  )
}
