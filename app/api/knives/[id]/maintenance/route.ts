import { NextResponse } from 'next/server'
import {
  isMaintenanceType,
  MaintenanceEventInput,
  MaintenanceType,
} from '@/lib/data'
import {
  addMaintenanceEvent,
  getKnifeMaintenance,
} from '@/lib/services/maintenance-service'

function parseMaintenanceInput(body: unknown): MaintenanceEventInput {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an object')
  }

  const { type, occurredAt, notes, sharpeningDetails } = body as Record<
    string,
    unknown
  >

  if (typeof type !== 'string' || !isMaintenanceType(type)) {
    throw new Error(`Invalid or missing maintenance type`)
  }

  const input: MaintenanceEventInput = {
    type: type as MaintenanceType,
    occurredAt:
      typeof occurredAt === 'string' && occurredAt.trim()
        ? occurredAt.trim()
        : new Date().toISOString(),
  }

  if (notes !== undefined) {
    if (typeof notes !== 'string') {
      throw new Error('notes must be a string')
    }
    input.notes = notes.trim()
  }

  if (sharpeningDetails !== undefined) {
    if (sharpeningDetails === null) {
      input.sharpeningDetails = undefined
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
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error('Expected numeric value')
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const result = await getKnifeMaintenance(id)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message.includes('not found') ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json()
    const input = parseMaintenanceInput(body)
    const event = await addMaintenanceEvent({ knifeId: id, ...input })

    return NextResponse.json({ event }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message.includes('not found') ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
