// The BladeVault sign-in service completes Google Drive sign-in for local
// servers. It never receives backup data.
export const FALLBACK_CLOUD_AUTH_URL = 'https://auth.bladevault.pro'

export const DEFAULT_CLOUD_AUTH_URL =
  process.env.NEXT_PUBLIC_BLADEVAULT_AUTH_URL?.trim() || FALLBACK_CLOUD_AUTH_URL

// Earlier versions kept a BladeVault cloud account session here.
const LEGACY_CLOUD_AUTH_STATE_KEY = 'bladevault.cloudAuthState'

export function normalizeCloudUrl(url: string): string {
  let normalized = url.trim()
  if (normalized && !/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`
  }
  return normalized.replace(/\/$/, '')
}

// Removes the session left by the retired BladeVault cloud account backup.
export function clearLegacyCloudAuthState() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(LEGACY_CLOUD_AUTH_STATE_KEY)
  } catch {
    // Storage can be unavailable; the stale entry is unused either way.
  }
}

export async function parseApiError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      error?: string
      message?: string
      details?: { message?: string }
    }
    return (
      data.error ||
      data.message ||
      data.details?.message ||
      `Request failed (${response.status})`
    )
  } catch {
    return `Request failed (${response.status})`
  }
}
