'use client'

import { Search } from 'lucide-react'
import { ThemeCycleButton } from '@/components/theme-cycle-button'
import { OPEN_GLOBAL_SEARCH_EVENT } from '@/components/global-knife-search'
import { useKnives } from '@/components/providers/knives-provider'

/**
 * Compact shell footer shared by the Modern family and Classic layouts.
 * Themes adapt it with their own tokens; the markup stays identical.
 */
export function WorkspaceFooter() {
  const { knives, isLoading } = useKnives()

  return (
    <footer data-workspace-footer>
      <div>
        <span>
          {isLoading
            ? 'Loading collection…'
            : `${knives.length} ${knives.length === 1 ? 'knife' : 'knives'}`}
        </span>
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new Event(OPEN_GLOBAL_SEARCH_EVENT))
          }
        >
          <kbd>⌘K</kbd>
          <Search />
          Search
        </button>
        <ThemeCycleButton />
      </div>
    </footer>
  )
}
