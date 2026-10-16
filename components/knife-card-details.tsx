import type { ReactNode } from 'react'
import type { getVisibleCardFields } from '@/lib/card-fields'
import { CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** Shared presentation for collection cards and the noninteractive settings preview. */
export function KnifeCardDetails({
  brand,
  name,
  modelNumber,
  fields,
  bladeLength,
  compact = false,
  variantLabel,
  sold = false,
  footerAction,
}: {
  brand: string
  name: string
  modelNumber?: string
  fields: ReturnType<typeof getVisibleCardFields>
  bladeLength: string
  compact?: boolean
  variantLabel?: string
  sold?: boolean
  footerAction?: ReactNode
}) {
  const lengthInFields =
    !variantLabel &&
    fields.some(
      (field, index) =>
        field.key === 'specs.bladeLength' && (!compact || index < 2),
    )

  return (
    <>
      <CardContent
        className={cn(
          'min-w-0 border-t border-border/60',
          compact ? 'px-3 pb-3 pt-2.5' : 'px-3 pb-4 pt-3 sm:px-4',
        )}
      >
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <span className="min-w-0 break-words text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {brand}
          </span>
          <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">
            {modelNumber || '—'}
          </span>
        </div>
        <h2
          className={cn(
            'mt-1 min-h-10 line-clamp-2 font-medium leading-tight tracking-tight',
            sold ? 'text-muted-foreground' : 'text-foreground',
            compact ? 'text-base' : 'text-lg sm:text-xl',
          )}
          title={`${brand} ${name}`}
        >
          {name}
        </h2>
        {variantLabel ? (
          <p className="mt-2 min-h-8 line-clamp-2 text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
            {variantLabel}
          </p>
        ) : fields.length > 0 ? (
          <dl
            className={cn(
              'mt-3 grid grid-cols-1 gap-x-3 gap-y-2 @min-[18rem]/knife-card:grid-cols-2',
              compact && '[&>div:nth-child(n+3)]:hidden max-sm:hidden',
            )}
          >
            {fields.map((field) => (
              <div key={field.key} className="min-w-0">
                <dt className="text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
                  {field.label}
                </dt>
                <dd
                  className="text-xs font-medium leading-4 text-foreground [overflow-wrap:anywhere]"
                  title={field.value}
                >
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </CardContent>
      <div className="relative mt-auto flex min-h-9 items-center border-t border-border px-3 pr-24 text-[11px] text-muted-foreground">
        <span
          className={cn(
            'truncate',
            // Compact cards hide their fields on phones, so keep the footer there.
            lengthInFields && (compact ? 'sm:hidden' : 'hidden'),
          )}
        >
          {bladeLength ? `${bladeLength} blade` : 'Blade length not recorded'}
        </span>
        {footerAction}
      </div>
    </>
  )
}
