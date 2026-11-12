# Cloud backup

Cloud backup is optional and keeps local storage as the source of truth. BladeVault backs up to your own Google Drive: connect it from **Settings → Cloud backup** to upload or restore a complete archive, including images.

## Connect Google Drive

In **Settings → Cloud backup → Google Drive**, select **Connect Google Drive**, choose your Google account, and allow access. BladeVault can only see the files it creates in your Drive.

- **Back up** saves one file, `bladevault-data.tar.gz`, in a `BladeVault` folder in your Drive. Each backup replaces that file.
- **Automatic backup to Google Drive** backs up after edits settle.
- **Restore** downloads that file and replaces the local data on this device.
- To restore on another computer or server, connect the same Google account there.
- **Disconnect** removes Google Drive access from this device. The backup file stays in your Drive.

The backup file travels directly between your BladeVault server and Google Drive. The sign-in service at `auth.bladevault.pro` only completes the Google sign-in and never receives backup data. The Google Drive sign-in is stored in the private `._bladevault-control` folder in the data directory and is never included in a backup.

Google Drive backup is not available in the static web version.

## How backups run

Manual and automatic backups run quietly on the local server. You can switch pages or reload the browser while an upload continues; check its status and the date of the backup in Drive in **Cloud backup** settings. Keep the desktop app or self-hosted server running until it finishes.

Automatic backups wait at least 30 seconds after edits settle and use a browser idle slot to start. During an open app session, changes made during a backup are grouped into a later backup. Each backup uploads the whole archive. Backup uploads and restore downloads have no application-imposed speed cap. Completion does not show a popup.

If Google stops accepting the sign-in, for example after you remove BladeVault's access from your Google Account, BladeVault disconnects Google Drive on this device and automatic backup stops until you connect again.

## How restores run

Restore also runs on the local server and continues when you switch pages or reload. You can browse the existing collection while BladeVault downloads and validates the backup; editing and automatic backups pause until the restore finishes.

BladeVault waits for active saves, keeps a safety copy, briefly pauses access to install the restored vault, and refreshes open views and images afterward. Local MCP processes participate in the same access protection. Restoring a password-protected vault requires unlocking again with the backed-up password.

Safety copies and interrupted-restore recovery files are kept in private `._bladevault-*` folders inside the data directory and are excluded from app backup archives.

## The BladeVault cloud account

Earlier versions could also back up to a BladeVault cloud account. That service has been retired, and its backups can no longer be restored. Use Google Drive or a local ZIP instead.

## Sign-in service override

Deployments can point Google sign-in at their own service with `NEXT_PUBLIC_BLADEVAULT_AUTH_URL`. Leaving it unset uses `https://auth.bladevault.pro`. You can use the local vault and ZIP backups without connecting Google Drive.

## Related

- [Back up and restore your vault](../guides/back-up-and-restore-your-vault.md) — connect Google Drive, create a backup, and restore it.
- [Your data](data.md) — data locations, local ZIP backups, and App lock.
