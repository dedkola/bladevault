'use client'

import type { ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { getSafeExternalUrl } from '@/lib/external-url'
import { cn } from '@/lib/utils'

type MarkdownElementProps = {
  node?: unknown
  className?: string
  children?: ReactNode
}

/**
 * Drops react-markdown's `node` prop, which must not reach the DOM, and lets
 * every override below forward the remaining attributes unchanged.
 */
function attrs<T extends MarkdownElementProps>(props: T): Omit<T, 'node'> {
  const { node, ...rest } = props
  void node
  return rest
}

const components: Components = {
  p: (props) => (
    <p {...attrs(props)} className={cn('mb-2 last:mb-0', props.className)} />
  ),
  h1: (props) => (
    <h1
      {...attrs(props)}
      className={cn(
        'mt-3 mb-1.5 text-base font-semibold text-foreground first:mt-0 xl:text-lg',
        props.className,
      )}
    />
  ),
  h2: (props) => (
    <h2
      {...attrs(props)}
      className={cn(
        'mt-3 mb-1.5 text-sm font-semibold text-foreground first:mt-0 xl:text-base',
        props.className,
      )}
    />
  ),
  h3: (props) => (
    <h3
      {...attrs(props)}
      className={cn(
        'mt-2 mb-1 text-xs font-semibold text-foreground first:mt-0 xl:text-sm',
        props.className,
      )}
    />
  ),
  h4: (props) => (
    <h4
      {...attrs(props)}
      className={cn(
        'mt-2 mb-1 text-xs font-semibold text-foreground first:mt-0 xl:text-sm',
        props.className,
      )}
    />
  ),
  h5: (props) => (
    <h5
      {...attrs(props)}
      className={cn(
        'mt-2 mb-1 text-xs font-semibold text-foreground first:mt-0 xl:text-sm',
        props.className,
      )}
    />
  ),
  h6: (props) => (
    <h6
      {...attrs(props)}
      className={cn(
        'mt-2 mb-1 text-xs font-semibold text-foreground first:mt-0 xl:text-sm',
        props.className,
      )}
    />
  ),
  ul: (props) => (
    <ul
      {...attrs(props)}
      className={cn(
        'my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground',
        props.className,
      )}
    />
  ),
  ol: (props) => (
    <ol
      {...attrs(props)}
      className={cn(
        'my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground',
        props.className,
      )}
    />
  ),
  li: (props) => (
    <li {...attrs(props)} className={cn('pl-0.5', props.className)} />
  ),
  blockquote: (props) => (
    <blockquote
      {...attrs(props)}
      className={cn(
        'my-2 border-l-2 border-[var(--bladevault-gold)]/60 pl-3 text-muted-foreground italic',
        props.className,
      )}
    />
  ),
  code: (props) => (
    <code
      {...attrs(props)}
      className={cn(
        'rounded bg-muted px-1 py-0.5 font-mono text-[11px] xl:text-xs',
        props.className,
      )}
    />
  ),
  pre: (props) => (
    <pre
      {...attrs(props)}
      className={cn(
        'my-2 overflow-x-auto rounded-md border border-border/65 bg-[color:var(--bladevault-surface-soft)]/60 p-2 text-[11px] [&>code]:bg-transparent [&>code]:p-0 xl:text-xs',
        props.className,
      )}
    />
  ),
  table: (props) => (
    <div className="my-2 overflow-x-auto">
      <table
        {...attrs(props)}
        className={cn('w-full border-collapse text-left', props.className)}
      />
    </div>
  ),
  thead: (props) => (
    <thead
      {...attrs(props)}
      className={cn(
        'bg-[color:var(--bladevault-surface-soft)]/60',
        props.className,
      )}
    />
  ),
  th: (props) => (
    <th
      {...attrs(props)}
      className={cn(
        'border border-border/65 px-2 py-1 font-semibold text-foreground',
        props.className,
      )}
    />
  ),
  td: (props) => (
    <td
      {...attrs(props)}
      className={cn('border border-border/65 px-2 py-1', props.className)}
    />
  ),
  hr: (props) => (
    <hr
      {...attrs(props)}
      className={cn('my-3 border-border/65', props.className)}
    />
  ),
  strong: (props) => (
    <strong
      {...attrs(props)}
      className={cn('font-semibold text-foreground', props.className)}
    />
  ),
  del: (props) => (
    <del {...attrs(props)} className={cn('line-through', props.className)} />
  ),
  a: (props) => {
    const safeHref = getSafeExternalUrl(props.href)
    if (!safeHref) {
      return <span className={props.className}>{props.children}</span>
    }
    return (
      <a
        {...attrs(props)}
        href={safeHref}
        target="_blank"
        rel="noreferrer noopener"
        className={cn(
          'font-medium text-[var(--bladevault-gold)] underline underline-offset-2 hover:opacity-80',
          props.className,
        )}
      >
        {props.children}
      </a>
    )
  },
  img: (props) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...attrs(props)}
      alt={props.alt ?? ''}
      className={cn('my-2 max-w-full rounded-md', props.className)}
    />
  ),
  input: (props) => (
    <input
      {...attrs(props)}
      className={cn(
        'mr-1.5 accent-[var(--bladevault-gold)] align-middle',
        props.className,
      )}
    />
  ),
}

/**
 * Renders a Markdown note with the app's typography. Raw HTML is skipped, so
 * only Markdown reaches the page, and single line breaks are kept so notes
 * written before formatting existed still read line by line.
 */
export function NoteMarkdown({
  body,
  className,
}: {
  body: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'min-w-0 text-xs leading-relaxed whitespace-normal text-muted-foreground [overflow-wrap:anywhere] xl:text-sm',
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
        skipHtml
      >
        {body}
      </Markdown>
    </div>
  )
}
