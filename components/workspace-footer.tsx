'use client'

import { Search } from 'lucide-react'
import { ClassicFooterActions } from '@/components/classic-footer-actions'
import { ThemeQuickSwitcher } from '@/components/theme-quick-switcher'
import { ReloadDataButton } from '@/components/reload-data-button'
import { OPEN_GLOBAL_SEARCH_EVENT } from '@/components/global-knife-search'
import { useKnives } from '@/components/providers/knives-provider'
import { isModernThemeFamily } from '@/lib/settings-shared'

/**
 * Compact shell footer shared by the Modern family, Classic, and Alloy layouts.
 * Themes adapt it with their own tokens; Classic adds its workspace shortcuts
 * on the left because they live here instead of the sidebar.
 */
export function WorkspaceFooter() {
  const { knives, isLoading, themeStyle } = useKnives()

  return (
    <footer data-workspace-footer>
      {/* Alloy keeps these shortcuts in its own header. */}
      {!isModernThemeFamily(themeStyle) && themeStyle !== 'alloy' && (
        <ClassicFooterActions />
      )}
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
        <ThemeQuickSwitcher />
        <ReloadDataButton />
      </div>
    </footer>
  )
}
