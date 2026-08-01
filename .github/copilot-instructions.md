# BladeVault Copilot Instructions

## Build, test, lint, and run commands

- Install dependencies: `npm install`
- First-time scraper setup (source mode): `npx playwright install chromium`
- Run web app in development: `npm run dev`
- Build web app for production: `npm run build`
- Start production server: `npm run start`
- Unit and integration tests: `npm run test`
- Watch a focused test: `npm run test:watch -- <path-or-pattern>`
- Web smoke tests: `npm run test:e2e`
- Lint: `npm run lint`
- Docker local run (from README): `docker compose up -d --build`
- Desktop dev shell: `npm run desktop:dev`
- Desktop packaging smoke run: `npm run desktop:smoke`

### Tests

- Vitest unit and integration tests live under `tests/unit/` and `tests/integration/`.
- Playwright Chromium smoke tests live under `tests/e2e/`.
- Run a single Vitest file with `npm run test:watch -- tests/unit/<file>.test.ts`.
- Use `npm run desktop:smoke` for Electron, native SQLite, preload, or updater changes.

## High-level architecture

- **UI shell + state:** `app/layout.tsx` wraps the app in `KnivesProvider` and renders the dynamic sidebar shell (`components/sidebar-shell.tsx`), so route components consume shared client state from the provider.
- **Client data flow:** `components/providers/knives-provider.tsx` is the main client state orchestrator. It loads initial data from `/api/knives` and `/api/compare`, handles CRUD and compare mutations through API routes, and schedules silent cloud backup after mutations when enabled.
- **API surface:** App Router API handlers in `app/api/**/route.ts` are thin orchestration layers. They validate request payloads, call storage/config helpers, and return JSON payloads for the client.
- **Storage abstraction:** `lib/storage/types.ts` defines the storage contract, `lib/storage/index.ts` provides a singleton storage instance, and `lib/storage/local.ts` implements local persistence with SQLite + image files.
- **Local-first persistence:** `lib/local-db.ts` resolves runtime data location (`BLADEVAULT_DATA_DIR` → home dir `~/BladeVault/data` → legacy repo `data/` fallback), manages SQLite schema/migrations, and exposes container mount metadata used by settings.
- **Images:** Images are stored as files under `<dataDir>/images/<knifeId>/...`; client rendering goes through `getImageUrl()` (`lib/data.ts`) and API serving goes through `app/api/images/[...path]/route.ts`.
- **Scraping pipeline:** `/api/scrape` uses Playwright-rendered HTML first (`lib/scrape-playwright.ts`), falls back to plain fetch on render failures, then parses product/spec data with Cheerio (`lib/scrape.ts`) and enriches Shopify pages via the `.json` endpoint when available.
- **Cloud backup:** `/api/cloud-backup/archive` handles export, local restore from uploaded archive, and remote restore download; client cloud auth/config helpers live in `lib/cloud-backup.ts` and `lib/cloud-backup-client.ts`.
- **Desktop app mode:** `electron/main.cjs` launches either dev URL or embedded Next standalone server, enforces navigation/popup restrictions, and sets `BLADEVAULT_DATA_DIR` for desktop runtime data isolation.

## Key repository conventions

- Use the `@/*` alias (from `tsconfig.json`) for internal imports instead of deep relative paths.
- Route handlers consistently return `{ error: string }` on failures with meaningful HTTP status codes; client code should parse via `readJsonResponse()` / `getApiErrorMessage()` (`lib/api-response.ts`) to avoid brittle `response.json()` assumptions.
- Normalize knife text fields with `normalizeKnifeTextFields()` (`lib/knife-text.ts`) before persistence or migration. This is applied in local storage writes and DB normalization migrations.
- Knife IDs are slug-derived and uniqueness is enforced with numeric suffixing in `LocalStorage.ensureUniqueId()`; avoid introducing alternate ID generation paths.
- Compare state is persisted server-side in SQLite table `compare_list` and manipulated through `/api/compare`; do not treat compare selection as purely local UI state.
- Settings synchronization uses `SETTINGS_UPDATED_EVENT` (`lib/settings-shared.ts`) and cloud auth synchronization uses `CLOUD_AUTH_STATE_EVENT` (`lib/cloud-backup.ts`); these events are part of cross-component state refresh flow.
