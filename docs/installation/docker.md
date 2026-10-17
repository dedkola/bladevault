# Docker and Podman

The prebuilt image stores the database and local images in `/app/data`. Mount a host folder to keep that data when the container is replaced.

The examples use `:latest`, which follows successful builds of `main` and can include changes newer than the published release. For a specific release, use its version tag, such as `ghcr.io/dedkola/bladevault:v1.3.1`.

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
- **URL import and capture** — the published image is ready for source-page capture; when running from a checkout you additionally need Chromium (see [Run from source](from-source.md)).
- **MCP from a container** — the client URL is `http://localhost:5500/mcp` when the container runs on the same computer. See [MCP](../reference/mcp.md).
