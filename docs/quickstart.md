# Quickstart

BladeVault runs entirely on your own machine (or your own server) — there is no account and no API key to start.

## 1. Pick how you want to run it

| Option                                         | What you need                              | Time              |
| ---------------------------------------------- | ------------------------------------------ | ----------------- |
| [Desktop app](installation/desktop.md)         | macOS 13 Ventura+ or Windows               | Download and open |
| [Docker or Podman](installation/docker.md)     | A container runtime                        | About a minute    |
| [Kubernetes with Helm](installation/helm.md)   | k3s or another cluster with a LoadBalancer | A few minutes     |
| [Run from source](installation/from-source.md) | Node.js 24 and a checkout                  | A few minutes     |

The fastest self-hosted path is one container command from [Docker and Podman](installation/docker.md):

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

- **Import from a URL** — paste a product URL from a supported retailer and BladeVault fills in the details. If the page needs a human touch, the import opens an interactive browser fallback so you can finish it yourself. See [Add Knife to collection](guides/add-knife-to-collection.md).
- **Enter it manually** — add specifications, pricing, provenance, notes, links, and local photos yourself.

## 3. Make the collection yours

- Add **custom fields** (text, number, date) and choose which details appear on cards and in the pinned sidebar.
- Save a filter as a **Smart Collection** that updates as your records change.
- Browse variants together in **Model families**, and use global search for model names or `/model A4301` for model numbers.

See [Organize your collection](guides/collection.md) for the full set.

## 4. Compare, maintain, understand

- **Compare** — build named shortlists, show only the differences, export to PDF. See [Compare knives](guides/compare.md).
- **Maintain** — log cleaning, lubrication, sharpening, stropping and disassembly with dated notes. Review everything in **Logs**.
- **Insights** — explore makers, materials, dimensions, completeness, and activity. See [Collection insights](guides/insights.md).

## 5. Protect the data

BladeVault is local-first: the vault is a SQLite database plus local images in a folder you choose.

- **Where it lives** — `~/BladeVault/data` by default for the desktop app and source runs, `/app/data` inside a container. See [Your data](reference/data.md).
- **App lock** — an optional password on the local vault (off by default). See [App lock](reference/data.md#optional-app-lock).
- **Backups** — **Settings → Backup & Restore → Download ZIP** writes a portable full-vault archive; [cloud backup](reference/cloud-backup.md) is opt-in and keeps local storage as the source of truth.

## Next steps

- Connect an AI client to your collection with [MCP](reference/mcp.md).
- Running from a checkout? [Run from source](installation/from-source.md) lists every command, including the test suites.
- Want to contribute? See the [contributing guide](https://github.com/dedkola/bladevault/blob/main/CONTRIBUTING.md).
