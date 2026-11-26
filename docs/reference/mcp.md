# Model Context Protocol (MCP)

BladeVault exposes its existing local collection to MCP clients such as LM Studio, Codex, Claude Desktop, and Cursor. No separate database or cloud account is required.

## Tools

| Tool                    | Ability                                                              | Access     |
| ----------------------- | -------------------------------------------------------------------- | ---------- |
| `search_knives`         | Search text and exact BladeVault fields                              | Read-only  |
| `get_knife`             | Retrieve one complete knife record                                   | Read-only  |
| `get_collection_stats`  | Summarize completeness, categories, measurements, and recent records | Read-only  |
| `get_achievements`      | Report rank, score, unlocked badges, and progress on the rest        | Read-only  |
| `find_missing_fields`   | Find knives with missing built-in or custom fields                   | Read-only  |
| `find_duplicates`       | Score possible duplicate records without merging or deleting         | Read-only  |
| `propose_changes`       | Validate suggested values without modifying the collection           | Read-only  |
| `add_knife`             | Preview and add one new knife, with a duplicate check                | Write mode |
| `add_knife_images`      | Preview and add photos to one knife from image URLs                  | Write mode |
| `refill_knife_images`   | Preview and replace one knife's photos from its source page          | Write mode |
| `update_knife`          | Apply a timestamp-checked metadata update to one knife               | Write mode |
| `bulk_update_knives`    | Preview and atomically apply explicit multi-knife updates            | Write mode |
| `get_knife_maintenance` | Retrieve maintenance history for one knife                           | Read-only  |
| `add_maintenance_event` | Log a maintenance event for one knife                                | Write mode |
| `list_price_watches`    | List monitored knives with best price, state, and last change        | Read-only  |
| `list_price_changes`    | List price drops, increases, restocks, and out-of-stock items        | Read-only  |
| `get_price_history`     | Retrieve one knife's price history per store and its change events   | Read-only  |
| `get_price_watch`       | Retrieve one knife's monitoring mode, eligibility, and store sources | Read-only  |
| `get_price_attention`   | Summarize blocked, failed, and unavailable price checks              | Read-only  |
| `update_price_watch`    | Preview and apply mode and store URL changes for one knife           | Write mode |
| `request_price_check`   | Queue **Check now** for one knife at each store's normal pace        | Write mode |

Open **Settings → AI / MCP** to review activity, copy the local client configuration, enable or disable HTTP access, and allow or deny write access. Write mode is off by default.

Metadata updates require the expected record timestamp to prevent overwriting newer edits. They are recorded in the change log. Maintenance writes append dated events to a knife's history. Price monitoring writes change only the knife's monitoring mode and store sources. MCP cannot replace knife IDs, record timestamps, or entire records, and it cannot delete photos except through a previewed `replace` or refill.

`add_knife` previews by default and saves nothing. The preview returns the cleaned record, possible duplicates (same name and brand, or same model number), and a `preview_hash`. To add the knife, repeat the same request with `apply: true` and that hash. A possible duplicate blocks the add unless `allow_duplicate` is `true`, and a change made after the preview makes the hash stale. Optional `image_urls` attach photos in the same step (see below).

## Photos

`add_knife_images` adds photos from public image URLs (up to 12 per call), and `add_knife` accepts the same list as `image_urls`. `refill_knife_images` reads the knife's `source_url` with the same scraper as the app and replaces its photos with the product gallery, like **Refill all images**. All three preview by default: the server downloads and checks every image, saves nothing, and returns a status for each URL (`ok`, `duplicate`, or `error` with a reason) and a `preview_hash`. To save, repeat the request with `apply: true` and that hash. A change to the knife (or, for a refill, to the source page's image list) after the preview makes the hash stale.

- `mode: "append"` (the default) keeps the current photos. `mode: "replace"` and refills swap them for the new ones and keep a saved webpage screenshot.
- Images are saved exactly like uploads from the app, so they appear in the app, in `get_knife`, and in backups.
- URLs that fail are listed and skipped; the others are still saved. Images with the same bytes as a photo the knife already has are skipped.
- Only `https` URLs are downloaded, and every redirect is checked again. Local, private-network, link-local, and cloud metadata addresses are always refused.
- Each image must arrive within 20 seconds, be at most 25 MB, and really be a JPEG, PNG, GIF, WebP, or AVIF file (checked from its bytes). SVG and HTML are refused.
- By default any public host is allowed. To limit downloads to listed hosts (subdomains included), turn on **Allowed hosts only** under **Image downloads** in **Settings → AI / MCP**, or set `MCP_IMAGE_HOST_ALLOWLIST` to a comma-separated host list in Docker and other managed deployments.
- Every image change is recorded in the change log and History with the MCP tool and the source URLs.

Over stdio, `refill_knife_images` reads the page HTML directly; the in-app HTTP server renders it in the scraping browser first.

## Achievements

`get_achievements` reports the collector rank, score, and each badge with its unlock date or its progress (`current`, `target`, and readable `text` such as `6.4 / 10 kg`). Filter with `status` (`all`, `unlocked`, or `locked`) and `category`. Locked secret badges are only counted in `hiddenSecretCount`. The tool never records unlocks; the app does that as the collection changes. When achievements are off in Settings it says so and returns no badges.

## Price monitoring tools

The price tools use the same history as the [Price Drops](../guides/price-drops.md) page. Prices include a decimal `amount`, the `minor` units BladeVault stores, and the `currency`.

- `list_price_watches` returns monitored knives by default. Set `monitored_only` to `false` to include knives with a store URL that are not monitored, or filter by `state`: `attention`, `drop`, `increase`, `out_of_stock`, `same`, `pending`, or `not_monitored`.
- `list_price_changes` covers the last `days` (1–365, default 30) and can be limited to `drop`, `increase`, `back_in_stock`, or `out_of_stock` events, and to one `brand` (case-insensitive, part of the name) or `knife_id`. It also lists the store listings that are out of stock now.
- `get_price_history` accepts the same ranges as the Market tab: `7d`, `1m`, `3m`, `6m`, `1y`, or `all`.
- `get_price_watch` and `get_price_attention` describe problems with fixed text such as "bot check" or "no price found" rather than text read from store pages.

`update_price_watch` sets the mode (`auto`, `on`, or `off`) and adds, pauses, resumes, or removes store URLs by source ID. A knife can have at most 10 sources, URLs are normalized like the ones you add in the app, and the source from the knife's product link can only be paused. The tool previews by default. To apply, repeat the same request with `apply: true` and the returned `preview_hash`. A change made in the app after the preview makes the hash stale.

`request_price_check` marks every active source of one knife for **Check now**. The checks run at each store's next free slot, and stores paused after a bot check wait for their cooldown. Over stdio, the running BladeVault app or server performs the checks.

MCP never returns the AI provider key, custom request headers, saved store cookies, or page content.

## Connect Claude Desktop

Claude Desktop only starts local MCP servers, so a `url` entry in its config is ignored. In the desktop app, open **Settings → AI / MCP** and select **Connect** under **Claude Desktop**. BladeVault backs up `claude_desktop_config.json`, adds a `bladevault` entry, and leaves your other servers unchanged. Quit Claude Desktop completely (⌘Q on Mac) and reopen it.

The entry runs a small bridge (`mcp-stdio.cjs`) with the Electron runtime BladeVault already ships, so Node.js isn't needed. The bridge forwards each request to the running app, which still handles every read and write, so write access, timestamp checks, and the change log work as usual. It finds the app's port and token in `mcp-endpoint.json` in BladeVault's app data folder. If BladeVault is closed, Claude Desktop keeps the server listed and tool calls return a message asking you to open the app. On macOS, move BladeVault to Applications before connecting.

### Claude Desktop with Docker, a LAN server, or a source checkout

Outside the desktop app, **Settings → AI / MCP** shows a **Claude Desktop** config with **Copy config**. It runs [`mcp-remote`](https://github.com/geelen/mcp-remote) through `npx` as a local bridge to BladeVault's HTTP endpoint, so Node.js must be installed on the computer running Claude Desktop. Add the `bladevault` entry to `mcpServers` in `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), keep your other servers, then quit Claude Desktop completely and reopen it. The token is passed through `env` because Claude Desktop on Windows doesn't escape spaces in `args`. For plain HTTP to another machine the config adds `--allow-http`, so use it only on a network you trust.

## Connect Claude Code

Outside the desktop app, **Settings → AI / MCP** also shows a **Claude Code** command:

```bash
claude mcp add --transport http --scope user bladevault http://<SERVER_IP>:5500/mcp --header "Authorization: Bearer <TOKEN_FROM_BLADEVAULT_SETTINGS>"
```

`--scope user` makes BladeVault available in every project. Check it with `claude mcp list`.

## Connect an MCP client

Client configuration formats differ. Open **Settings → AI / MCP** through the address you want to use and select **Copy config**, or copy the displayed URL and token into your client's settings. For clients that accept an `mcpServers` JSON configuration:

```json
{
  "mcpServers": {
    "bladevault": {
      "url": "http://localhost:5500/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN_FROM_BLADEVAULT_SETTINGS>"
      }
    }
  }
}
```

| BladeVault runtime                    | MCP URL                       |
| ------------------------------------- | ----------------------------- |
| Docker or Podman on the same computer | `http://localhost:5500/mcp`   |
| Unraid or another LAN server          | `http://<SERVER_IP>:5500/mcp` |
| macOS or Windows desktop app          | `http://127.0.0.1:5501/mcp`   |
| Source checkout                       | `http://localhost:3000/mcp`   |

Replace the example URL as needed and replace the token placeholder with the value shown in BladeVault Settings. The copy buttons work on plain HTTP LAN addresses as well as secure origins.

For Unraid, map host port `5500` to container port `3000`. Keep the desktop app running while its MCP connection is in use. If desktop port `5501` is busy, BladeVault uses a free local port and **Copy config** includes the active URL.

### Codex

To connect Codex, add BladeVault to `~/.codex/config.toml`:

```toml
[mcp_servers.bladevault]
enabled = true
url = "http://<UNRAID_IP>:5500/mcp"
http_headers = { Authorization = "Bearer <TOKEN_FROM_BLADEVAULT_SETTINGS>" }
```

Use `http://localhost:5500/mcp` for Docker or Podman on the same computer, or use the active desktop URL shown in **Settings → AI / MCP**. Restart Codex after changing its configuration.

Codex also supports `bearer_token_env_var`, but its value must be the name of an environment variable containing the raw token, not `Bearer` followed by the token itself. The `http_headers` example above matches BladeVault's copied client configuration directly.

## Connect over stdio from source

For clients that launch a local MCP process, build the stdio entry point from your source checkout:

```bash
npm run mcp:build
```

Configure your client to run the built entry point directly:

```json
{
  "mcpServers": {
    "bladevault": {
      "command": "node",
      "args": ["/absolute/path/to/bladevault/dist/mcp/bladevault.mjs", "mcp"],
      "env": {
        "BLADEVAULT_DATA_DIR": "/absolute/path/to/BladeVault/data"
      }
    }
  }
}
```

Replace both paths with the paths to your checkout and existing vault data folder. Use an absolute path to your Node.js 26 executable if your client cannot find `node`. The client starts the process, so the web or desktop app does not need to be running. Stdio uses the same local database and write-access settings and does not require an HTTP token. To start the stdio server manually, run `npm run mcp`.

## Tokens and deployment overrides

BladeVault generates one permanent MCP access token and stores it with the persisted vault data. The token stays the same across restarts and updates.

- `MCP_AUTH_TOKEN`, `MCP_ALLOWED_HOSTS`, and `MCP_ALLOWED_ORIGINS` remain available as deployment overrides. When `MCP_AUTH_TOKEN` is set, its value is used instead of the app-generated token and is required for local and remote HTTP connections.
- `MCP_ENABLED` and `MCP_WRITE_ENABLED` remain available for administrators who explicitly add deployment overrides. Setting either variable locks its corresponding app control.
- While [App lock](data.md#optional-app-lock) is enabled, HTTP MCP clients need the existing MCP bearer token, including localhost clients. Local stdio MCP continues to use direct database access.

## Related

- [Review collection activity in History](../guides/review-collection-activity.md) — inspect changes made through MCP and the app.
- [Log maintenance and sharpening](../guides/log-maintenance.md) — manage dated maintenance events in the app.
