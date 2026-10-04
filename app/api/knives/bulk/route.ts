import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import {
  type BulkEditFieldKey,
  createBulkKnifeUpdates,
  getCustomBulkEditFieldId,
  isBuiltInBulkEditFieldKey,
} from '@/lib/bulk-edit'
import { getSettings } from '@/lib/settings'
import { getStorage } from '@/lib/storage'

export async function PATCH(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const body = (await request.json()) as Record<string, unknown>
    const ids = Array.isArray(body.ids)
      ? Array.from(
          new Set(
            body.ids.filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
            ),
          ),
        )
      : []
    const field = typeof body.field === 'string' ? body.field : ''
    const value = typeof body.value === 'string' ? body.value.trim() : ''
    let expectedUpdatedAt: Record<string, string> | undefined
    if ('expectedUpdatedAt' in body) {
      const expected = body.expectedUpdatedAt
      if (
        !expected ||
        typeof expected !== 'object' ||
        Array.isArray(expected) ||
        !ids.every(
          (id) =>
            Object.hasOwn(expected, id) &&
            typeof (expected as Record<string, unknown>)[id] === 'string' &&
            (expected as Record<string, string>)[id].length > 0,
        )
      ) {
        return NextResponse.json(
          { error: 'Include the reviewed version of every selected knife' },
          { status: 400 },
        )
      }
      expectedUpdatedAt = expected as Record<string, string>
    }

    if (ids.length === 0) {
      return NextResponse.json(
        { error: 'Select at least one knife' },
        { status: 400 },
      )
    }

    if (!value) {
      return NextResponse.json(
        { error: 'Enter a replacement value' },
        { status: 400 },
      )
    }

    const customFieldId = getCustomBulkEditFieldId(field)
    const customFieldExists = customFieldId
      ? getSettings().customFields.some((item) => item.id === customFieldId)
      : false

    if (!isBuiltInBulkEditFieldKey(field) && !customFieldExists) {
      return NextResponse.json(
        { error: 'Choose a supported field' },
        { status: 400 },
      )
    }

    const storage = getStorage()
    const knives = await storage.bulkUpdateKnives(
      ids,
      createBulkKnifeUpdates(field as BulkEditFieldKey, value),
      expectedUpdatedAt,
    )

    return NextResponse.json({ knives })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: message },
      {
        status: message.startsWith('The collection changed after this review.')
          ? 409
          : 500,
      },
    )
  }
}
