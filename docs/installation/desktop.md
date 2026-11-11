# Desktop app

The desktop app provides BladeVault's interface in its own window and stores the vault in your user folder.

## macOS

BladeVault requires macOS 13 Ventura or newer.

Download [BladeVault.dmg](https://github.com/dedkola/bladevault/releases/latest/download/BladeVault.dmg), open it, then drag `BladeVault.app` to **Applications**.

Releases are unsigned. If macOS blocks the first launch, right-click the app, choose **Open**, and confirm. If needed, run:

```bash
xattr -d com.apple.quarantine "/Applications/BladeVault.app"
open "/Applications/BladeVault.app"
```

To update, select **Download update** in **Settings → About**, open the downloaded DMG, quit BladeVault, and replace the app in **Applications**.

## Windows

Download [BladeVault-Setup.exe](https://github.com/dedkola/bladevault/releases/latest/download/BladeVault-Setup.exe), run the installer, and open BladeVault from the Start menu or desktop shortcut.

Windows SmartScreen may show a warning for an unsigned build. Choose **More info** → **Run anyway** only if you trust the release source.

Check for updates in **Settings → About**. Download an available update, then select **Restart to update** to install it.

## Linux

BladeVault ships two x86-64 builds for Linux, both built on Ubuntu 22.04, so they need a distribution with glibc 2.35 or newer. Pick one:

| Build                             | Best for                                           | Updates                                 |
| --------------------------------- | -------------------------------------------------- | --------------------------------------- |
| [AppImage](#appimage)             | Any distribution, no root needed                   | In the app, from **Settings → About**   |
| [Debian package](#debian-package) | Debian, Ubuntu, and derivatives; adds a menu entry | Install the new `.deb` over the old one |

Both use the same data folder, `~/BladeVault/data`, so you can switch between them, and updating never touches your vault.

### AppImage

**Install**

Download [BladeVault.AppImage](https://github.com/dedkola/bladevault/releases/latest/download/BladeVault.AppImage), move it somewhere permanent, make it executable, and run it:

```bash
mkdir -p ~/Applications
mv ~/Downloads/BladeVault.AppImage ~/Applications/
chmod +x ~/Applications/BladeVault.AppImage
~/Applications/BladeVault.AppImage
```

Keep the file in that folder: updates replace it in place.

AppImages need FUSE 2, which Ubuntu 22.04 and newer do not install by default. If the AppImage reports `dlopen(): error loading libfuse.so.2`, install it:

```bash
sudo apt install libfuse2      # Ubuntu 22.04
sudo apt install libfuse2t64   # Ubuntu 24.04 and newer
```

Without FUSE you can also unpack and run it with `./BladeVault.AppImage --appimage-extract-and-run`.

If your distribution restricts unprivileged user namespaces (Ubuntu 23.10 and newer by default), the AppImage may report a sandbox helper error. Start it with the bundled Chromium sandbox disabled:

```bash
~/Applications/BladeVault.AppImage --no-sandbox
```

**Update**

The AppImage updates itself. Open **Settings → About**, select **Check for updates**, then **Download update**, and finally **Restart to update**. BladeVault replaces the AppImage file and reopens on the new version.

To update by hand instead, download the latest `BladeVault.AppImage`, overwrite the old file, and run `chmod +x` on it again.

### Debian package

**Install**

Download [BladeVault.deb](https://github.com/dedkola/bladevault/releases/latest/download/BladeVault.deb) and install it with `apt`, which also pulls in any missing dependencies:

```bash
sudo apt install ~/Downloads/BladeVault.deb
```

Open **BladeVault** from your applications menu. The package installs an AppArmor profile that allows the Chromium sandbox, so it does not need `--no-sandbox`.

**Update**

A Debian install cannot replace itself. Open **Settings → About**, select **Check for updates**, then **Download update**: BladeVault downloads the new `BladeVault.deb`, checks its SHA-256, and opens it in your package installer, or shows it in your file manager if no installer is set up. Install it, then reopen BladeVault.

You can also update from a terminal: download the latest `BladeVault.deb`, quit BladeVault, and install it over the old version:

```bash
sudo apt install ~/Downloads/BladeVault.deb
```

To remove the app, run `sudo apt remove bladevault`. Your vault in `~/BladeVault/data` stays in place.

## Where the desktop app keeps your data

The default data folder is `~/BladeVault/data` on macOS and Linux, and `%USERPROFILE%\BladeVault\data` on Windows. The desktop app can also move its data folder from Settings when the location is not managed by `BLADEVAULT_DATA_DIR`. See [Your data](../reference/data.md).

The desktop runtime serves MCP on `http://127.0.0.1:5501/mcp`; if port `5501` is busy, BladeVault uses a free local port and **Copy config** includes the active URL. See [MCP](../reference/mcp.md).

## What's new after an update

The first time you open BladeVault after an update, it shows a short list of new features and fixes in that version. Select **See All Changes** to open the full release notes on GitHub. A fresh install skips the list, and each version shows it only once.

The list comes from the `feat`, `fix`, and `perf` commit titles since the previous release, features first, at most five. It is built into the app when the release is made, so showing it needs no network.

## Error reports

On first launch and after updates, the desktop app asks whether to send crash reports and anonymous usage data. It sends nothing unless you agree, and you can change your answer in **Settings → About → Send error reports**. See [Error reporting](../reference/error-reporting.md) for what is sent.

## Desktop development

If you want to run or package the desktop shell from a checkout, the source guide lists every script:

```bash
npm run desktop:dev          # Electron shell in development
npm run desktop:smoke        # build and smoke-test the desktop runtime
npm run dist:desktop         # package installers without publishing
npm run dist:desktop:linux   # package the AppImage and deb on Linux
```

See [Run from source](from-source.md) for the full command list, including the native `better-sqlite3` rebuild that desktop builds need.
