'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import './insight-detail.css'

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
    <div className="insight-detail">
      <Button
        variant="outline"
        size="sm"
        render={<Link href="/" />}
        nativeButton={false}
      >
        <ArrowLeft className="size-4" /> Back to insights
      </Button>
      <header className="id-page-head">
        <div>
          <span className="id-eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {!isLoading && knives.length > 0 && (
          <span className="id-collection-count">
            {knives.length} {knives.length === 1 ? 'knife' : 'knives'} in
            collection
          </span>
        )}
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
