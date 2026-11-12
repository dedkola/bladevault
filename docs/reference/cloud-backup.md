# Cloud backup

Cloud backup is optional and keeps local storage as the source of truth. BladeVault uses `https://auth.bladevault.pro` and `https://backup.bladevault.pro` by default. Sign in from **Settings → Cloud backup** to upload or restore a complete archive, including images.

## How backups run

Manual and automatic backups run quietly on the local server. You can switch pages or reload the browser while an upload continues; check its status and last successful backup in **Cloud backup** settings. Keep the desktop app or self-hosted server running until it finishes.

Automatic backups wait at least 30 seconds after edits settle and use a browser idle slot to start. During an open app session, changes made during a backup are grouped into a later backup. Backup uploads and restore downloads have no application-imposed speed cap. Completion does not show a popup.

## How restores run

Cloud restore also runs on the local server and continues when you switch pages or reload. You can browse the existing collection while BladeVault downloads and validates the backup; editing and automatic backups pause until the restore finishes.

BladeVault waits for active saves, keeps a safety copy, briefly pauses access to install the restored vault, and refreshes open views and images afterward. Local MCP processes participate in the same access protection. Restoring a password-protected vault requires unlocking again with the backed-up password.

Safety copies and interrupted-restore recovery files are kept in private `._bladevault-*` folders inside the data directory and are excluded from app backup archives.

## Google Drive

You can also keep a backup in your own Google Drive. In **Settings → Cloud backup → Google Drive**, select **Connect Google Drive**, choose your Google account, and allow access. BladeVault can only see the files it creates in your Drive.

- **Back up** saves one file, `bladevault-data.tar.gz`, in a `BladeVault` folder in your Drive. Each backup replaces that file.
- **Restore** downloads that file and replaces the local data on this device, with the same safety steps as a cloud restore.
- To restore on another computer or server, connect the same Google account there.
- Google Drive backups run only when you start them. Automatic backup applies to the BladeVault cloud account.
- **Disconnect** removes Google Drive access from this device. The backup file stays in your Drive.

The backup file travels directly between your BladeVault server and Google Drive. The sign-in service at `auth.bladevault.pro` only completes the Google sign-in. The Google Drive sign-in is stored in the private `._bladevault-control` folder in the data directory and is never included in a backup.

Google Drive backup is not available in the static web version.

## Endpoint overrides

Deployments can override the service endpoints with `NEXT_PUBLIC_BLADEVAULT_AUTH_URL` and `NEXT_PUBLIC_BLADEVAULT_BACKUP_URL`. Leaving them unset uses the built-in defaults. You can use the local vault and ZIP backups without signing in.

## Related

- [Back up and restore your vault](../guides/back-up-and-restore-your-vault.md) — sign in, create a backup, and restore it.
- [Your data](data.md) — data locations, local ZIP backups, and App lock.
