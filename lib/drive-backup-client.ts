'use client'

import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import {
  DRIVE_AUTH_CODE_MESSAGE,
  DRIVE_AUTH_ERROR_MESSAGE,
  DRIVE_BACKUP_UNAVAILABLE,
  type DriveAuthCodeMessage,
  type DriveAuthErrorMessage,
  type DriveBackupStatus,
} from '@/lib/drive-backup-shared'

async function readStatus(
  response: Response,
  fallback: string,
): Promise<DriveBackupStatus> {
  const data = await readJsonResponse<
    Partial<DriveBackupStatus> & { error?: string }
  >(response)
  if (!response.ok || typeof data.connected !== 'boolean') {
    throw new Error(getApiErrorMessage(data, fallback))
  }
  return {
    available: data.available !== false,
    connected: data.connected,
    file: data.file ?? null,
    message: data.message ?? null,
  }
}

export async function getDriveBackupStatus(): Promise<DriveBackupStatus> {
  const response = await fetch('/api/drive-backup/status', {
    cache: 'no-store',
  })
  // Targets without a local server have no Google Drive backup.
  if (response.status === 404) return DRIVE_BACKUP_UNAVAILABLE
  return readStatus(response, 'Could not read Google Drive status.')
}

export async function disconnectDriveBackup(): Promise<DriveBackupStatus> {
  const response = await fetch('/api/drive-backup/connect', {
    method: 'DELETE',
  })
  return readStatus(response, 'Could not disconnect Google Drive.')
}

function waitForDriveCode(
  popup: Window,
  authOrigin: string,
  state: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      window.clearInterval(closedPoll)
      window.clearTimeout(timeout)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== authOrigin) return
      const data = event.data as DriveAuthCodeMessage | DriveAuthErrorMessage
      if (!data || typeof data !== 'object' || !('type' in data)) return
      if (data.type === DRIVE_AUTH_ERROR_MESSAGE) {
        cleanup()
        reject(new Error(data.error?.message || 'Google sign-in failed.'))
        return
      }
      if (data.type !== DRIVE_AUTH_CODE_MESSAGE) return
      if (data.state !== state || typeof data.code !== 'string') return
      cleanup()
      resolve(data.code)
    }
    const closedPoll = window.setInterval(() => {
      if (popup.closed) {
        cleanup()
        reject(new Error('Google sign-in was closed before completion.'))
      }
    }, 500)
    const timeout = window.setTimeout(
      () => {
        cleanup()
        try {
          popup.close()
        } catch {
          // ignore
        }
        reject(new Error('Google sign-in timed out. Please try again.'))
      },
      5 * 60 * 1000,
    )
    window.addEventListener('message', onMessage)
  })
}

export async function connectDriveBackup(): Promise<DriveBackupStatus> {
  let popup: Window | null = null
  try {
    const beginResponse = await fetch('/api/drive-backup/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'begin',
        clientOrigin: window.location.origin,
      }),
    })
    const begin = await readJsonResponse<{
      startUrl?: string
      state?: string
      authOrigin?: string
      error?: string
    }>(beginResponse)
    if (
      !beginResponse.ok ||
      !begin.startUrl ||
      !begin.state ||
      !begin.authOrigin
    ) {
      throw new Error(
        getApiErrorMessage(begin, 'Could not start Google sign-in.'),
      )
    }

    popup = window.open(
      begin.startUrl,
      'bladevault-google-drive',
      'width=500,height=640,menubar=no,toolbar=no',
    )
    if (!popup) {
      throw new Error('Popup was blocked. Allow popups and try again.')
    }
    const code = await waitForDriveCode(popup, begin.authOrigin, begin.state)

    const completeResponse = await fetch('/api/drive-backup/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete', state: begin.state, code }),
    })
    return await readStatus(completeResponse, 'Google Drive sign-in failed.')
  } catch (error) {
    try {
      popup?.close()
    } catch {
      // ignore
    }
    throw error
  }
}
