# Error reporting

BladeVault can send crash and error reports to [Sentry](https://sentry.io). It is off by default and sends nothing unless the person running the server turns it on.

| Runtime                      | Error reporting                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Docker, Podman, Helm, source | Off until you set `SENTRY_DSN`. You can point it at your own Sentry project.      |
| Desktop app (macOS, Windows) | Off. An in-app opt-in is planned; until then the desktop app never sends reports. |
| Static browser preview       | Off.                                                                              |

## Turn it on for a server

Set these environment variables on the container or server process and restart it:

| Variable             | Effect                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `SENTRY_DSN`         | Sentry project DSN (starts with `https://`). Setting it turns error reporting on. |
| `SENTRY_ENVIRONMENT` | Environment name shown in Sentry. Defaults to `production`.                       |

With Docker Compose, add them to `.env` next to `docker-compose.yml`:

```bash
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
```

The DSN is read when the server starts, so one public image works with any Sentry project or none. The browser receives it from the server with each page; it is not built into the image.

## What is sent

Reports cover unexpected server errors (API requests that fail with HTTP 500, page render failures) and unexpected errors in the browser. Each report includes the error message and stack trace, the BladeVault release (for example `bladevault@2.1.0`), the runtime (`docker`, `desktop`, or `server`), the CPU architecture, and basic OS and browser details.

BladeVault removes the following before a report leaves the server or browser:

- request headers, cookies, bodies, and URL query strings
- user details and the server host name
- bearer tokens, JWTs, `token=`/`password=`-style values, and email addresses in messages
- your home folder path, which is replaced with `~`
- stack frame variables and console arguments

Knife records, images, notes, and backups are never attached. Performance tracing and Session Replay are not enabled.

## Maintainers: readable stack traces

Release workflows upload source maps so Sentry can show the original TypeScript. Uploads run only when `SENTRY_AUTH_TOKEN` is available, so local builds, forks, and pull requests build exactly as before.

Configure in the GitHub repository:

| Name                | Kind     | Value                                                           |
| ------------------- | -------- | --------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN` | Secret   | Sentry organization token with source map upload access.        |
| `SENTRY_ORG`        | Variable | Sentry organization slug.                                       |
| `SENTRY_PROJECT`    | Variable | Sentry project slug for the app (for example `bladevault-app`). |

The Docker workflow passes the token to the image build as a BuildKit secret on release tags only, so it is never stored in an image layer. The desktop release workflow uploads from both the macOS and Windows builds. Source maps are deleted from the build output after upload.
