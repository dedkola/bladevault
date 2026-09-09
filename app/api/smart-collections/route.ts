import { NextResponse } from 'next/server'
import { z } from 'zod'
import { collectionQuery, rangeError } from '@/lib/smart-collections'
import {
  deleteSmartCollection,
  getSmartCollections,
  saveSmartCollection,
} from '@/lib/smart-collections-storage'

const inputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  query: z.string().max(16000),
})
export async function GET() {
  try {
    return NextResponse.json({ collections: getSmartCollections() })
  } catch {
    return NextResponse.json(
      { error: 'Could not load smart collections.' },
      { status: 500 },
    )
  }
}
export async function POST(request: Request) {
  const parsed = inputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Enter a name (1–80 characters) and valid filters.' },
      { status: 400 },
    )
  const params = new URLSearchParams(parsed.data.query)
  const query = collectionQuery(params)
  const error = rangeError(params)
  if (
    !query ||
    error ||
    (params.has('missingSpecs') && params.get('missingSpecs') !== '1')
  )
    return NextResponse.json(
      { error: error ?? 'Choose at least one valid filter or search.' },
      { status: 400 },
    )
  try {
    const collection = saveSmartCollection({ ...parsed.data, query })
    if (!collection)
      return NextResponse.json(
        { error: 'Smart collection no longer exists.' },
        { status: 404 },
      )
    return NextResponse.json({ collection })
  } catch {
    return NextResponse.json(
      { error: 'Could not save smart collection.' },
      { status: 500 },
    )
  }
}
export async function DELETE(request: Request) {
  const parsed = z
    .object({ id: z.string().uuid() })
    .safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return NextResponse.json(
      { error: 'A valid collection ID is required.' },
      { status: 400 },
    )
  try {
    if (!deleteSmartCollection(parsed.data.id))
      return NextResponse.json(
        { error: 'Smart collection no longer exists.' },
        { status: 404 },
      )
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json(
      { error: 'Could not delete smart collection.' },
      { status: 500 },
    )
  }
}
