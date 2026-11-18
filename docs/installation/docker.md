# Docker and Podman

The prebuilt image stores the database and local images in `/app/data`. Mount a host folder to keep that data when the container is replaced.

The examples use `:latest`, which follows successful builds of `main` and can include changes newer than the published release. For a specific release, use its version tag, such as `ghcr.io/dedkola/bladevault:v2.0.3`.

## Docker on macOS or Linux

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

## Podman on macOS or Linux

```bash
mkdir -p "$HOME/BladeVault/data"

podman run -d \
  --name bladevault \
  --restart unless-stopped \
  -p 5500:3000 \
  -v "$HOME/BladeVault/data:/app/data" \
  ghcr.io/dedkola/bladevault:latest
```

## Docker on Windows

```powershell
docker run -d `
  --name bladevault `
  --restart unless-stopped `
  -p 5500:3000 `
  -v "${env:USERPROFILE}\BladeVault\data:/app/data" `
  ghcr.io/dedkola/bladevault:latest
```

## Docker Compose

The included Compose file builds the source and uses named Docker volumes for the vault data and the bounded optimized-image cache. From a new checkout:

```bash
git clone https://github.com/dedkola/bladevault.git
cd bladevault
docker compose up -d --build
```

If you already have a checkout, run the Compose command from its root directory. Open [http://localhost:5500](http://localhost:5500). To stop it without deleting the persistent volume, run `docker compose down`.

## Error reports

The first time you open BladeVault, it asks whether to send crash reports and anonymous usage data. Nothing is sent unless someone agrees. To turn this off for good, set `BLADEVAULT_ERROR_REPORTING=off`. See [Error reporting](../reference/error-reporting.md).

## Price monitoring

[Price Drops](../guides/price-drops.md) checks store prices in the background inside the same container; there is no extra process or service. These environment variables adjust it:

| Variable                      | Effect                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TZ`                          | The time zone for **Only check between** hours, for example `Europe/Berlin`. Without it, the container uses UTC.               |
| `BLADEVAULT_PRICE_MONITOR`    | Set to `off` to stop all background price checks. **Check now** in the app still works.                                        |
| `BLADEVAULT_PRICE_AI_API_KEY` | The API key for the optional AI assistance. It overrides a key saved in Settings and is never written to the vault or backups. |

Add them with `-e`, for example `-e TZ=Europe/Berlin`, or set them in the shell before `docker compose up`; the Compose file passes them through. When a store shows a bot check, the image retries once in a visible browser on its built-in virtual display.

## Build the image yourself

```bash
git clone https://github.com/dedkola/bladevault.git
cd bladevault
docker build -t bladevault .

docker run -d \
  --name bladevault \
  --restart unless-stopped \
  -p 5500:3000 \
  -v "$HOME/BladeVault/data:/app/data" \
  bladevault
```

## Notes

- **Data persistence** — everything lives in `/app/data` inside the container: `bladevault.sqlite` plus local images. That is what the `-v` mount keeps. See [Your data](../reference/data.md).
- **Unraid or another LAN server** — map host port `5500` to container port `3000`, then reach the app at `http://<SERVER_IP>:5500` and MCP at `http://<SERVER_IP>:5500/mcp`.
- **URL import and capture** — the published image includes the browser runtime for imports and source-page capture. A source checkout needs Chromium installed separately. See [Run from source](from-source.md).
- **MCP from a container** — the client URL is `http://localhost:5500/mcp` when the container runs on the same computer. See [MCP](../reference/mcp.md).
