'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

const panelClassName =
  'overflow-hidden rounded-xl border border-[var(--bladevault-line)] bg-background shadow-none'

const headerClassName =
  'border-b border-[var(--bladevault-line)] bg-background px-4 py-2.5 dark:border-[#d3c097]/30'

const rowClassName =
  'flex flex-col gap-2 border-b border-[var(--bladevault-line)]/60 py-3 last:border-b-0 xl:flex-row xl:items-center xl:justify-between xl:gap-4'

export function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn(panelClassName, className)}>
      {title || description ? (
        <div className={headerClassName}>
          <div>
            {title ? (
              <div className="text-sm font-medium text-foreground">{title}</div>
            ) : null}
            {description ? (
              <div className="text-xs text-muted-foreground">{description}</div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="px-4">{children}</div>
    </div>
  )
}

export function SettingsRow({
  label,
  description,
  children,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn(rowClassName, className)}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children ? (
        <div className="flex min-w-0 items-center gap-2 xl:shrink-0 xl:justify-end">
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function MonoValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="break-all rounded-md border border-[var(--bladevault-line)] bg-background px-2 py-1 font-mono text-xs text-foreground">
      {children}
    </div>
  )
}
