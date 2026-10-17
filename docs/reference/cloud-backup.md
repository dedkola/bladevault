# Cloud backup

Cloud backup is opt-in and leaves local storage as the source of truth. BladeVault uses `https://auth.bladevault.pro` and `https://backup.bladevault.pro` by default. Sign in from **Settings → Cloud Backup** to upload or restore a complete archive, including images.

## How backups run

Manual and automatic backups run quietly on the local server. You can switch pages or reload the browser while an upload continues; check its status and last successful backup in Cloud Backup settings. Keep the desktop app or self-hosted server running until it finishes.

Automatic backups wait at least 30 seconds after edits settle and use a browser idle slot to start. During an open app session, changes made during a backup are grouped into a later backup. Backup uploads and restore downloads have no application-imposed speed cap. Completion does not show a popup.

## How restores run

Cloud restore also runs on the local server and continues when you switch pages or reload. You can browse the existing collection while the backup downloads and is validated; editing and automatic backups pause until it finishes.

BladeVault waits for active saves, keeps a safety copy, briefly pauses access to install the restored vault, and refreshes open views and images afterward. Local MCP processes participate in the same access protection. Restoring a password-protected vault requires unlocking again with the backed-up password.

Safety copies and interrupted-restore recovery files are kept in private `._bladevault-*` folders inside the data directory and are excluded from app backup archives.

## Endpoint overrides

Deployments can override the service endpoints with `NEXT_PUBLIC_BLADEVAULT_AUTH_URL` and `NEXT_PUBLIC_BLADEVAULT_BACKUP_URL`. Leaving them unset uses the built-in defaults. You can use the local vault and ZIP backups without signing in.
