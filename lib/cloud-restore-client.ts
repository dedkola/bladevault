'use client'

import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import { getCloudAuthState } from '@/lib/cloud-backup'
import type { CloudRestoreJobState } from '@/lib/cloud-restore-shared'
import { VAULT_GENERATION_HEADER } from '@/lib/vault-access-shared'
import {
  getVaultClientState,
  type VaultClientState,
} from '@/lib/vault-client-state'

async function fetchRestoreApi(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function startCloudRestore(): Promise<{
  job: CloudRestoreJobState
  started: boolean
}> {
  const sessionToken = getCloudAuthState()?.sessionToken
  if (!sessionToken) throw new Error('Sign in before restoring a cloud backup.')
  const generation = getVaultClientState().generation

  const response = await fetchRestoreApi('/api/cloud-backup/restore-job', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(generation ? { [VAULT_GENERATION_HEADER]: generation } : {}),
    },
    body: JSON.stringify({ sessionToken }),
  })
  const data = await readJsonResponse<{
    job?: CloudRestoreJobState
    started?: boolean
    error?: string
  }>(response)
  if (!response.ok || !data.job) {
    throw new Error(getApiErrorMessage(data, 'Could not start cloud restore.'))
  }
  return { job: data.job, started: data.started === true }
}

export async function getCloudRestoreJob(): Promise<CloudRestoreJobState> {
  const response = await fetchRestoreApi('/api/cloud-backup/restore-job', {
    cache: 'no-store',
  })
  const data = await readJsonResponse<{
    job?: CloudRestoreJobState
    error?: string
  }>(response)
  if (!response.ok || !data.job) {
    throw new Error(getApiErrorMessage(data, 'Could not read restore status.'))
  }
  return data.job
}

export async function getVaultStatus(): Promise<VaultClientState> {
  const response = await fetchRestoreApi('/api/vault/status', {
    cache: 'no-store',
  })
  const data = await readJsonResponse<
    Partial<VaultClientState> & {
      error?: string
      code?: string
      vault?: VaultClientState
    }
  >(response)
  const state = data.code === 'VAULT_RESTORE_BUSY' ? data.vault : data
  if (
    (response.ok || data.code === 'VAULT_RESTORE_BUSY') &&
    state &&
    typeof state.generation === 'string' &&
    ['idle', 'preparing', 'switching'].includes(state.phase ?? '') &&
    typeof state.readOnly === 'boolean'
  ) {
    return {
      ...state,
      appLockEnabled:
        state.appLockEnabled ?? getVaultClientState().appLockEnabled,
    } as VaultClientState
  }
  throw new Error(getApiErrorMessage(data, 'Could not read vault status.'))
}

const RESTORE_READ_ONLY_MESSAGE =
  'Your vault is temporarily read-only while the cloud backup is restored. You can continue browsing.'
const RESTORED_VAULT_MESSAGE =
  'Your vault was restored. Refreshing the restored collection…'

function blockedResponse(message: string) {
  return Response.json({ error: message }, { status: 409 })
}

export function createVaultFetchGuard(
  originalFetch: typeof fetch,
  options: {
    origin: string
    getState?: () => VaultClientState
    isActive?: () => boolean
    onGenerationChange: (generation: string) => void
  },
): typeof fetch {
  const getState = options.getState ?? getVaultClientState
  return async (input, init) => {
    if (options.isActive && !options.isActive())
      return originalFetch(input, init)
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url ?? String(input), options.origin)
    const localApi =
      url.origin === options.origin && url.pathname.startsWith('/api/')
    if (!localApi) return originalFetch(input, init)

    const controlRequest =
      url.pathname === '/api/vault/status' ||
      url.pathname === '/api/cloud-backup/restore-job' ||
      url.pathname === '/api/app-lock'
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const mutation =
      method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
    const before = getState()
    if (before.readOnly && mutation && !controlRequest) {
      return blockedResponse(RESTORE_READ_ONLY_MESSAGE)
    }
    if (controlRequest) return originalFetch(input, init)

    let requestInit = init
    if (mutation && before.generation) {
      const headers = new Headers(init?.headers ?? request?.headers)
      headers.set(VAULT_GENERATION_HEADER, before.generation)
      requestInit = { ...init, headers }
    }
    const response = await originalFetch(input, requestInit)
    if (options.isActive && !options.isActive()) return response

    const responseGeneration = response.headers.get(VAULT_GENERATION_HEADER)
    const current = getState().generation
    if (before.generation && current && before.generation !== current) {
      return blockedResponse(RESTORED_VAULT_MESSAGE)
    }
    if (responseGeneration && current && responseGeneration !== current) {
      options.onGenerationChange(responseGeneration)
      return blockedResponse(RESTORED_VAULT_MESSAGE)
    }
    return response
  }
}
