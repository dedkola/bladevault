'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

export function InsightDetailShell({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: string
  description?: string
  children: React.ReactNode
}) {
  const { knives, isLoading } = useKnives()

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 p-6 lg:p-8">
      <Button
        variant="outline"
        size="sm"
        render={<Link href="/" />}
        nativeButton={false}
      >
        <ArrowLeft className="size-4" /> Back to insights
      </Button>

      <header className="mt-6 mb-6">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--bladevault-title)]">
          {eyebrow}
        </span>
        <h1 className="mt-1 text-4xl font-medium tracking-[-0.04em] text-[var(--bladevault-title)] sm:text-5xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </header>

      {isLoading ? (
        <div className="h-96 animate-pulse rounded-xl bg-muted" />
      ) : knives.length === 0 ? (
        <Card className="border-dashed bg-muted/40">
          <CardContent className="flex flex-col items-center py-16 text-center">
            <h2 className="font-medium">No collection data yet</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Add your first knife to start revealing this insight.
            </p>
            <Button
              className="mt-5"
              render={<Link href="/add" />}
              nativeButton={false}
            >
              Add your first knife
            </Button>
          </CardContent>
        </Card>
      ) : (
        children
      )}
    </div>
  )
}
