---
paths:
  - 'app/**/*.{tsx,css}'
  - 'components/**/*.{tsx,css}'
  - 'lib/settings-shared.ts'
  - 'static-app/**/*.{tsx,css}'
---

# UI, styles and CSS

- Styles and light/dark support are defined by `THEME_STYLES` and `MODERN_THEME_VARIANTS` in `lib/settings-shared.ts`. Read the list there; don't copy it into docs.
- Modern variants render as `data-theme-style="modern"` plus `data-theme-variant`. Shared variant styling is in `app/forge.css`, per-variant tokens in `app/modern-variants.css`, and some variants have their own file (e.g. `app/atrium.css`). When renaming a style, map the old id in `normalizeThemeStyle` so saved settings keep working.
- Reuse theme tokens from `app/globals.css`, `app/alloy.css` and `app/forge.css`, primitives in `components/ui`, and image helpers `getImageUrl()` and `VaultImage`. Scope theme-specific styling; a shared change must keep working in every style.
- CSS Modules: prefix attribute-only selectors with `.root`, e.g. `.root[data-theme-variant='forge'] .cell`.
- Follow supplied prototypes in both look and interaction. Keep similar elements (buttons, pills, filters, sidebar rows) consistent within a style.
- Check visual changes at desktop and narrow widths, in the affected styles and modes. Wait for providers to finish loading before judging empty states or screenshots. Keep keyboard access, visible focus and readable labels (see `ACCESSIBILITY.md`).
- To preview a style without saving settings: `window.dispatchEvent(new CustomEvent('bladevault-settings-change', { detail: { themeStyle, theme } }))`.
