import { NextResponse } from 'next/server'
import { captureKnifeScreenshot } from '@/lib/webpage-screenshot-service'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json()
    const knife = await captureKnifeScreenshot(id, body.replace === true)
    return NextResponse.json({ knife })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Capture failed' },
      { status: 400 },
    )
  }
}
