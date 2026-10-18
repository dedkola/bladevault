# Quickstart

BladeVault runs on your own computer or server. You do not need an account or API key to get started.

## 1. Pick how you want to run it

| Option                                         | What you need                              | Time              |
| ---------------------------------------------- | ------------------------------------------ | ----------------- |
| [Desktop app](installation/desktop.md)         | macOS 13 Ventura+ or Windows               | Download and open |
| [Docker or Podman](installation/docker.md)     | A container runtime                        | About a minute    |
| [Kubernetes with Helm](installation/helm.md)   | k3s or another cluster with a LoadBalancer | A few minutes     |
| [Run from source](installation/from-source.md) | Node.js 24 and a checkout                  | A few minutes     |

To run the prebuilt container, create a data folder and start BladeVault:

```bash
mkdir -p "$HOME/BladeVault/data"

docker run -d \
  --name bladevault \
  --restart unless-stopped \
  -p 5500:3000 \
  -v "$HOME/BladeVault/data:/app/data" \
  ghcr.io/dedkola/bladevault:latest
```

Open [http://localhost:5500](http://localhost:5500).

## 2. Add your first knives

- **Import from a URL** — paste a retailer's product URL and review the imported details. If the page requires interaction, use the interactive browser fallback. See [Add a knife from a product URL](guides/add-knife-to-collection.md).
- **Import a list** — paste several links and let **Batch scrape** work through them one at a time. See [Add several knives at once](guides/add-several-knives.md).
- **Enter it manually** — add specifications, a price, notes, a source link, and local photos yourself. See [Add a knife manually](guides/add-knife-in-manual-mode.md).

## 3. Make the collection yours

- Add [custom fields](guides/custom-fields.md) for text, numbers, and dates, and [choose which details appear on cards](guides/customize-appearance.md) and in the pinned sidebar.
- Save search and filters as a [Smart Collection](guides/smart-collections.md) that updates as your records change.
- Browse variants in [Model families](guides/model-families.md), or [search and filter](guides/search-and-filter.md) to find a specific knife.
- Use [bulk actions](guides/bulk-actions.md) to edit or pin several records at once.

See [Organize your collection](guides/collection.md) for an overview.

## 4. Compare, maintain, understand

- **Compare** — build named shortlists, show only the differences, export to PDF. See [Compare knives](guides/compare.md).
- **Maintain** — [log cleaning, lubrication, sharpening, stropping, and disassembly](guides/log-maintenance.md) with dated notes. Review changes and care history in [Logs](guides/review-collection-activity.md).
- **Insights** — explore makers, materials, dimensions, completeness, and activity. See [Collection insights](guides/insights.md).
- **Improve records** — find missing fields, review measurements, and standardize labels. See [Improve collection data quality](guides/improve-data-quality.md).

## 5. Protect the data

BladeVault is local-first: the vault is a SQLite database plus local images in a folder you choose.

- **Where it lives** — `~/BladeVault/data` by default for the desktop app and source runs, `/app/data` inside a container. See [Your data](reference/data.md).
- **App lock** — an optional password on the local vault (off by default). See [App lock](reference/data.md#optional-app-lock).
- **Backups** — download a portable full-vault ZIP or enable optional cloud backup. See [Back up and restore your vault](guides/back-up-and-restore-your-vault.md).

## Next steps

- Connect an AI client to your collection with [MCP](reference/mcp.md).
- Running from a checkout? [Run from source](installation/from-source.md) lists every command, including the test suites.
- Want to contribute? See the [contributing guide](https://github.com/dedkola/bladevault/blob/main/CONTRIBUTING.md).
