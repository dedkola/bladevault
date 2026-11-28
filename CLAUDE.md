@AGENTS.md

## Claude Code Tooling

- **Context7 MCP (`mcp__Context7__*`):** Deferred. Load via `ToolSearch` (`select:mcp__Context7__resolve-library-id,mcp__Context7__get-library-docs`) whenever `AGENTS.md` calls for a docs lookup.

## Dev Server & Live Preview

- `.claude/launch.json` is tracked in git (the rest of `.claude/` is ignored), giving every worktree the `dev` server config on port `3000`. Start it with `preview_start` (`{ "name": "dev" }`).
- Only one worktree can bind port `3000` at a time—check if `3000` is already active or stop the other worktree's server first (or use a temporary local port without committing).
- After user-facing UI changes, ensure the dev server is running so the change can be checked live (real vault, read-only; see `AGENTS.md`).
- To preview a theme/style without persisting settings, dispatch `window.dispatchEvent(new CustomEvent('bladevault-settings-change', { detail: { themeStyle, theme } }))`.

## UI & CSS Gotchas

- **CSS Modules:** Attribute-only selectors must be prefixed with `.root` (e.g. `.root[data-theme-variant='forge'] .cell`).
