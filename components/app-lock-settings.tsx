'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection, SettingsRow } from '@/components/settings-panels'
import type { AppLockStatus } from '@/lib/app-lock-shared'
import './settings-view.css'

export function AppLockSettings() {
  const [status, setStatus] = useState<AppLockStatus | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    fetch('/api/app-lock', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load App lock settings.')
        const data: AppLockStatus = await response.json()
        if (active) {
          setStatus(data)
          setError('')
        }
      })
      .catch(() => {
        if (active) setError('Could not load App lock settings.')
      })
    return () => {
      active = false
    }
  }, [attempt])

  async function update(action: 'set-password' | 'disable' | 'lock') {
    if (!status) return
    setError('')
    setMessage('')
    if (action !== 'lock' && status.enabled && !currentPassword) {
      setError('Enter your current password.')
      return
    }
    if (action === 'set-password' && password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setPending(true)
    try {
      const response = await fetch('/api/app-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          currentPassword,
          password,
          confirmPassword,
        }),
      })
      const data = await response.json()
      if (!response.ok)
        throw new Error(data.error || 'Could not update App lock.')
      if (action === 'lock') {
        window.location.replace('/unlock')
        return
      }
      setMessage(
        action === 'disable'
          ? 'App lock disabled.'
          : status.enabled
            ? 'Password changed.'
            : 'App lock enabled. Your next session will require the password.',
      )
      setStatus(data)
      setCurrentPassword('')
      setPassword('')
      setConfirmPassword('')
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not update App lock.',
      )
    } finally {
      setPending(false)
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void update('set-password')
  }

  return (
    <div className="settings-grid">
      <SettingsSection title="App lock">
        <SettingsRow label="Password required">
          <span className="text-sm text-muted-foreground">
            {status ? (status.enabled ? 'Enabled' : 'Disabled') : 'Loading…'}
          </span>
          {status?.enabled && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void update('lock')}
            >
              Lock now
            </Button>
          )}
        </SettingsRow>
        {status && (
          <form onSubmit={save} className="space-y-4 py-4">
            {status.enabled && (
              <div className="max-w-sm space-y-2">
                <label
                  htmlFor="lock-current-password"
                  className="text-sm font-medium"
                >
                  Current password
                </label>
                <Input
                  id="lock-current-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  disabled={pending}
                />
              </div>
            )}
            <div className="max-w-sm space-y-2">
              <label
                htmlFor="lock-new-password"
                className="text-sm font-medium"
              >
                {status.enabled ? 'New password' : 'Password'}
              </label>
              <Input
                id="lock-new-password"
                type="password"
                autoComplete="new-password"
                required
                maxLength={1024}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={pending}
              />
            </div>
            <div className="max-w-sm space-y-2">
              <label
                htmlFor="lock-confirm-password"
                className="text-sm font-medium"
              >
                Confirm password
              </label>
              <Input
                id="lock-confirm-password"
                type="password"
                autoComplete="new-password"
                required
                maxLength={1024}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={pending}
              />
            </div>
            <div className="flex flex-wrap gap-2 border-t border-[var(--bladevault-line)] pt-4">
              <Button type="submit" disabled={pending}>
                {pending
                  ? 'Saving…'
                  : status.enabled
                    ? 'Change password'
                    : 'Enable App lock'}
              </Button>
              {status.enabled && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void update('disable')}
                >
                  Disable lock
                </Button>
              )}
            </div>
          </form>
        )}
      </SettingsSection>
      {error && (
        <div role="alert" className="text-sm text-destructive">
          {error}
          {!status && (
            <Button
              variant="outline"
              className="ml-3"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  )
}
