'use client'

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { Palette } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { readJsonResponse } from '@/lib/api-response'
import { cn } from '@/lib/utils'
import {
  applyThemeStyleToElement,
  isDarkOnlyThemeStyle,
  isLightOnlyThemeStyle,
  QUICK_SWITCH_THEME_STYLES,
  SETTINGS_UPDATED_EVENT,
  THEME_STYLE_NAMES,
  type AppSettings,
  type ThemeStyle,
} from '@/lib/settings-shared'
import styles from './theme-quick-switcher.module.css'
import './theme-style-swatch.css'

const GRID_COLUMNS = 4
const POPUP_GAP = 8
const VIEWPORT_MARGIN = 8

function applyThemeStyle(themeStyle: ThemeStyle) {
  applyThemeStyleToElement(document.documentElement, themeStyle)
  window.dispatchEvent(
    new CustomEvent<Partial<AppSettings>>(SETTINGS_UPDATED_EVENT, {
      detail: { themeStyle },
    }),
  )
}

function themeTitle(themeStyle: ThemeStyle) {
  const name = THEME_STYLE_NAMES[themeStyle]
  if (isLightOnlyThemeStyle(themeStyle)) return `${name} · light only`
  if (isDarkOnlyThemeStyle(themeStyle)) return `${name} · dark only`
  return name
}

/**
 * Footer palette button that opens a small grid of every style for a quick
 * switch. Picks update the shell right away and queue saves so a later pick
 * always wins over an earlier response.
 */
export function ThemeQuickSwitcher() {
  const { themeStyle, showFeedback } = useKnives()
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const pendingThemeRef = useRef<ThemeStyle | null>(null)
  const savingThemeRef = useRef(false)
  const savedThemeRef = useRef(themeStyle)
  const popupId = useId()

  useEffect(() => {
    // Keep the fallback in sync when settings change elsewhere, but ignore the
    // optimistic style while one of this switcher's saves is still pending.
    if (!savingThemeRef.current && pendingThemeRef.current === null) {
      savedThemeRef.current = themeStyle
    }
  }, [themeStyle])

  const savePendingTheme = useCallback(async () => {
    if (savingThemeRef.current) return
    savingThemeRef.current = true

    try {
      while (pendingThemeRef.current) {
        const target = pendingThemeRef.current
        pendingThemeRef.current = null
        const response = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            themeStyle: target,
          } satisfies Partial<AppSettings>),
        })
        const data = await readJsonResponse<{ error?: string }>(response)
        if (!response.ok) {
          throw new Error(data.error || 'Failed to save theme preference')
        }
        savedThemeRef.current = target
      }
    } catch {
      pendingThemeRef.current = null
      applyThemeStyle(savedThemeRef.current)
      showFeedback('Could not save the appearance preference.', 'error')
    } finally {
      savingThemeRef.current = false
    }
  }, [showFeedback])

  const close = useCallback((restoreFocus: boolean) => {
    setIsOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  const pickTheme = (target: ThemeStyle) => {
    close(true)
    if (target === themeStyle) return
    pendingThemeRef.current = target
    applyThemeStyle(target)
    void savePendingTheme()
  }

  // Anchor the popup above the trigger, right-aligned and kept on screen.
  useLayoutEffect(() => {
    if (!isOpen) return
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setPosition({
        bottom: window.innerHeight - rect.top + POPUP_GAP,
        right: Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right),
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    popupRef.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus()

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (
        popupRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return
      }
      close(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [isOpen, close])

  const onPopupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      // Leaving the popup closes it, like a menu.
      close(false)
      return
    }

    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: GRID_COLUMNS,
      ArrowUp: -GRID_COLUMNS,
    }[event.key]
    if (!step) return

    const items = Array.from(
      popupRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ) ?? [],
    )
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (index === -1) return
    event.preventDefault()
    const next = index + step
    items[Math.min(Math.max(next, 0), items.length - 1)]?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-theme-cycle
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popupId : undefined}
        aria-label={`Change theme. Current: ${THEME_STYLE_NAMES[themeStyle]}.`}
        title={`Theme · ${THEME_STYLE_NAMES[themeStyle]}`}
        onClick={() => (isOpen ? close(false) : setIsOpen(true))}
      >
        <Palette />
      </button>
      {isOpen &&
        createPortal(
          <div
            ref={popupRef}
            id={popupId}
            role="menu"
            aria-label="Theme"
            className={styles.popup}
            style={position}
            onKeyDown={onPopupKeyDown}
          >
            <div className={styles.grid}>
              {QUICK_SWITCH_THEME_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  role="menuitemradio"
                  aria-checked={style === themeStyle}
                  title={themeTitle(style)}
                  className={styles.tile}
                  onClick={() => pickTheme(style)}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'theme-style-swatch',
                      `is-${style}`,
                      styles.swatch,
                    )}
                  >
                    <span className="theme-style-swatch-rail" />
                    <span className="theme-style-swatch-body">
                      <span className="theme-style-swatch-title" />
                      <span className="theme-style-swatch-line" />
                      <span className="theme-style-swatch-card" />
                    </span>
                  </span>
                  <span className={styles.name}>
                    {THEME_STYLE_NAMES[style]}
                  </span>
                </button>
              ))}
            </div>
            <div className={styles.footer}>
              <span>Arrows to move · Enter to pick</span>
              <Link
                href="/settings?tab=appearance"
                className={styles.settingsLink}
                onClick={() => close(false)}
              >
                All settings
              </Link>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
