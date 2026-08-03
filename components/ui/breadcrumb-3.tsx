import { ChevronRightIcon } from 'lucide-react'
import { Fragment, type ElementType } from 'react'
import Link from 'next/link'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

export type BreadcrumbSegment =
  | {
      label: string
      href: string
      icon: ElementType<{ className?: string }>
      current?: false
    }
  | {
      label: string
      icon: ElementType<{ className?: string }>
      current: true
      href?: never
    }

type Breadcrumb3Props = {
  segments: readonly BreadcrumbSegment[]
  className?: string
}

export default function Breadcrumb3({ segments, className }: Breadcrumb3Props) {
  return (
    <Breadcrumb className={className}>
      <BreadcrumbList className="gap-1.5 text-sm">
        {segments.map((segment, index) => {
          const Icon = segment.icon

          return (
            <Fragment key={`${segment.label}-${index}`}>
              <BreadcrumbItem>
                {!segment.current ? (
                  <BreadcrumbLink
                    render={<Link href={segment.href} />}
                    className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 hover:text-foreground"
                  >
                    <Icon className="size-3.5 text-muted-foreground" />
                    {index === 0 ? (
                      <span className="text-sm">Home</span>
                    ) : (
                      segment.label
                    )}
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 font-medium">
                    <Icon className="size-3.5 text-foreground/80" />
                    {segment.label}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {index < segments.length - 1 ? (
                <BreadcrumbSeparator className="text-muted-foreground/70">
                  <ChevronRightIcon />
                </BreadcrumbSeparator>
              ) : null}
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
