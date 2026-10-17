# Run from source

## Prerequisites

- **Node.js 24 LTS.** The repository pins Node.js `24.21.0` in [`.nvmrc`](https://github.com/dedkola/bladevault/blob/main/.nvmrc) for local development and CI; `package.json` declares `engines.node: ^24.18.1`.
- **Chromium** if you want to use URL import and webpage capture.
- Dependencies are installed with `npm ci` (the repository ships a `package-lock.json`).

## Set up the dev server

```bash
git clone https://github.com/dedkola/bladevault.git
cd bladevault
npm ci
npx playwright install chromium
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production server

Build the app, copy its public files and static assets into the standalone output, then start the generated server:

```bash
npm run build
node -e "const fs = require('node:fs'); for (const dir of ['public', '.next/static']) fs.cpSync(dir, '.next/standalone/' + dir, { recursive: true });"
node .next/standalone/server.js
```

Open [http://localhost:3000](http://localhost:3000). This project uses Next.js standalone output; use the generated server for production.

## Commands

Every script in `package.json`:

| Command                                  | Purpose                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`                            | Start the Next.js development server.                                               |
| `npm run build`                          | Create a production build, including the MCP CLI bundle.                            |
| `npm run start`                          | Serve a production build with `next start`.                                         |
| `npm run lint`                           | Run ESLint.                                                                         |
| `npm run format`                         | Format with Prettier.                                                               |
| `npm run format:check`                   | Check formatting with Prettier.                                                     |
| `npm run test`                           | Run the unit and integration suite once.                                            |
| `npm run test:watch`                     | Run unit and integration tests in watch mode.                                       |
| `npm run test:e2e`                       | Build the web app and run Chromium smoke tests.                                     |
| `npm run test:e2e:ui`                    | Open Playwright's interactive test runner.                                          |
| `npm run build:static`                   | Build the Cloudflare static app into `static-app/out`.                              |
| `npm run dev:static`                     | Run the static target locally.                                                      |
| `npm run deploy:static`                  | Deploy the built static assets to the Cloudflare Worker (run `build:static` first). |
| `npm run mcp:build`                      | Build the MCP stdio entry point.                                                    |
| `npm run mcp`                            | Build and start the MCP stdio server.                                               |
| `npm run build:desktop`                  | Build the desktop app (`next build` plus desktop preparation).                      |
| `npm run desktop:dev`                    | Run the Electron desktop shell in development.                                      |
| `npm run desktop:smoke`                  | Build and smoke-test the desktop runtime.                                           |
| `npm run rebuild:desktop-native`         | Rebuild `better-sqlite3` for Electron.                                              |
| `npm run sync:desktop-runtime`           | Sync the desktop runtime dependencies.                                              |
| `npm run dist:desktop`                   | Package desktop installers without publishing them.                                 |
| `npm run dist:desktop:dir`               | Package the desktop app as an unpacked directory.                                   |
| `npm run dist:desktop:mac:unsigned`      | Package an unsigned macOS DMG.                                                      |
| `npm run dist:desktop:mac:signed`        | Package a signed and notarised macOS DMG.                                           |
| `npm run verify:desktop:mac`             | Verify a macOS release build.                                                       |
| `npm run verify:desktop:windows-updater` | Verify the Windows updater flow.                                                    |
| `npm run clean`                          | Remove `.next`.                                                                     |

## Deployment overrides

The code reads the following environment variables. The ones marked with a default are optional.

| Variable                            | Effect                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `BLADEVAULT_DATA_DIR`               | Use a different data directory for a source or container runtime. See [Your data](../reference/data.md). |
| `NEXT_PUBLIC_BLADEVAULT_AUTH_URL`   | Override the cloud backup auth endpoint. Defaults to `https://auth.bladevault.pro`.                      |
| `NEXT_PUBLIC_BLADEVAULT_BACKUP_URL` | Override the cloud backup endpoint. Defaults to `https://backup.bladevault.pro`.                         |
| `MCP_AUTH_TOKEN`                    | Use a fixed MCP bearer token instead of the app-generated one.                                           |
| `MCP_ALLOWED_HOSTS`                 | Restrict the hosts MCP accepts.                                                                          |
| `MCP_ALLOWED_ORIGINS`               | Restrict the origins MCP accepts.                                                                        |
| `MCP_ENABLED`                       | Lock the corresponding app control for administrators.                                                   |
| `MCP_WRITE_ENABLED`                 | Lock the corresponding app control for administrators.                                                   |

See [Cloud backup](../reference/cloud-backup.md) and [MCP](../reference/mcp.md) for how the service endpoints and MCP overrides behave.

## Before you commit

CI runs formatting, workflow validation, lint, the unit and integration suite, the static build, the production build and the Playwright smoke tests — plus an Electron smoke test when desktop-sensitive files change. The [contributing guide](https://github.com/dedkola/bladevault/blob/main/CONTRIBUTING.md) lists the exact commands to run locally.
