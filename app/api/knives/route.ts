import { NextResponse } from 'next/server'
import { getStorage } from '@/lib/storage'

export async function GET() {
  try {
    const storage = getStorage()
    const knives = await storage.getAllKnives()
    return NextResponse.json({ knives })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()

    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const customFields: Record<string, string> = {}
    if (body.customFields && typeof body.customFields === 'object') {
      for (const [key, value] of Object.entries(body.customFields)) {
        if (typeof value === 'string') {
          customFields[key] = value
        }
      }
    }

    const storage = getStorage()
    const knife = await storage.createKnife({
      name: body.name,
      brand: body.brand ?? '',
      bladeStyle: body.bladeStyle ?? '',
      handleMaterial: body.handleMaterial ?? '',
      description: body.description ?? '',
      specs: {
        weight: body.specs?.weight ?? '',
        overallLength: body.specs?.overallLength ?? '',
        bladeLength: body.specs?.bladeLength ?? '',
        bladeThickness: body.specs?.bladeThickness ?? '',
        bladeCoating: body.specs?.bladeCoating ?? '',
        bladeMaterial: body.specs?.bladeMaterial ?? '',
        lockingMechanism: body.specs?.lockingMechanism ?? '',
        designer: body.specs?.designer ?? '',
        modelNumber: body.specs?.modelNumber ?? '',
        handleLength: body.specs?.handleLength ?? '',
        hardness: body.specs?.hardness ?? '',
        price: body.specs?.price ?? '',
        country: body.specs?.country ?? '',
      },
      customFields,
      imageUrls: Array.isArray(body.imageUrls) ? body.imageUrls : [],
      sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : '',
      pinned: typeof body.pinned === 'boolean' ? body.pinned : false,
    })

    return NextResponse.json({ knife })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
