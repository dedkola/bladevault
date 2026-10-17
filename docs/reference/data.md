# Your data

BladeVault is local-first: it works without an account or API key.

| Runtime                         | Default data location                                                       |
| ------------------------------- | --------------------------------------------------------------------------- |
| Source or installed desktop app | `~/BladeVault/data` (`%USERPROFILE%\BladeVault\data` on Windows)            |
| Docker or Podman                | `/app/data` inside the container; mount it to a host folder for persistence |
| Desktop development             | `~/.bladevault-desktop-dev/data`                                            |

The data directory contains `bladevault.sqlite` and local images. **Settings → Local storage** shows the active folder.

Set `BLADEVAULT_DATA_DIR` to choose a different directory for a source or container runtime. Without an explicit folder setting, BladeVault checks the default folder and legacy locations, including repo-local `data/bladevault.sqlite` and older macOS app folders, and uses the existing database with the most knives.

The desktop app can also move its local data folder from Settings when the location is not managed by `BLADEVAULT_DATA_DIR`.

## Optional App lock

Open **Settings → App lock** to set a password for the local vault. App lock is off by default and works offline in the desktop app and Docker. Once enabled, new browser sessions and desktop launches show a password screen. Reloading stays unlocked for the current session; restarting the server requires the password again. Use **Lock now**, **Change password**, or **Disable lock** in the same panel.

This is a simple access lock. The password is stored as plain text in SQLite, and the collection is not encrypted. Full-vault backups include the lock setting; restoring one uses its password and clears existing unlock sessions. HTTP MCP clients need the existing MCP bearer token while App lock is enabled, including localhost clients. Local stdio MCP continues to use direct database access.

If you forget the password, stop BladeVault or its container and open `bladevault.sqlite` in the active data folder using a SQLite editor. Run this statement, then restart and set a new password:

```sql
DELETE FROM settings WHERE key = 'app_lock_password';
```

You can also change that setting's value directly to choose a replacement password.

## Local backup and restore

Open **Settings → Backup & Restore → Download ZIP** to save a portable full-vault backup without a cloud account. The archive includes the database, collection settings, Smart Collections, saved comparisons, history, and local images.

Use **Restore from local ZIP** in the same panel to validate an archive and review its contents before replacing the current vault. BladeVault creates a safety copy of the current data before restoring. The panel also offers **Print Report** to open the Overview for printing or saving as a PDF.

Saved comparisons are included in full-vault backups, but changing a comparison list does not trigger an automatic cloud backup. When upgrading from before v1.2.0, the old comparison selection becomes **My comparison**.

For a manual filesystem backup, stop BladeVault and copy the whole data folder so the database and images stay together.

## Related

- [Cloud backup](cloud-backup.md) — the optional off-machine copy.
- [Docker and Podman](../installation/docker.md) — mounting `/app/data` to a host folder.
- [Kubernetes with Helm](../installation/helm.md) — the PVC that holds `/app/data`.
