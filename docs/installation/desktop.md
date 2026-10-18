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

## Where the desktop app keeps your data

The default data folder is `~/BladeVault/data` on macOS and `%USERPROFILE%\BladeVault\data` on Windows. The desktop app can also move its data folder from Settings when the location is not managed by `BLADEVAULT_DATA_DIR`. See [Your data](../reference/data.md).

The desktop runtime serves MCP on `http://127.0.0.1:5501/mcp`; if port `5501` is busy, BladeVault uses a free local port and **Copy config** includes the active URL. See [MCP](../reference/mcp.md).

## Desktop development

If you want to run or package the desktop shell from a checkout, the source guide lists every script:

```bash
npm run desktop:dev        # Electron shell in development
npm run desktop:smoke      # build and smoke-test the desktop runtime
npm run dist:desktop       # package installers without publishing
```

See [Run from source](from-source.md) for the full command list, including the native `better-sqlite3` rebuild that desktop builds need.
