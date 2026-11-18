'use client'

import { useSyncExternalStore, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SettingsRow, SettingsSection } from '@/components/settings-panels'

type Result =
  | { tone: 'success'; message: string; detail?: string }
  | { tone: 'error'; message: string }

const subscribe = () => () => {}

// Desktop-only: adds BladeVault's stdio bridge to Claude Desktop's config file,
// since Claude Desktop starts local servers and ignores URL-only entries.
export function ClaudeDesktopMcpSettings({
  buttonClassName,
}: {
  buttonClassName?: string
}) {
  const available = useSyncExternalStore(
    subscribe,
    () => Boolean(window.bladevaultDesktop?.claudeDesktop),
    () => false,
  )
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  if (!available) return null

  async function handleConnect() {
    const bridge = window.bladevaultDesktop?.claudeDesktop
    if (!bridge) return
    setPending(true)
    setResult(null)
    try {
      const outcome = await bridge.connect()
      if (!outcome.ok) {
        setResult({ tone: 'error', message: outcome.error })
        return
      }
      setResult({
        tone: 'success',
        message: outcome.changed
          ? 'Added to Claude Desktop. Quit Claude Desktop completely (⌘Q on Mac) and reopen it.'
          : 'Claude Desktop is already set up. If BladeVault is missing there, quit Claude Desktop completely and reopen it.',
        detail: outcome.backupPath
          ? `Previous config saved as ${outcome.backupPath}`
          : undefined,
      })
    } catch {
      setResult({
        tone: 'error',
        message: "Could not update Claude Desktop's config file.",
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsSection title="Claude Desktop">
      <SettingsRow
        label="Connect to Claude Desktop"
        description="Adds BladeVault to Claude Desktop's local MCP servers and keeps its other servers. Keep BladeVault open while Claude uses it."
      >
        <Button
          type="button"
          variant="outline"
          className={cn(buttonClassName, 'rounded-lg')}
          onClick={() => void handleConnect()}
          disabled={pending}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Plug />}
          Connect
        </Button>
      </SettingsRow>
      {result ? (
        <div
          role={result.tone === 'error' ? 'alert' : 'status'}
          className={
            result.tone === 'error'
              ? 'flex items-start gap-1.5 py-2 text-xs text-destructive'
              : 'flex items-start gap-1.5 py-2 text-xs text-[var(--bladevault-local)] dark:text-[var(--bladevault-gold)]'
          }
        >
          {result.tone === 'error' ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 break-words">
            {result.message}
            {result.tone === 'success' && result.detail ? (
              <span className="block text-muted-foreground">
                {result.detail}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
    </SettingsSection>
  )
}
