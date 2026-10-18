# Capture source pages

Save a **full-page screenshot** of a knife's source page so you can check its original specifications even if the website changes or removes the listing.

## What you get

- URL import attempts to capture the product page along with its details.
- A saved capture can be viewed or downloaded from the knife's gallery.
- You can capture a missing screenshot or replace an existing one in the knife's edit form.
- A batch action in Settings captures missing screenshots for older records with source URLs.

## View or download a saved capture

1. Click a knife's card in **Collection**, then choose **Open full page →** in its preview.
2. Select its webpage screenshot in the gallery and open it fullscreen.
3. Scroll through the saved page, or choose **Download PNG** to save a copy.

The capture shows the website as it appeared when the screenshot was taken. It does not update when the source page changes.

## Capture or replace one screenshot

1. Open a knife that has a saved source URL, click **Edit**, and find its image controls.
2. Click **Capture webpage screenshot**. If a capture already exists, the button reads **Replace webpage screenshot**.
3. When replacing a capture, confirm that you want a new screenshot of the website as it appears today.
4. Wait for the capture to finish, then review it in the gallery. If it fails, read the error and try again when the website is available.

Replacing a capture overwrites the saved screenshot. Download the old PNG first if you want to keep both versions.

## Capture missing screenshots for older records

1. Open **Settings → Local storage**.
2. Find **Capture missing webpage screenshots** and review the remaining count.
3. Click **Capture missing screenshots**. Keep the page open while it works through the list.
4. To pause, click **Stop after current item**. Use **Resume / retry missing screenshots** to continue later.
5. Review any failed entries. Retry them, or use **Skip** for a source that is no longer available.

This action fills missing captures. It does not refresh screenshots that are already saved. The panel is hidden when there are no remaining captures or errors to review.

## Where captures live

Captures are stored with your vault data and included in full-vault backups. Use **Settings → Backup & Restore → Download ZIP** for a local copy, or optional [cloud backup](../reference/cloud-backup.md) for a copy on another server. See [Back up and restore your vault](back-up-and-restore-your-vault.md) for the steps.

## Requirements

Capture uses a real browser, so it needs Chromium:

- **From source:** `npx playwright install chromium`.
- **Docker, desktop, Kubernetes:** the shipped image and desktop build already include it.

Capture depends on the source site responding. If a retailer blocks the import or requires a click, see the interactive browser workflow in [Add a knife from a product URL](add-knife-to-collection.md). The browser opens on the computer running BladeVault; a browser inside a remote container is not streamed to your screen.
