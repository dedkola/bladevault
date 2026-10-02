'use client'

import { useState, type FormEvent } from 'react'
import { Lock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getUnlockDestination } from '@/lib/app-lock-shared'

export function AppUnlockForm() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    try {
      const response = await fetch('/api/app-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unlock', password }),
      })
      const data = await response.json()
      if (!response.ok)
        throw new Error(data.error || 'Could not unlock BladeVault.')
      const url = new URL(window.location.href)
      window.location.replace(
        getUnlockDestination(
          url.pathname === '/unlock'
            ? url.searchParams.get('next')
            : `${url.pathname}${url.search}${url.hash}`,
        ),
      )
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not unlock BladeVault.',
      )
      setPending(false)
    }
  }

  return (
    <main className="flex min-h-dvh w-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-[var(--bladevault-line)] bg-background p-6 sm:p-8">
        <Lock
          className="mb-5 h-6 w-6 text-muted-foreground"
          aria-hidden="true"
        />
        <h1 className="text-xl font-semibold tracking-tight">
          Unlock BladeVault
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter your password to open your collection.
        </p>
        <form onSubmit={unlock} className="mt-6 space-y-4">
          <div className="space-y-2">
            <label htmlFor="unlock-password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="unlock-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              maxLength={1024}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
              aria-describedby={error ? 'unlock-error' : undefined}
            />
          </div>
          {error && (
            <p
              id="unlock-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending} className="w-full">
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {pending ? 'Unlocking…' : 'Unlock'}
          </Button>
        </form>
      </div>
    </main>
  )
}
