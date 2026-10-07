'use client'

import Image from 'next/image'
import Link from 'next/link'
import { ChevronRight, ImageIcon } from 'lucide-react'
import { categoryHref } from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { type CategoryKey, type CategoryStat } from '@/lib/collection-stats'
import { getImageUrl, type Knife } from '@/lib/data'
import { cn } from '@/lib/utils'

export function InsightPanel({
  title,
  description,
  children,
  footer,
  className,
  id,
  ariaLabel,
}: {
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
  id?: string
  ariaLabel?: string
}) {
  return (
    <section
      id={id}
      aria-label={ariaLabel ?? title}
      className={cn('id-panel', className)}
    >
      <div className="id-panel-head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div className="id-panel-body">{children}</div>
      {footer && <div className="id-panel-foot">{footer}</div>}
    </section>
  )
}

export function InsightMetrics({
  items,
}: {
  items: Array<{ value: React.ReactNode; label: string; helper?: string }>
}) {
  return (
    <dl className="id-metrics">
      {items.map((item) => (
        <div
          className={cn(
            'id-metric',
            typeof item.value === 'string' &&
              item.value.length > 8 &&
              'id-date-metric',
          )}
          key={item.label}
        >
          <dt>
            <span>{item.label}</span>
            {item.helper && <p>{item.helper}</p>}
          </dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function InsightBars({
  categories,
  categoryKey,
}: {
  categories: CategoryStat[]
  categoryKey: CategoryKey
}) {
  const max = categories[0]?.count || 1
  return (
    <div className="id-bars">
      {categories.map((category, index) => {
        const content = (
          <>
            <span className="id-bar-label">{category.name}</span>
            <span className="id-track" aria-hidden="true">
              <span
                className={cn('id-fill', index === 0 && 'id-leader')}
                style={{ width: `${(category.count / max) * 100}%` }}
              />
            </span>
            <strong>{category.count}</strong>
            <span className="id-share">{category.percent}%</span>
          </>
        )
        const href = categoryHref(categoryKey, category)
        return href ? (
          <Link
            key={category.name}
            href={href}
            className="id-bar-row"
            aria-label={`${category.name}: ${category.count} ${category.count === 1 ? 'knife' : 'knives'}, ${category.percent}% of collection`}
          >
            {content}
          </Link>
        ) : (
          <div className="id-bar-row" key={category.name}>
            {content}
          </div>
        )
      })}
    </div>
  )
}

export function InsightRing({
  value,
  label = 'complete',
}: {
  value: number
  label?: string
}) {
  return (
    <div
      className="id-ring"
      style={{
        background: `conic-gradient(var(--id-ring-color) ${value}%, var(--muted) 0)`,
      }}
      aria-label={`${value}% ${label}`}
    >
      <div>
        <strong>{value}%</strong>
        <small>{label}</small>
      </div>
    </div>
  )
}

export function InsightKnifeRow({
  knife,
  date,
}: {
  knife: Knife
  date?: string
}) {
  return (
    <Link
      className="id-knife-row"
      href={`/collection/${encodeURIComponent(knife.id)}`}
    >
      <span className="id-knife-thumb">
        {knife.images[0] ? (
          <Image
            src={getImageUrl(knife.images[0])}
            alt=""
            fill
            sizes="64px"
            className="object-contain"
            referrerPolicy="no-referrer"
          />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground" />
        )}
      </span>
      <span className="id-knife-meta">
        <strong>
          {knife.brand} · {knife.name}
        </strong>
        <small>
          {[knife.specs.bladeMaterial, knife.bladeStyle]
            .filter(Boolean)
            .join(' · ') || 'Details not set'}
        </small>
      </span>
      <time dateTime={date ?? knife.addedAt}>
        {new Date(date ?? knife.addedAt).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}
      </time>
    </Link>
  )
}

export function InsightKnifeCard({ knife }: { knife: Knife }) {
  return (
    <Link
      className="id-knife-card"
      href={`/collection/${encodeURIComponent(knife.id)}`}
    >
      <span className="id-card-image">
        {knife.images[0] ? (
          <Image
            src={getImageUrl(knife.images[0])}
            alt=""
            fill
            sizes="(max-width:520px) 150px, 250px"
            className="object-contain"
            referrerPolicy="no-referrer"
          />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" />
        )}
      </span>
      <small>{knife.brand}</small>
      <strong>{knife.name}</strong>
      <p>{knife.specs.bladeMaterial || 'Steel not set'}</p>
      <time dateTime={knife.addedAt}>
        {new Date(knife.addedAt).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}
      </time>
    </Link>
  )
}

export type InsightSelection = { title: string; knifeIds: string[] }
export function InsightRecordPreview({
  selection,
  onClose,
}: {
  selection: InsightSelection | null
  onClose: () => void
}) {
  const { knives } = useKnives()
  const selected = new Set(selection?.knifeIds)
  const matches = knives.filter((knife) => selected.has(knife.id))
  return (
    <Dialog
      open={Boolean(selection)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{selection?.title}</DialogTitle>
          <DialogDescription>
            {matches.length} matching{' '}
            {matches.length === 1 ? 'knife' : 'knives'}
          </DialogDescription>
        </DialogHeader>
        <div className="id-preview-list">
          {matches.map((knife) => (
            <InsightKnifeRow key={knife.id} knife={knife} />
          ))}
          {!matches.length && (
            <p className="text-sm text-muted-foreground">No matching knives.</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Select a record to open its full details.
        </p>
      </DialogContent>
    </Dialog>
  )
}

export function DirectoryArrow() {
  return (
    <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground" />
  )
}
