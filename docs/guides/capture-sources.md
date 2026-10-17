# Capture source pages

Product pages change and disappear. BladeVault can store a **full-page screenshot** of the page a record came from, so the evidence behind an import stays with the knife.

## What you get

- A full-page capture saved alongside the record when you import a product URL.
- The capture can be **viewed or downloaded** later from the record.
- Failed captures can be **retried**.
- Older records can be **backfilled**, so knives imported before you started capturing can still gain their source page.

## Where captures live

Captures are stored with your vault data and are included in **local ZIP backups** and in [cloud backups](../reference/cloud-backup.md) — no separate asset store to manage.

## Requirements

Capture uses a real browser, so it needs Chromium:

- **From source:** `npx playwright install chromium`.
- **Docker, desktop, Helm:** the shipped image and desktop build already include it.

Capture depends on the source site responding. Some retailers block automated access — that is what the interactive browser fallback in [Add Knife to collection](add-knife-to-collection.md) is for.
