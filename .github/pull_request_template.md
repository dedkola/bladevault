## What changed

<!-- A short description of the change. Link the issue it resolves, e.g. "Closes #123". -->

## Why

<!-- The problem this solves or the behaviour it changes. -->

## How it was verified

<!-- The commands you ran and what you checked by hand (styles, light/dark, desktop/narrow widths). -->

- [ ] `npm run lint`
- [ ] `npm test` (or the relevant `tests/unit/…` / `tests/integration/…` files)
- [ ] `npm run build`
- [ ] Browser checks (`npx playwright test tests/e2e/<file>.spec.ts`) for UI flows
- [ ] Desktop checks (`npm run desktop:smoke`) if `electron/` or native modules changed

## Checklist

- [ ] The change is focused on one concern and follows [CONTRIBUTING.md](../CONTRIBUTING.md).
- [ ] No generated output, local databases, or personal collection data are committed.
- [ ] Schema migrations, if any, are repeat-safe and preserve existing data.
- [ ] UI changes include screenshots for the affected styles and modes.
