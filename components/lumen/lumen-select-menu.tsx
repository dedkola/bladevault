'use client'

import { Menu } from '@base-ui/react/menu'
import { Check, ChevronDown } from 'lucide-react'

export type LumenMenuOption = { value: string; label: string; count?: number }

/**
 * A small single-choice menu for the Lumen-based layouts. Choosing the
 * selected option again clears it when `clearable` is set.
 */
export function LumenSelectMenu({
  label,
  options,
  value,
  onSelect,
  clearable = false,
  emptyText = 'Nothing to choose yet.',
  triggerProps,
  align = 'start',
}: {
  label: React.ReactNode
  options: LumenMenuOption[]
  value: string | null
  onSelect: (value: string | null) => void
  clearable?: boolean
  emptyText?: string
  triggerProps?: Record<string, string | boolean | undefined>
  align?: 'start' | 'end'
}) {
  return (
    <Menu.Root>
      <Menu.Trigger {...triggerProps} data-active={value ? true : undefined}>
        {label}
        <ChevronDown aria-hidden="true" data-lumen-menu-chevron />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align={align} sideOffset={8} className="isolate z-50">
          <Menu.Popup data-lumen-menu>
            {options.length === 0 && <p data-lumen-menu-empty>{emptyText}</p>}
            {clearable && value && (
              <Menu.Item data-lumen-menu-item onClick={() => onSelect(null)}>
                <span>Clear</span>
              </Menu.Item>
            )}
            {options.map((option) => (
              <Menu.Item
                key={option.value}
                data-lumen-menu-item
                data-selected={option.value === value || undefined}
                onClick={() =>
                  onSelect(
                    clearable && option.value === value ? null : option.value,
                  )
                }
              >
                <Check aria-hidden="true" data-lumen-menu-check />
                <span>{option.label}</span>
                {option.count !== undefined && <small>{option.count}</small>}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
