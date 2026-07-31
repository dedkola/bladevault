<div align="center">

  <img src="./public/logo.svg" alt="BladeVault logo" width="120" />

  # BladeVault

  **A sharp, local-first knife collection manager.**

  Catalog your knives, compare them side by side, and keep your collection data under your control.

  <p>
    <img src="https://img.shields.io/badge/Next.js-000000?logo=nextdotjs&logoColor=white&style=flat-square" alt="Next.js" />
    <img src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black&style=flat-square" alt="React" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white&style=flat-square" alt="TypeScript" />
    <img src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white&style=flat-square" alt="SQLite" />
    <img src="https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white&style=flat-square" alt="Electron" />
    <img src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white&style=flat-square" alt="Docker" />
    <img src="https://img.shields.io/badge/Helm-0F1689?logo=helm&logoColor=white&style=flat-square" alt="Helm" />
  </p>

  <p>
    <a href="https://github.com/dedkola/bladevault/releases/latest">Download latest release</a>
    ·
    <a href="https://youtu.be/yurbpv0JY80">Watch the demo</a>
  </p>

</div>

---

## What it does

- Keep detailed knife records with specifications, pricing, provenance, notes, links, and a local image gallery.
- Search, filter, pin, group, and bulk-edit your collection—including reusable custom text, number, and date fields.
- Import product details from supported retailer URLs, with an interactive browser fallback for pages that need it.
- Compare any number of knives side by side, focus on differences, and export or print the table as a landscape PDF.
- See collection insights such as recent additions, maker distribution, and acquisition activity.
- Run completely locally with SQLite, or opt into cloud backup when a BladeVault backup service is configured.

## Screenshots

<div align="center">

  <img src="assets/screenshots/dashboard.png" alt="BladeVault dashboard showing recent additions and collection insights" width="80%" />
  <p><sub>Dashboard — recent additions and collection insights</sub></p>

  <img src="assets/screenshots/detail.png" alt="Knife detail page with specifications and image gallery" width="80%" />
  <p><sub>Knife detail — specifications, notes, and image gallery</sub></p>

  <img src="assets/screenshots/compare.png" alt="Side-by-side knife comparison table" width="80%" />
  <p><sub>Compare — the details that matter, side by side</sub></p>

  <img src="assets/screenshots/add.png" alt="Add knife page with URL import and manual entry options" width="80%" />
  <p><sub>Add knife — import a product URL or enter it yourself</sub></p>

</div>

## Choose a setup

| Option | Best for | Start here |
| --- | --- | --- |
| Desktop app | A native macOS or Windows experience | [Download the latest release](https://github.com/dedkola/bladevault/releases/latest) |
| Docker or Podman | A self-hosted local instance | [Run a container](#run-in-a-container) |
| Kubernetes | k3s or another Kubernetes cluster | [Install with Helm](#install-with-helm) |
| Source | Development and customization | [Run from source](#run-from-source) |

## Run in a container

The prebuilt image stores the database and downloaded images in `/app/data`. Mount a host folder to keep that data when the container is replaced.

### Docker on macOS or Linux

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

### Podman on macOS or Linux

```bash
mkdir -p "$HOME/BladeVault/data"

podman run -d \
  --name bladevault \
  --restart unless-stopped \
  -p 5500:3000 \
  -v "$HOME/BladeVault/data:/app/data" \
  ghcr.io/dedkola/bladevault:latest
```

### Docker on Windows

```powershell
docker run -d `
  --name bladevault `
  --restart unless-stopped `
  -p 5500:3000 `
  -v "${env:USERPROFILE}\BladeVault\data:/app/data" `
  ghcr.io/dedkola/bladevault:latest
```

### Docker Compose

The included Compose file builds this checkout and uses a named Docker volume:

```bash
docker compose up -d --build
```

It is available at [http://localhost:5500](http://localhost:5500). To stop it without deleting the persistent volume, run `docker compose down`.

### Build the image yourself

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

## Install with Helm

The default chart is designed for k3s with MetalLB. It creates a dedicated
`LoadBalancer` address and a persistent 5 GiB volume for the SQLite database and
downloaded images.

```bash
helm repo add bladevault https://dedkola.github.io/bladevault

helm install bladevault bladevault/bladevault \
  --namespace bladevault \
  --create-namespace
```

Get the address, then open `http://<EXTERNAL-IP>`:

```bash
kubectl get service bladevault --namespace bladevault
```

If the repository was already added, run `helm repo update bladevault` before
installing. See the [chart README](charts/bladevault/README.md) for upgrades,
NGINX ingress with a hostname, existing PVCs, and other configuration.

## Desktop app

### macOS

Download [BladeVault.dmg](https://github.com/dedkola/bladevault/releases/latest/download/BladeVault.dmg), open it, then drag `BladeVault.app` to **Applications**.

Releases are unsigned. If macOS blocks the first launch, right-click the app, choose **Open**, and confirm. If needed, run:

```bash
xattr -d com.apple.quarantine "/Applications/BladeVault.app"
open "/Applications/BladeVault.app"
```

Updates use a user-assisted flow: select **Download update** in **Settings → About**, open the downloaded DMG, quit BladeVault, and replace the app in Applications.

### Windows

Download [BladeVault-Setup.exe](https://github.com/dedkola/bladevault/releases/latest/download/BladeVault-Setup.exe), run the installer, and open BladeVault from the Start menu or desktop shortcut.

Windows SmartScreen may show a warning for an unsigned build. Choose **More info** → **Run anyway** only if you trust the release source.

## Run from source

**Prerequisites:** Node.js 20 or newer. Install Chromium as well if you want to use URL import.

```bash
git clone https://github.com/dedkola/bladevault.git
cd bladevault
npm install
npx playwright install chromium
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js development server. |
| `npm run build` | Create a production build. |
| `npm run start` | Serve the production build after `npm run build`. |
| `npm run lint` | Run ESLint. |
| `npm run format:check` | Check formatting with Prettier. |
| `npm run desktop:dev` | Run the Electron desktop shell in development. |
| `npm run desktop:smoke` | Build and smoke-test the desktop runtime. |
| `npm run dist:desktop` | Package desktop installers without publishing them. |

## Your data

BladeVault is local-first: it works without an account or API key.

| Runtime | Default data location |
| --- | --- |
| Source | `~/BladeVault/data` |
| Docker or Podman | `/app/data` inside the container; mount it to a host folder for persistence |
| Desktop development | `~/.bladevault-desktop-dev/data` |

The data directory contains `bladevault.sqlite` and downloaded images. Back up the whole folder to preserve the collection.

Set `BLADEVAULT_DATA_DIR` to choose a different directory for a source or container runtime. Existing installations that use the legacy repo-local `data/bladevault.sqlite` continue using it until the database is moved or `BLADEVAULT_DATA_DIR` is set.

The desktop app can also move its local data folder from Settings when the location is not managed by `BLADEVAULT_DATA_DIR`.

## Optional cloud backup

Cloud backup is opt-in and leaves local storage as the source of truth. When the app is configured with BladeVault authentication and backup service URLs, sign in from **Settings → Cloud Backup** to upload or restore a complete archive, including images. Automatic backups can run hourly and after collection changes.

Self-hosted deployments can omit those service URLs; the rest of BladeVault works entirely locally.

## License

BladeVault is released under the [MIT License](LICENSE).

<div align="center">
  <sub>Built with precision for knife enthusiasts.</sub>
</div>
