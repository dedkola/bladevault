import { NextResponse } from 'next/server'
import { KnifeUpdates } from '@/lib/data'
import { getStorage } from '@/lib/storage'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const knife = await getStorage().getKnifeById(id)

    if (!knife) {
      return NextResponse.json({ error: 'Knife not found' }, { status: 404 })
    }

    return NextResponse.json({ knife })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json()

    const storage = getStorage()

    const existing = await storage.getKnifeById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Knife not found' }, { status: 404 })
    }

    const updates: KnifeUpdates = {}

    const stringFields = [
      'name',
      'brand',
      'bladeStyle',
      'handleMaterial',
      'description',
      'sourceUrl',
    ] as const
    for (const field of stringFields) {
      if (field in body && typeof body[field] === 'string') {
        updates[field] = body[field]
      }
    }

    if ('pinned' in body && typeof body.pinned === 'boolean') {
      updates.pinned = body.pinned
    }

    if (body.specs && typeof body.specs === 'object') {
      updates.specs = {}
      const specFields = [
        'weight',
        'overallLength',
        'bladeLength',
        'bladeThickness',
        'bladeCoating',
        'bladeMaterial',
        'lockingMechanism',
        'designer',
        'modelNumber',
        'handleLength',
        'hardness',
        'price',
        'country',
      ] as const
      for (const field of specFields) {
        if (field in body.specs && typeof body.specs[field] === 'string') {
          updates.specs[field] = body.specs[field]
        }
      }
    }

    if (body.customFields && typeof body.customFields === 'object') {
      updates.customFields = {}
      for (const [key, value] of Object.entries(body.customFields)) {
        if (typeof value === 'string') {
          updates.customFields[key] = value
        }
      }
    }

    if (
      body.images &&
      Array.isArray(body.images) &&
      body.images.every((item: unknown) => typeof item === 'string')
    ) {
      updates.images = body.images as string[]
    }

    const knife = await storage.updateKnife(id, updates)
    return NextResponse.json({ knife })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const storage = getStorage()

    const existing = await storage.getKnifeById(id)
    if (!existing) {
      return NextResponse.json({ error: 'Knife not found' }, { status: 404 })
    }

    await storage.deleteKnife(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
