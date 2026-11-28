@AGENTS.md

<!--
Maintainer notes (stripped before Claude reads this file).
- AGENTS.md is the shared source; this file only adds what is specific to Claude Code.
- Hard rules are enforced in .claude/settings.json: attribution off, Prettier after every edit.
- Personal notes go in CLAUDE.local.md (gitignored). The @AGENTS.md import above keeps AGENTS.md
  loaded even when a CLAUDE.local.md exists.
-->

## Claude Code specifics

- `.claude/settings.json` formats every file you edit with Prettier and turns commit and PR attribution off. Don't run Prettier again on files you just edited, and don't add attribution by hand.
- Dev server: `.claude/launch.json` defines `dev` on port 3000. Start it with `preview_start` (`{ "name": "dev" }`). Only one worktree can hold port 3000, so check whether it's in use first, or use a temporary port without committing it.
- After user-facing UI changes, leave the dev server running against the real vault (read-only) and show a screenshot of the changed screen.
