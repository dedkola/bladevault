import { NextResponse } from 'next/server'
import {
  getConfiguredLocalDataDirPath,
  getDefaultLocalDataDirPath,
  getDockerHostDataMountPath,
  getLocalDataDirPath,
  isLocalDataDirManagedByEnv,
  isContainerizedRuntime,
} from '@/lib/local-db'
import { AppSettings, getSettings, saveSettings } from '@/lib/settings'

export async function GET() {
  try {
    const settings = getSettings()
    const configuredLocalDataPath = getConfiguredLocalDataDirPath()
    const defaultLocalDataPath = getDefaultLocalDataDirPath()
    const localDataPath = getLocalDataDirPath()
    const dockerHostDataMountPath = getDockerHostDataMountPath()
    const isContainerized = isContainerizedRuntime()
    return NextResponse.json(
      {
        configuredLocalDataPath,
        dataDirManagedByEnv: isLocalDataDirManagedByEnv(),
        defaultLocalDataPath,
        settings,
        localDataPath,
        dockerHostDataMountPath,
        isContainerized,
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
  try {
    const body = (await request.json()) as Partial<AppSettings>
    const settings = saveSettings(body)
    const configuredLocalDataPath = getConfiguredLocalDataDirPath()
    const defaultLocalDataPath = getDefaultLocalDataDirPath()
    const localDataPath = getLocalDataDirPath()
    const dockerHostDataMountPath = getDockerHostDataMountPath()
    const isContainerized = isContainerizedRuntime()
    return NextResponse.json(
      {
        configuredLocalDataPath,
        dataDirManagedByEnv: isLocalDataDirManagedByEnv(),
        defaultLocalDataPath,
        settings,
        localDataPath,
        dockerHostDataMountPath,
        isContainerized,
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
