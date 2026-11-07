# Error reporting

BladeVault can send crash and error reports, plus anonymous product-import statistics, to [Sentry](https://sentry.io). It is off by default and sends nothing until someone agrees: in the app's **Help improve BladeVault?** question, or by the person running a server setting their own DSN.

| Runtime                      | Error reporting                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Official Docker image, Helm  | Asks once in the app. Off unless someone agrees. The answer applies to everyone using that server. |
| Your own `SENTRY_DSN`        | Always on, sent to your Sentry project. The app does not ask.                                      |
| Locally built image, source  | Off unless you set `SENTRY_DSN`.                                                                   |
| Desktop app (macOS, Windows) | Asks you on first launch and after updates. Off unless you agree.                                  |
| Static browser preview       | Off.                                                                                               |

## The official Docker image asks first

The image published on GHCR and Docker Hub includes the BladeVault project's Sentry address, but sends nothing until someone answers. The first time BladeVault is opened in a browser, a **Help improve BladeVault?** card appears in the bottom corner:

- **Send Reports** turns on crash reports and anonymous usage data right away. No restart is needed.
- **Don't Send** keeps it off. The card does not appear again.

The answer is saved in the vault, so it applies to everyone who uses that BladeVault server and is kept in backups and restores. Change it in **Settings → About → Send error reports**.

To never send reports and never show the question, set `BLADEVAULT_ERROR_REPORTING=off` on the container (in `.env` next to `docker-compose.yml`, or in the Helm chart's `env` list).

## Use your own Sentry project

Set these environment variables on the container or server process and restart it:

| Variable                     | Effect                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                 | Sentry project DSN (starts with `https://`). Setting it turns error reporting and import statistics on. |
| `SENTRY_ENVIRONMENT`         | Environment name shown in Sentry. Defaults to `production`.                                             |
| `BLADEVAULT_ERROR_REPORTING` | `off` turns reporting off and hides the in-app question, unless `SENTRY_DSN` is set.                    |

With Docker Compose, add them to `.env` next to `docker-compose.yml`:

```bash
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
```

Your own `SENTRY_DSN` replaces the built-in address and turns reporting on without asking, because you, as the operator, have chosen it. The DSN is read when the server starts. The browser receives it from the server with each page.

## The desktop app asks first

On first launch, before the window opens, the desktop app asks **Help improve BladeVault?**

- **Send Reports** turns on crash reports and anonymous usage data. BladeVault restarts once, about a second, and does not ask again.
- **Don't Send** keeps it off. BladeVault asks again after the next update.

If you agreed in BladeVault 2.2.0, before usage data was added, you are asked once more so you can see the new wording. Answering **Don't Send** then turns reporting off completely.

To change your answer later:

1. Open **Settings → About**.
2. Under **Error reporting**, check or uncheck **Send error reports**.
3. Click **Restart now**. The change applies after the restart.

Turning it off in Settings counts as **Don't Send** for this version. The choice is stored in the app's user-data folder, not in your vault, so it does not travel with backups. The option shows "Not available in this build" in development builds and builds made without the release configuration.

When it is on, the desktop app also reports native crashes (for example a crashed window or GPU process) and unexpected exits of its built-in server.

## What is sent

Reports cover unexpected server errors (API requests that fail with HTTP 500, page render failures) and unexpected errors in the browser. Each report includes the error message and stack trace, the BladeVault release (for example `bladevault@2.1.0`), the runtime (`docker`, `desktop`, or `server`), the CPU architecture, and basic OS and browser details.

BladeVault removes the following before a report leaves the server or browser:

- request headers, cookies, bodies, and URL query strings
- user details and the server host name
- bearer tokens, JWTs, `token=`/`password=`-style values, and email addresses in messages
- your home folder path, which is replaced with `~`
- stack frame variables and console arguments

Knife records, images, notes, and backups are never attached. Performance tracing and Session Replay are not enabled.

## Anonymous usage data

BladeVault counts each product import as one `scrape.attempt` metric, so imports that stop working for a shop are noticed early. Each count carries only:

| Label      | Values                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------- |
| `domain`   | The shop's website, for example `sog.com`. `unknown` for private addresses and invalid input. |
| `method`   | `url`, `saved_page`, or `interactive`                                                         |
| `result`   | `ok`, or why it failed: `timeout`, `challenge`, `network`, `http`, `browser`, and so on       |
| `quality`  | For successful imports: `complete`, `no_images`, or `no_name`                                 |
| `renderer` | For URL imports: `browser` or `html_fallback`                                                 |

The full product address, the knife's details, and anything about you are not sent. Servers send these counts whenever `SENTRY_DSN` is set. The desktop app sends them only if you answered **Send Reports** to the current wording.

## Maintainers: readable stack traces

Release workflows upload source maps so Sentry can show the original TypeScript. Uploads run only when `SENTRY_AUTH_TOKEN` is available, so local builds, forks, and pull requests build exactly as before.

Configure in the GitHub repository:

| Name                 | Kind     | Value                                                                   |
| -------------------- | -------- | ----------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN`  | Secret   | Sentry organization token with source map upload access.                |
| `SENTRY_ORG`         | Variable | Sentry organization slug.                                               |
| `SENTRY_PROJECT`     | Variable | Sentry project slug for the app (for example `bladevault-app`).         |
| `SENTRY_DESKTOP_DSN` | Variable | DSN for desktop crashes and Electron errors (`bladevault-desktop`).     |
| `SENTRY_APP_DSN`     | Variable | DSN the desktop app's built-in server and pages use (`bladevault-app`). |

The Docker workflow passes the token to the image build as a BuildKit secret on release tags only, so it is never stored in an image layer. The desktop release workflow uploads from both the macOS and Windows builds. Source maps are deleted from the build output after upload.

The desktop release workflow also writes `SENTRY_DESKTOP_DSN` and `SENTRY_APP_DSN` into the packaged app's `package.json`. Without both, the desktop option is unavailable. For readable native crash stacks, enable the Electron symbol server in the `bladevault-desktop` project (Sentry → Project Settings → Debug Files → Built-in Repositories).
