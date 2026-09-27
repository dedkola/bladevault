import { NextResponse } from 'next/server'
import {
  getScreenshotBackfill,
  processScreenshotBackfill,
} from '@/lib/webpage-screenshot-service'
import { getLocalDb } from '@/lib/local-db'

export const runtime = 'nodejs'

export async function GET() {
  try {
    return NextResponse.json({ items: getScreenshotBackfill() })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to load screenshot backlog',
      },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    if (typeof body.id !== 'string')
      return NextResponse.json(
        { error: 'Item ID is required' },
        { status: 400 },
      )
    if (body.action === 'skip') {
      getLocalDb()
        .prepare(
          "UPDATE screenshot_backfill SET status = 'skipped', error = NULL WHERE knife_id = ? AND status IN ('pending', 'failed')",
        )
        .run(body.id)
    } else {
      await processScreenshotBackfill(body.id)
    }
    return NextResponse.json({ items: getScreenshotBackfill() })
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Capture failed',
        items: getScreenshotBackfill(),
      },
      { status: 400 },
    )
  }
}
