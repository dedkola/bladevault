# Model Context Protocol (MCP)

BladeVault exposes its existing local collection to MCP clients such as LM Studio, Codex, Claude Desktop, and Cursor. No separate database or cloud account is required.

## Tools

| Tool                    | Ability                                                              | Access     |
| ----------------------- | -------------------------------------------------------------------- | ---------- |
| `search_knives`         | Search text and exact BladeVault fields                              | Read-only  |
| `get_knife`             | Retrieve one complete knife record                                   | Read-only  |
| `get_collection_stats`  | Summarize completeness, categories, measurements, and recent records | Read-only  |
| `find_missing_fields`   | Find knives with missing built-in or custom fields                   | Read-only  |
| `find_duplicates`       | Score possible duplicate records without merging or deleting         | Read-only  |
| `propose_changes`       | Validate suggested values without modifying the collection           | Read-only  |
| `update_knife`          | Apply a timestamp-checked metadata update to one knife               | Write mode |
| `bulk_update_knives`    | Preview and atomically apply explicit multi-knife updates            | Write mode |
| `get_knife_maintenance` | Retrieve maintenance history for one knife                           | Read-only  |
| `add_maintenance_event` | Log a maintenance event for one knife                                | Write mode |

Open **Settings → AI / MCP** to review activity, copy the local client configuration, enable or disable HTTP access, and allow or deny write access. Write mode is off by default.

Metadata updates require the expected record timestamp to prevent overwriting newer edits. They are recorded in the change log. Maintenance writes append dated events to a knife's history. MCP cannot replace knife IDs, record timestamps, images, or entire records.

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

Replace both paths with the paths to your checkout and existing vault data folder. Use an absolute path to your Node.js 24 executable if your client cannot find `node`. The client starts the process, so the web or desktop app does not need to be running. Stdio uses the same local database and write-access settings and does not require an HTTP token. To start the stdio server manually, run `npm run mcp`.

## Tokens and deployment overrides

BladeVault generates one permanent MCP access token and stores it with the persisted vault data. The token stays the same across restarts and updates.

- `MCP_AUTH_TOKEN`, `MCP_ALLOWED_HOSTS`, and `MCP_ALLOWED_ORIGINS` remain available as deployment overrides. When `MCP_AUTH_TOKEN` is set, its value is used instead of the app-generated token and is required for local and remote HTTP connections.
- `MCP_ENABLED` and `MCP_WRITE_ENABLED` remain available for administrators who explicitly add deployment overrides. Setting either variable locks its corresponding app control.
- While [App lock](data.md#optional-app-lock) is enabled, HTTP MCP clients need the existing MCP bearer token, including localhost clients. Local stdio MCP continues to use direct database access.

## Related

- [Review collection activity in Logs](../guides/review-collection-activity.md) — inspect changes made through MCP and the app.
- [Log maintenance and sharpening](../guides/log-maintenance.md) — manage dated maintenance events in the app.
