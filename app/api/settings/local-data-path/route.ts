import { withVaultOperation } from '@/lib/vault-operation'
import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import {
  getDockerHostDataMountPath,
  isDesktopRuntime,
  isContainerizedRuntime,
} from '@/lib/local-db'
import { updateLocalDataDirectory } from '@/lib/local-data-location'
import { getSettings } from '@/lib/settings'

type UpdateLocalDataPathRequest = {
  moveExistingData?: boolean
  path?: string
}

async function saveLocalDataPath(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  if (!isDesktopRuntime()) {
    return NextResponse.json(
      {
        error:
          'Changing the local data folder is only available in the desktop app.',
      },
      { status: 403 },
    )
  }

  try {
    const body = (await request.json()) as UpdateLocalDataPathRequest
    const result = await updateLocalDataDirectory({
      moveExistingData: body.moveExistingData !== false,
      nextDataDir: body.path ?? '',
    })

    return NextResponse.json(
      {
        ...result,
        dockerHostDataMountPath: getDockerHostDataMountPath(),
        isContainerized: isContainerizedRuntime(),
        settings: getSettings(),
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  return withVaultOperation(() => saveLocalDataPath(request))
}
