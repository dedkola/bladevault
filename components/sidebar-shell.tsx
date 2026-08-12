'use client'

import dynamic from 'next/dynamic'

export const SidebarShell = dynamic(
  () => import('@/components/sidebar').then((mod) => mod.Sidebar),
  {
    ssr: false,
    loading: () => (
      <>
        <div className="h-16 border-b border-sidebar-border bg-sidebar print:hidden md:hidden" />
        <aside className="hidden h-full min-h-0 w-60 flex-shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground print:hidden md:flex" />
      </>
    ),
  },
)
