import { NextResponse } from 'next/server'
import {
  MaintenanceEventUpdate,
  MaintenanceType,
  isMaintenanceType,
} from '@/lib/data'
import {
  deleteMaintenanceEvent,
  updateMaintenanceEvent,
} from '@/lib/services/maintenance-service'

function parseEventId(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Invalid maintenance event id')
  }
  return parsed
}

function parsePartialMaintenanceInput(body: unknown): MaintenanceEventUpdate {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an object')
  }

  const { type, occurredAt, notes, sharpeningDetails } = body as Record<
    string,
    unknown
  >
  const input: MaintenanceEventUpdate = {}

  if (type !== undefined) {
    if (typeof type !== 'string' || !isMaintenanceType(type)) {
      throw new Error('Invalid maintenance type')
    }
    input.type = type as MaintenanceType
  }

  if (occurredAt !== undefined) {
    if (typeof occurredAt !== 'string' || !occurredAt.trim()) {
      throw new Error('occurredAt must be a non-empty string')
    }
    input.occurredAt = occurredAt.trim()
  }

  if (notes !== undefined) {
    if (typeof notes !== 'string') {
      throw new Error('notes must be a string')
    }
    input.notes = notes.trim()
  }

  if (sharpeningDetails !== undefined) {
    if (sharpeningDetails === null) {
      input.sharpeningDetails = null
    } else if (
      typeof sharpeningDetails !== 'object' ||
      Array.isArray(sharpeningDetails)
    ) {
      throw new Error('sharpeningDetails must be an object')
    } else {
      const details = sharpeningDetails as Record<string, unknown>
      input.sharpeningDetails = {
        grit: parseOptionalString(details.grit),
        angle: parseOptionalString(details.angle),
        system: parseOptionalString(details.system),
        passes: parseOptionalNumber(details.passes),
        ceramic: parseOptionalString(details.ceramic),
        strop: parseOptionalString(details.strop),
        compound: parseOptionalString(details.compound),
        notes: parseOptionalString(details.notes),
      }
    }
  }

  return input
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Expected string value')
  const trimmed = value.trim()
  return trimmed || undefined
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error('Expected numeric value')
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  try {
    const { id, eventId: eventIdParam } = await params
    const eventId = parseEventId(eventIdParam)
    const body = await request.json()
    const input = parsePartialMaintenanceInput(body)

    const event = await updateMaintenanceEvent({
      knifeId: id,
      eventId,
      ...input,
    })
    return NextResponse.json({ event })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message.includes('not found') ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  try {
    const { id, eventId: eventIdParam } = await params
    const eventId = parseEventId(eventIdParam)

    await deleteMaintenanceEvent(id, eventId)
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message.includes('not found') ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
