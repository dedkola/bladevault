# Contributing to BladeVault

Thanks for taking the time to contribute. BladeVault is a local-first knife-collection manager
(Next.js web app, Electron desktop build, MCP server). This guide covers how to get a working
development environment, what to run before opening a pull request, and the conventions the
project follows.

- **New here?** The [README](README.md) covers what the app does, every way to run it (Docker,
  Podman, Compose, Helm, desktop, from source), and your data model.
- **Participating in this project means agreeing to the [Code of Conduct](CODE_OF_CONDUCT.md).**

## Ways to contribute

- **Report a bug** — open an issue with what you did, what you expected, what happened, and which
  way you run BladeVault (Docker / Helm / desktop / from source) plus the version.
- **Request a feature** — open an issue describing the problem it solves, not only the solution.
- **Send a pull request** — small, focused changes are the easiest to review and merge. If a change
  is large or changes behaviour, open an issue first so we can agree on the approach.

## Requirements

- **Node.js** — the pinned version in [`.nvmrc`](.nvmrc) (currently 24.21.0). CI reads the same
  file, so matching it locally avoids "works on my machine" failures.
  `package.json` declares `engines.node: ^24.18.1`.
- **npm** — the repository ships a `package-lock.json`, so use `npm ci` for a reproducible install.
  Do not switch lockfiles or package managers in a PR.
- Optional, only for the paths you touch: Docker or Podman (container images), a Kubernetes cluster
  and Helm (chart work), macOS for signing and notarising desktop releases.

## Set up

```bash
git clone https://github.com/dedkola/bladevault.git
cd bladevault
npm ci          # exact dependency versions, including the native better-sqlite3 build
npm run dev     # Next.js dev server
```

Environment variables and every alternative runtime (container, Helm, desktop, MCP) are documented
in the [README](README.md) — this guide deliberately does not duplicate them.

## Project layout

| Path                               | What lives there                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `app/`                             | Next.js App Router routes (`add`, `api`, `collection`, `compare`, `insights`, `logs`, `mcp`, `settings`, `unlock`) |
| `components/`                      | React components, including `components/ui` primitives                                                             |
| `lib/`                             | Domain logic, `lib/services`, `lib/storage`, `lib/mcp`                                                             |
| `electron/`                        | Desktop shell and packaging                                                                                        |
| `cli/`, `scripts/`                 | Build, release and maintenance tooling (`scripts/*.cjs`)                                                           |
| `tests/`                           | `unit/`, `integration/`, `e2e/` (Playwright), plus `helpers/` and `fixtures/`                                      |
| `charts/bladevault/`               | Helm chart (see its own [README](charts/bladevault/README.md))                                                     |
| `static-app/`                      | Cloudflare static variant (see [README](static-app/README.md))                                                     |
| `docker-compose.yml`, `Dockerfile` | Container builds                                                                                                   |
| `data/`, `public/`                 | Local data and static assets                                                                                       |

## Commands

Everything runs through npm scripts defined in `package.json`:

| Command                                       | Purpose                                                               |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                                 | Next.js dev server                                                    |
| `npm test`                                    | Vitest unit and integration suite                                     |
| `npm run test:watch`                          | Vitest in watch mode                                                  |
| `npm run test:e2e`                            | Builds the production app, then runs Playwright browser tests         |
| `npm run test:e2e:ui`                         | Playwright UI mode                                                    |
| `npm run lint`                                | ESLint                                                                |
| `npm run format` / `npm run format:check`     | Prettier write / verify                                               |
| `npm run build`                               | Production build, including the MCP CLI bundle                        |
| `npm run build:static` / `npm run dev:static` | Cloudflare static app build / dev server                              |
| `npm run mcp`                                 | Build and run the MCP server                                          |
| `npm run build:desktop`                       | Desktop build (then `rebuild:desktop-native`, `sync:desktop-runtime`) |
| `npm run desktop:dev`                         | Desktop app in development                                            |
| `npm run clean`                               | Remove `.next`                                                        |

## Before you open a pull request

Keep local validation proportional to the change. For text-only edits, inspect the diff.
For behavior changes, run the smallest relevant checks. Do not run full test suites,
builds, or browser checks for text-only edits unless explicitly requested.
The commands below are available checks, not a mandatory checklist for every edit:

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # Vitest unit + integration
npm run build          # production build
npm run test:e2e       # Playwright smoke tests (builds first)
```

The workflow also validates the GitHub Actions workflows and builds the Cloudflare static app, and
it runs an **Electron smoke test only when desktop-sensitive files change**. If you touch
`electron/`, native modules, or the desktop packaging scripts, also run:

```bash
npm run rebuild:desktop-native   # rebuilds better-sqlite3 for Electron
npm run desktop:dev              # or npm run build:desktop
```

Some checks only ever run in CI (container scanning, dependency review, release and Helm
workflows). You do not need to reproduce releases locally.

## Branches, commits and pull requests

- **Branch from `main`**, one branch per piece of work. Use a descriptive prefix such as `feat/`,
  `fix/`, `docs/` or `chore/` — for example `fix/compare-model-number-search`.
- **Commit messages follow Conventional Commits**, with a scope when it helps:
  `feat(collection): mark knives as sold`, `fix(batch-scrape): skip already-saved products`,
  `build(deps): bump zod`. This is what the project's history uses, and it keeps the changelog and
  release tooling sane.
- **Keep pull requests focused.** One concern per PR; unrelated cleanups make review slower and
  riskier. Describe what changed, why, and how you verified it — including the commands you ran.
- **Do not commit generated output or local data**: `.next`, `build`, `dist`, `node_modules`,
  local databases and any personal collection data stay out of the repository.
- **Merges to `main` are done by the maintainer.** A green CI run plus review is what a PR needs;
  do not merge your own pull request.
- **Dependencies** are updated by Dependabot. If you change a dependency, update
  `package-lock.json` with npm and explain why in the PR.

## Reporting security issues

Do not open a public issue for a vulnerability — use the repository's private vulnerability
reporting (Security → Report a vulnerability) so the report stays confidential until there is a
fix.

## License

BladeVault is released under the [MIT License](LICENSE). By contributing, you agree that your
contributions are licensed under the same terms.
