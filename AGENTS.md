# BladeVault agent guidance

## Scope and starting points

- Read `CONTRIBUTING.md`, `package.json`, and the relevant code before editing. Use `docs/README.md` to find feature and runtime documentation.
- Check the working tree and active branch first. Preserve unrelated changes and keep fixes focused; do not refactor adjacent code just because an analysis tool suggests it.
- Treat investigation, audit, proposal, and read-only requests as inspection and reporting. Implement when the user authorizes implementation; do not ask again for routine steps already covered by that authorization.
- Do not commit, push, create a PR, deploy, publish, or merge unless requested. When authorized, stage only reviewed paths, use a `dev/` branch for new work, and distinguish local validation from hosted CI and deployment results. Do not poll CI unless requested.

## Code investigation and Graphify

- For nontrivial code investigations and behavior changes, consult Graphify before editing. Target this repository with `repository_id: "dedkola/bladevault"` after checking the Git remote; use the corresponding repository name if working in a fork.
- Start with a focused `query_graph` or `graphify_rank_files` query. Inspect callers, dependencies, impact, or related tests when relevant to the change. Use `recall` when prior decisions or known pitfalls matter.
- Check the indexed commit and verify relevant definitions and behavior against the current checkout. Graph results can omit dynamic callers, unindexed files, and local edits. Missing links do not prove safety; matching bodies do not prove equivalent behavior. Treat unverified recalled notes as leads.
- If Graphify is unavailable or insufficient, state that briefly and continue with targeted `rg` searches and source reads. Skip Graphify for text-only or trivial edits.

## Architecture and runtime boundaries

- `app/` contains Next.js App Router pages and API routes. `components/providers/` owns shared collection, comparison, Smart Collection, and restore state. Reuse existing provider actions instead of adding parallel state or duplicate settings fetches.
- `lib/data.ts` defines knife types and client-safe helpers; `lib/storage/types.ts` defines the storage contract, `lib/storage/local.ts` implements it, and `lib/local-db.ts` owns SQLite initialization and migrations. `lib/services/` contains shared domain/MCP operations. Keep filesystem and SQLite imports out of browser components.
- Collection-list records are summaries: descriptions are omitted and images are limited to the first photo with a separate `imageCount`. Fetch full detail before inspecting or editing complete descriptions or galleries; do not interpret summary fields as persisted data loss.
- Preserve App Lock, vault-generation checks, and write/restore guards (`withVaultMutationRequest`, `withVaultWrite`). Follow existing mutation ordering so delayed requests cannot write into a newly restored vault. Keep schema migrations repeat-safe and data-preserving.
- `lib/mcp/` and `cli/` expose the same vault. Preserve write controls, field validation, expected timestamps, proposal/preview/apply separation, and bulk preview hashes. HTTP and stdio have different authentication contexts; retain HTTP token, host, and origin checks.
- `electron/` hosts the standalone Next server and exposes desktop capabilities through its preload bridge. Preserve renderer isolation, sandboxing, and disabled Node integration. Web builds alone do not verify packaging or updater behavior.
- `static-app/` reuses the UI through browser adapters and session storage. It has no server API, SQLite, scraping, screenshots, filesystem backup/restore, App Lock, or MCP. Keep navigation aliases and capability restrictions scoped to this target; see `static-app/README.md`.

## Collection data safety

- A new worktree is not a new vault. Without an explicit data directory, the app can discover an existing personal database in home or legacy locations. Set `BLADEVAULT_DATA_DIR` to a disposable directory for manual development/QA that opens the vault, or use an intentionally prepared copy when real data is needed.
- Keep the database and its local images together. Do not rescrape, bulk-update, restore, migrate manually, or delete the user's saved records merely to investigate a code issue. Reading records does not authorize changing them.
- Storage tests should use `tests/helpers/temp-vault.ts` for database/cache cleanup and environment restoration. Browser tests must retain the temporary-vault server in `playwright.config.ts`; `tests/e2e/helpers.ts` resets delete records, so never point them at a user instance.
- `npm run desktop:dev` uses a persistent development vault and overrides the data directory internally; do not assume it honors a disposable `BLADEVAULT_DATA_DIR` from the shell.

## UI and scraper changes

- Check `lib/settings-shared.ts` for supported styles (currently Classic, Modern, and Alloy) and light/dark modes. Reuse theme tokens from `app/globals.css` and `app/alloy.css`, existing UI primitives, and image helpers such as `getImageUrl`/`VaultImage`. Scope theme-specific styling; preserve affected behavior across styles for shared changes.
- Follow supplied prototypes in both appearance and interaction. For visual behavior changes, inspect the affected flow at desktop and narrow widths, with relevant theme/mode coverage. Wait for provider loading before judging empty states or screenshots; preserve keyboard access, focus, and readable labels.
- For scraper fixes, inspect the actual product/variant markup and existing extractor before changing rules. Scope extraction away from related products; inspect structured data, lazy attributes, and original gallery URLs. Leave unsupported or contradictory values empty, and ensure later enrichment/fallbacks cannot reintroduce rejected values.
- Use source fixtures in `tests/fixtures/scrape/` and focused `tests/unit/scrape-*.test.ts` regressions for meaningful extraction changes. Check extraction separately from Add/Edit form application and saved-state behavior; preserve manual field edits and image selections.

## Tooling and proportional validation

- Use Node from `.nvmrc`, npm, and `package-lock.json`. Use `npm ci` when installing dependencies or reproducing CI; do not switch package managers or lockfiles. Follow existing strict TypeScript, `@/` imports, and Prettier conventions.
- For text-only changes, inspect the final diff and stop. Do not run tests, builds, lint, formatting tools, type checking, or browser automation unless explicitly requested.
- For behavior changes, start with the smallest relevant check. These are options, not a checklist for every task:
  - Domain logic, scraper, component, or API behavior: `npm test -- tests/unit/<file>.test.ts` or the relevant `tests/integration/<file>.test.ts`.
  - Changed TS/TSX or formatting: `npx eslint <changed-paths>` / `npx prettier --check <changed-paths>` when relevant.
  - Build, routing, or TypeScript integration: `npm run build` (also builds the MCP CLI; there is no `typecheck` npm script).
  - Browser flow: after a current `npm run build`, `npx playwright test tests/e2e/<file>.spec.ts --project=chromium`.
  - Shared browser adapters/static target: `npm run build:static`.
  - Desktop/native/storage/packaging behavior: relevant targeted tests and `npm run desktop:smoke` when affected.

- Playwright launches a standalone production build on `127.0.0.1:3199` with a temporary vault and refuses server reuse. `npm run test:e2e` builds and runs the whole browser suite; prefer selected specs when sufficient.
- Electron rebuilds `better-sqlite3` for its own runtime. Account for the native-module ABI when switching between Electron and Node validation; do not mistake a mismatched native build for an application regression.
- Broaden checks only for affected behavior, failures, or an explicit request. Do not repeat successful checks without further changes. Inspect the final diff, report what changed and what actually ran, and name remaining limitations without claiming unverified success.
