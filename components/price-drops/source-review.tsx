'use client'

import Link from 'next/link'
import { useId, useState } from 'react'
import { Check, ExternalLink, Pencil, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getSafeExternalUrl } from '@/lib/external-url'
import type { AttentionActionRequest } from '@/lib/price-monitor/attention-filter'
import type { ComparisonRow, SourceReview } from '@/lib/price-monitor/review'
import type { PriceSourceOrigin } from '@/lib/price-monitor/shared'
import { cn } from '@/lib/utils'
import { money, storeLabel } from './price-format'

/** Why AI doubts a price, when the question is about the price itself. */
const PRICE_ISSUE_TEXT: Record<string, string> = {
  different_price: 'The page shows a different price.',
  wrong_currency: 'The price looks like it is in another currency.',
  bundle: 'The price looks like it is for a bundle or set.',
  accessory: 'The price looks like it is for an accessory or another item.',
  per_unit: 'The price looks like a per-unit or instalment price.',
  not_current: 'The price looks like an old or crossed-out one.',
}

const diffRow =
  'bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100'

function Row({ row }: { row: ComparisonRow }) {
  const differs = row.match === 'different'
  return (
    <tr
      data-review-row={row.field}
      data-review-match={row.match}
      className={cn(
        'border-t border-[var(--bladevault-line)]/60',
        differs && diffRow,
      )}
    >
      <th
        scope="row"
        className={cn(
          'w-[7.5rem] px-2.5 py-1.5 text-left font-normal text-muted-foreground',
          differs && 'font-medium text-amber-800 dark:text-amber-300',
        )}
      >
        <span aria-hidden="true">{differs ? '≠ ' : '= '}</span>
        {row.label}
        {differs ? <span className="sr-only"> (differs)</span> : null}
      </th>
      <td className={cn('px-2.5 py-1.5', !differs && 'text-muted-foreground')}>
        {row.yours || <span className="italic opacity-70">not set</span>}
      </td>
      <td className={cn('px-2.5 py-1.5', !differs && 'text-muted-foreground')}>
        {row.page ?? <span className="italic opacity-70">not on the page</span>}
      </td>
    </tr>
  )
}

/** Your knife next to the store page, differences first. */
function ComparisonTable({
  review,
  store,
}: {
  review: SourceReview
  store: string
}) {
  const [showAll, setShowAll] = useState(false)
  const differing = review.rows.filter((row) => row.match === 'different')
  // Nothing differs by field: show everything AI read rather than nothing.
  const rest = differing.length
    ? review.rows.filter((row) => row.match !== 'different')
    : []
  const open = differing.length ? differing : review.rows
  const restId = useId()
  if (!review.rows.length) return null
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--bladevault-line)]/70">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-muted/60 text-left">
            <td className="px-2.5 py-1.5" />
            <th scope="col" className="px-2.5 py-1.5 font-medium">
              Your knife
            </th>
            <th scope="col" className="px-2.5 py-1.5 font-medium">
              {store} page
            </th>
          </tr>
        </thead>
        <tbody>
          {open.map((row) => (
            <Row key={row.field} row={row} />
          ))}
        </tbody>
        {rest.length && showAll ? (
          <tbody id={restId}>
            {rest.map((row) => (
              <Row key={row.field} row={row} />
            ))}
          </tbody>
        ) : null}
      </table>
      {rest.length ? (
        <button
          type="button"
          aria-expanded={showAll}
          aria-controls={restId}
          onClick={(event) => {
            event.stopPropagation()
            setShowAll((value) => !value)
          }}
          className="w-full border-t border-[var(--bladevault-line)]/60 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        >
          {showAll
            ? 'Hide the details that match'
            : `Show ${rest.length} more ${rest.length === 1 ? 'detail' : 'details'} (matching or not on the page)`}
        </button>
      ) : null}
    </div>
  )
}

/**
 * AI doubts a store link's price: what it saw on the page next to the
 * user's knife, with the answers. "Is this link your knife?" for another
 * version or product; "Is this the right price?" otherwise. Without stored
 * details (a doubt from before they were kept) it shows AI's sentence.
 */
export function SourceReviewCard({
  review,
  knifeId,
  storeName,
  url,
  priceMinor,
  currency,
  origin,
  lastError,
  busy,
  onAction,
  sourceId,
  className,
}: {
  review: SourceReview | null
  knifeId: string
  storeName: string
  url: string
  priceMinor: number | null
  currency: string | null
  origin: PriceSourceOrigin
  lastError: string | null
  busy?: boolean
  sourceId: number
  onAction: (request: AttentionActionRequest) => void
  className?: string
}) {
  const store = storeLabel(storeName)
  const price = priceMinor !== null ? money(priceMinor, currency) : null
  const safeUrl = getSafeExternalUrl(url)
  const ids = [sourceId]
  const stop = (event: React.SyntheticEvent) => event.stopPropagation()
  const removeText =
    origin === 'auto'
      ? 'Pause this link (your knife’s own product link)'
      : 'Remove this link'

  const openPage = safeUrl ? (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stop}
      className="inline-flex items-center gap-1 self-center px-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      Open the {store} page
      <ExternalLink className="size-3" />
    </a>
  ) : null

  const answer = (
    action: AttentionActionRequest['action'],
    label: string,
    sub: string,
    icon: React.ReactNode,
    primary = false,
  ) => (
    <Button
      type="button"
      variant={primary ? 'default' : 'outline'}
      size="xs"
      disabled={busy}
      title={sub}
      data-review-answer={action}
      onClick={(event) => {
        stop(event)
        onAction({ action, sourceIds: ids })
      }}
    >
      {icon}
      {label}
    </Button>
  )
  /** What the answers do, in one line under them. */
  const explain = (text: string) => (
    <p className="text-[11px] text-muted-foreground">{text}</p>
  )

  const priceAnswers = (
    <>
      <div className="flex flex-wrap gap-2">
        {answer(
          'accept',
          `${price ?? 'The price'} is right`,
          'Stop doubting this price',
          <Check className="size-3" />,
          true,
        )}
        {answer(
          'wrong_page',
          'Wrong page',
          removeText,
          <X className="size-3" />,
        )}
        {openPage}
      </div>
      {explain(
        `${price ?? 'The price'} is right: AI stops doubting this price. Wrong page: ${removeText.charAt(0).toLowerCase()}${removeText.slice(1)}.`,
      )}
    </>
  )

  if (!review)
    return (
      <div data-source-review="pending" className={cn('space-y-2', className)}>
        <p className="text-xs text-muted-foreground">
          {lastError ?? 'AI doubts the price read from this page.'}
        </p>
        <p className="text-xs text-muted-foreground">
          The next check of this link shows your knife and the page side by
          side.
        </p>
        {priceAnswers}
      </div>
    )
  const changed = review.rows.some((row) => row.changed)
  const changedNote = changed ? (
    <p className="text-[11px] text-muted-foreground">
      You changed some of your knife’s details since AI checked; it compares
      them again on the next check.
    </p>
  ) : null

  if (!review.version) {
    const why =
      PRICE_ISSUE_TEXT[review.issue] ?? 'AI doubts the price read here.'
    return (
      <div data-source-review="price" className={cn('space-y-2', className)}>
        <p className="text-sm font-medium">
          Is {price ?? 'this'} the right price at {store}?
        </p>
        <p className="text-xs text-muted-foreground">
          {why}
          {review.pagePrice ? ` AI sees ${review.pagePrice} on the page.` : ''}
        </p>
        <ComparisonTable review={review} store={store} />
        {changedNote}
        {priceAnswers}
      </div>
    )
  }

  const model = review.rows.find((row) => row.field === 'modelNumber')
  const modelMatches =
    model?.match === 'same' &&
    review.rows.some((row) => row.match === 'different')
  return (
    <div data-source-review="version" className={cn('space-y-2', className)}>
      <div>
        <p className="text-sm font-medium">Is the {store} link your knife?</p>
        <p className="text-xs text-muted-foreground">
          AI says {store} sells{' '}
          {review.issue === 'wrong_product'
            ? 'another product'
            : 'another version'}{' '}
          here.
          {review.title ? (
            <>
              {' '}
              On the page:{' '}
              <span className="text-foreground">{review.title}</span>
            </>
          ) : null}
        </p>
      </div>
      <ComparisonTable review={review} store={store} />
      {changedNote}
      {modelMatches ? (
        <p className="rounded-lg border border-[var(--bladevault-line)]/70 bg-muted/50 px-2.5 py-1.5 text-xs">
          The model number matches ({model?.yours}). Your knife’s other details
          may be the ones that are off.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {answer(
          'same_product',
          'Same knife',
          price ? `Keep the link, trust ${price}` : 'Keep the link',
          <Check className="size-3" />,
          true,
        )}
        {answer(
          'wrong_page',
          'Different knife',
          removeText,
          <X className="size-3" />,
        )}
        <Button
          type="button"
          variant="outline"
          size="xs"
          title="Edit your knife; AI compares the link again on its next check"
          render={
            <Link
              href={`/collection/${encodeURIComponent(knifeId)}?edit=1`}
              onClick={stop}
            />
          }
          nativeButton={false}
        >
          <Pencil className="size-3" />
          My details are wrong
        </Button>
        {openPage}
      </div>
      {explain(
        `Same knife keeps the link${price ? ` and trusts ${price}` : ''}; AI won’t ask about another version there again. Different knife: ${removeText.charAt(0).toLowerCase()}${removeText.slice(1)}. My details are wrong opens your knife to edit; AI compares again on the next check.`,
      )}
    </div>
  )
}
