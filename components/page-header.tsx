import { FolderIcon, HomeIcon } from 'lucide-react'
import { PiKnife } from 'react-icons/pi'
import Breadcrumb3, {
  type BreadcrumbSegment,
} from '@/components/ui/breadcrumb-3'

export type BreadcrumbItemData = {
  label: string
  href?: string
}

type PageHeaderProps = {
  title: string
  description?: string
  breadcrumbs?: BreadcrumbItemData[]
  actions?: React.ReactNode
}

export function PageHeader({
  title,
  description,
  breadcrumbs = [],
  actions,
}: PageHeaderProps) {
  const segments: BreadcrumbSegment[] = breadcrumbs.map((item, index) => {
    const isLast = index === breadcrumbs.length - 1

    if (isLast || !item.href) {
      return { label: item.label, icon: PiKnife, current: true }
    }

    return { label: item.label, href: item.href, icon: FolderIcon }
  })

  return (
    <div className="mb-8">
      {breadcrumbs.length > 0 && (
        <Breadcrumb3
          className="mb-4"
          segments={[{ label: 'Home', href: '/', icon: HomeIcon }, ...segments]}
        />
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-medium tracking-tight text-[var(--bladevault-title)]">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {actions}
          </div>
        )}
      </div>
    </div>
  )
}
