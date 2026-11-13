# Back up and restore your vault

[![Watch the backup and restore walkthrough on YouTube](https://img.youtube.com/vi/kApN2egnnRo/hqdefault.jpg)](https://youtu.be/kApN2egnnRo)

A full-vault backup keeps your knife records, settings, Smart Collections, saved comparisons, maintenance and change history, and local images together. Use a local ZIP without an account, or connect Google Drive for an optional cloud copy.

Restoring a backup replaces the current vault. It does not merge two collections. Download a ZIP of the current vault first if you want to keep a separate copy before restoring another one.

## Download a local ZIP

1. Open **Settings → Backup & Restore**.

   ![The Backup & Restore settings tab](../images/back-up-and-restore-settings.png)

2. Under **Local backup** (below the Google Drive section), click **Download ZIP**.

   ![The Local backup section with the Download ZIP button](../images/back-up-and-restore-local-backup.png)

3. Save the archive when prompted, or find it in your browser's download folder. The suggested name includes the backup date, such as `bladevault-backup-2026-10-18.zip`.
4. Wait for the success message and check that the ZIP was saved where you expect.

Keep the archive intact for restoration. A printed or PDF collection report is useful for reading, but it is not a restorable vault backup.

## Restore a local ZIP

1. Open **Settings → Backup & Restore** on the device or server whose vault you want to replace.
2. Under **Restore from local ZIP**, click **Choose ZIP** and select a BladeVault backup archive.

   ![The Restore from local ZIP section with the Choose ZIP button](../images/back-up-and-restore-restore-panel.png)

3. Wait while BladeVault validates it. If validation fails, read the message and select a valid, compatible backup.
4. Review the confirmation: it shows the backup's creation time and the number of knives and images. Cancel if this is not the backup you intended to restore.
5. Confirm the replacement and wait for the success message. BladeVault keeps a safety copy of the current data before installing the restored vault.
6. Open **Collection**, check the expected records, and open a knife to confirm that its images and details are available.

BladeVault validates the archive before asking you to confirm, then checks and extracts it again during restoration. An ordinary ZIP of loose files is not a substitute for a BladeVault backup archive. A backup created with an incompatible newer database schema must be restored with a compatible BladeVault version.

If the restored vault has [App lock](../reference/data.md#optional-app-lock) enabled, unlock it with the password stored in that backup.

## Connect Google Drive

1. Open **Settings → Backup & Restore**.
2. Under **Google Drive**, click **Connect Google Drive**.
3. Choose your Google account in the popup and allow access. If the browser blocks the popup, allow it and try again.
4. Check that **Google Drive connected** appears.

BladeVault can only see the files it creates in your Drive. Your working vault remains stored locally.

## Back up to Google Drive

1. In **Settings → Backup & Restore → Google Drive**, find **Back up to Google Drive** and click **Backup**.
2. Keep the desktop app or self-hosted server running while the backup is prepared and uploaded. You can switch pages or reload the browser during the upload.
3. Return to the panel to check the status and the date of the backup in Drive. Successful backups finish quietly, without a popup.

Each backup replaces the single `bladevault-data.tar.gz` file in the `BladeVault` folder of your Drive.

To back up after edits, turn on **Automatic backup to Google Drive** in the same panel. During an open app session, BladeVault waits at least 30 seconds after edits settle before starting a backup. Changes made during a backup can be included in a later one.

Saved comparisons are included in full-vault backups, but changing a comparison list alone does not trigger an automatic backup. Use **Backup** when you want to include those changes immediately.

## Restore from Google Drive

1. Open **Settings → Backup & Restore** and connect the Google account that holds the backup.
2. Under **Restore from Google Drive**, click **Restore**.
3. Confirm that you want to replace the local vault with the backup from Google Drive.
4. Keep the desktop app or server running and check the restore status. You can browse the current collection during the download and validation, while editing and automatic backups are paused.
5. Wait for restoration to finish. BladeVault keeps a safety copy, installs the restored vault, and refreshes open views and images.
6. Check the expected collection and open a saved knife. If App lock is enabled in the backup, unlock with its password.

The restore continues if you switch pages or reload the browser. Access pauses briefly while BladeVault applies the restored data. See [Cloud backup](../reference/cloud-backup.md) for background operation and recovery details.

## Move a vault to another device

Download a local ZIP on the original device, transfer it to the destination, and restore it there. The destination vault is replaced by the backup. You can also connect the same Google account on the destination and restore from Google Drive.

To change the data folder on the same desktop installation instead, see [Change the desktop data folder](../reference/data.md#change-the-desktop-data-folder). For filesystem copies and container storage, see [Your data](../reference/data.md).

## Related

- [Your data](../reference/data.md) — default folders, local storage controls, App lock, and filesystem backups.
- [Cloud backup](../reference/cloud-backup.md) — Google Drive, background jobs, and safety copies.
- [Docker and Podman](../installation/docker.md) — keep container data in a persistent host folder.
