'use client'

import { Search } from 'lucide-react'
import { ClassicFooterActions } from '@/components/classic-footer-actions'
import { ThemeCycleButton } from '@/components/theme-cycle-button'
import { OPEN_GLOBAL_SEARCH_EVENT } from '@/components/global-knife-search'
import { useKnives } from '@/components/providers/knives-provider'
import { isModernThemeFamily } from '@/lib/settings-shared'

/**
 * Compact shell footer shared by the Modern family and Classic layouts.
 * Themes adapt it with their own tokens; Classic adds its workspace shortcuts
 * on the left because they live here instead of the sidebar.
 */
export function WorkspaceFooter() {
  const { knives, isLoading, themeStyle } = useKnives()

  return (
    <footer data-workspace-footer>
      {!isModernThemeFamily(themeStyle) && <ClassicFooterActions />}
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
