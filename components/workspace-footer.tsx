'use client'

import { Search } from 'lucide-react'
import { FooterActions } from '@/components/footer-actions'
import { ThemeQuickSwitcher } from '@/components/theme-quick-switcher'
import { ReloadDataButton } from '@/components/reload-data-button'
import { UpdateCheckButton } from '@/components/update-check-button'
import { OPEN_GLOBAL_SEARCH_EVENT } from '@/components/global-knife-search'
import { useKnives } from '@/components/providers/knives-provider'

/**
 * Compact shell footer shared by the Modern family, Classic, and Alloy layouts.
 * Themes adapt it with their own tokens. The workspace shortcuts (Inbox,
 * Cloud backup, Settings) sit with the other controls on the right in every
 * style.
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
        <ThemeQuickSwitcher />
        <ReloadDataButton />
        <UpdateCheckButton />
        <FooterActions />
      </div>
    </footer>
  )
}
