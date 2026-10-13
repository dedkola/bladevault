BladeVault static browser deployment

This build starts with an empty collection and reuses the app's existing interface. It exports HTML, CSS, fonts, and browser JavaScript using Next.js, then serves them with Cloudflare Workers Static Assets on the free plan. It has no Worker script, server API, paid service, or sample records.

Manual collection changes, comparisons, maintenance, and appearance settings use browser session storage. They survive a reload in the same tab and are removed by Clear session or when the browser ends the tab session. Browser restore behavior can retain a session; do not use this preview as a durable vault. SQLite, scraping/screenshots, filesystem backup/restore, app lock, and MCP require the desktop or self-hosted runtime.

Install with Node 24 and `npm ci`, then run `npm run build:static`. The output is `static-app/out`. Run `npm run deploy:static` to rebuild and deploy the assets to the `bladevault` Worker and `bladevault.tkweb.dev` Custom Domain. Authenticate with `npx wrangler login` if necessary. No paid subscription is required.

`npm run dev:static` runs the separate static target locally. Navigation adapters are scoped to its webpack configuration; the normal Next.js app retains its own routing, proxy and server APIs. `wrangler.static.jsonc` uses SPA fallback for deep links. The build copies shared public assets and sets noindex and immutable caching for hashed files.

Cloudflare Workers Builds connects this repository to the `bladevault` Worker. Pushes to `main` deploy to `bladevault.tkweb.dev`; other branches create isolated previews using `npx wrangler preview --config wrangler.static.jsonc`. Both triggers build with `npm run build:static` and use the pinned Wrangler version. Cloudflare manages the build credentials, so no Cloudflare secret is stored in GitHub Actions.

GitHub's `test` workflow builds both the static target and the normal app, then runs the existing browser and desktop checks. The Cloudflare deployment check replaces the removed Vercel requirement alongside `test` and `CodeQL` in main's branch protection.
