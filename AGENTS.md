# BladeVault agent guidance

<!--
Maintainer notes (stripped before Claude reads this file; other agents may still see them).
- This file is shared by every coding agent. Claude-only setup lives in CLAUDE.md, which imports this file.
- Keep it to what an agent cannot work out from the code. If a line restates the code, delete it.
- Rules for one area live in .claude/rules/ so Claude Code loads them only when it touches that area.
- Rules that must never be broken belong in .claude/settings.json (hooks, permissions), not here.
-->

## Commands

- Node from `.nvmrc`, npm only. Install with `npm ci`. Never switch package managers or edit the lockfile by hand.
- One test file: `npm test -- tests/unit/<file>.test.ts` (or `tests/integration/…`). Don't use `test:watch`: it never exits.
- Changed files only: `npx eslint <paths>` and `npx prettier --check <paths>`.
- Types and build: `npm run build`. There is no `typecheck` script; the build also bundles the MCP CLI.
- One browser spec, after a current build: `npx playwright test tests/e2e/<file>.spec.ts --project=chromium`. Playwright starts its own server on `127.0.0.1:3199` with a temporary vault and never reuses a running one.
- Static target: `npm run build:static`. Desktop, native modules, preload or updater: `npm run desktop:smoke`.
- CI (`test.yml`) runs `format:check`, actionlint, `lint`, `test` and `build` on every PR. Browser tests are not in CI; the desktop smoke runs only when desktop-sensitive files change.

## Proportional validation

- Text-only change (docs, Markdown, comments): run `npx prettier --check` on the changed files, because CI checks Markdown too (only `README.md` is ignored), then stop.
- Behavior change: run the smallest relevant check first. Broaden only for a failure, a wider blast radius or an explicit request. Don't repeat a check that passed unless the code changed since.
- Report what changed and exactly which commands ran. Keep local checks, a pushed branch, a PR, hosted CI and a deployment distinct, and don't claim what you didn't verify.
- Electron rebuilds `better-sqlite3` for its own ABI. A native-module mismatch after switching between Electron and Node is a build state, not an app regression.

## How to work here

- Investigation, audit, proposal and read-only requests mean inspect and report, no edits. Once the user authorizes implementation, don't ask again for routine steps it covers.
- Check the branch and working tree first. Preserve unrelated changes, keep the fix focused, and don't refactor adjacent code because a tool suggested it.
- Don't commit, push, open a PR, deploy, publish or merge unless asked. The maintainer merges.
- Branch from `main` as `dev/<topic>` (agents use this instead of the `feat/` and `fix/` prefixes in CONTRIBUTING.md). Commit messages follow Conventional Commits with a scope, e.g. `fix(batch-scrape): skip already-saved products`.
- PRs: fill `.github/pull_request_template.md`. Add exactly one label, `feature`, `enhancement`, `bug`, `documentation` or `internal`, because `scripts/release-notes.cjs` groups the release page by it. The **Release note** is one plain sentence for users, or `none`.
- Redesigns and "propose options" requests: 2–3 local HTML mockups in `design-proposals/` (gitignored) before changing the app.
- A failed `desktop-release.yml` job (often the macOS DMG): first check for a runner or infrastructure failure, and if so `gh run rerun <run-id> --failed` before changing code. Don't poll CI unless asked.
- When reporting finished work, name the branch, the worktree path, and whether changes are uncommitted, committed or pushed.

## Git identity and attribution

- No AI attribution anywhere in Git or GitHub: no `Co-Authored-By` agent trailers, no "Generated with/by" lines, no `Claude-Session` trailers or session links, in commits, PR descriptions or comments.
- Commit as the maintainer, never as an agent identity. Agent environments often preset one, so before the first commit check `git config user.name` and `git config user.email`. If they aren't the maintainer's, set a repository-local identity copied from `git log -1 --format='%an <%ae>' origin/main`.
- Before pushing, check that `git log --format='%an <%ae> | %cn <%ce>%n%b' origin/main..HEAD` shows no agent names, emails or trailers.

## Collection data safety

- A new worktree is not a new vault. Without `BLADEVAULT_DATA_DIR` the app finds the user's real database in the home directory or the legacy `data/` folder.
- Live UI checks the user will review run against that real vault, read-only. Anything that writes, imports, restores or deletes uses a disposable `BLADEVAULT_DATA_DIR`.
- Don't rescrape, bulk-update, restore, hand-migrate or delete saved records to investigate a bug. Reading records doesn't authorize changing them. Keep the database and its images together.
- Storage tests use `tests/helpers/temp-vault.ts`. Keep the temporary-vault server in `playwright.config.ts`; `tests/e2e/helpers.ts` deletes records, so never point it at a user instance.
- `npm run desktop:dev` uses its own persistent dev vault and ignores `BLADEVAULT_DATA_DIR` from the shell.

## Invariants the code won't tell you

- Collection-list records are summaries: no description, only the first photo plus `imageCount`. Fetch full detail before reading or editing descriptions or galleries; missing fields there are not data loss.
- Keep filesystem and SQLite imports out of browser components. `lib/data.ts` is client-safe; storage is `lib/storage/` and `lib/local-db.ts`; shared domain and MCP operations are in `lib/services/`.
- Reuse provider actions in `components/providers/`. Don't add parallel state or duplicate settings fetches.
- Keep App Lock, vault-generation checks, the write and restore guards (`withVaultMutationRequest`, `withVaultWrite`) and the existing mutation order, so a delayed request can't write into a newly restored vault. Migrations must be repeat-safe and preserve data.
- `lib/mcp/` and `cli/` expose the same vault. Keep write controls, field validation, expected timestamps, the proposal/preview/apply split and bulk preview hashes. HTTP keeps its token, host and origin checks; stdio has a different auth context.
- API routes return `{ error: string }` with a meaningful status; clients parse with `readJsonResponse()` and `getApiErrorMessage()` from `lib/api-response.ts`.
- `electron/`: keep renderer isolation, the sandbox and Node integration off. A web build doesn't verify packaging or the updater.
- `static-app/` has no server API, SQLite, scraping, screenshots, filesystem backup, App Lock or MCP. Keep its aliases and capability limits scoped to it (see `static-app/README.md`).

## Area rules

Read these before working in the area. Claude Code loads them automatically for matching files.

- UI, styles and CSS: `.claude/rules/ui.md`
- Scraper and import: `.claude/rules/scraper.md`

## Library docs

- Version-sensitive library work (Next.js App Router, React, Electron, electron-builder, better-sqlite3, Playwright, MCP SDK): check current docs for the versions in `package.json` before writing code, with the Context7 MCP where it's available. Skip this for small fixes and CSS.
