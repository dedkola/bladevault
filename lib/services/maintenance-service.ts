import {
  isMaintenanceType,
  MaintenanceEvent,
  MaintenanceEventInput,
  MaintenanceEventUpdate,
  MaintenanceType,
} from '@/lib/data'
import { getStorage } from '@/lib/storage'

export type MaintenanceEventListResult = {
  events: MaintenanceEvent[]
  lastDone: Record<
    'cleaned' | 'lubricated' | 'sharpened' | 'disassembled',
    string | null
  >
}

export type AddMaintenanceInput = {
  knifeId: string
  type: MaintenanceType
  occurredAt?: string
  notes?: string
  sharpeningDetails?: MaintenanceEventInput['sharpeningDetails']
  origin?: 'manual' | 'mcp'
}

export type UpdateMaintenanceInput = {
  knifeId: string
  eventId: number
} & MaintenanceEventUpdate

const trackedTypes = [
  { type: 'cleaning', key: 'cleaned' as const },
  { type: 'lubrication', key: 'lubricated' as const },
  { type: 'sharpening', key: 'sharpened' as const },
  { type: 'disassembly', key: 'disassembled' as const },
]

export async function getKnifeMaintenance(
  knifeId: string,
): Promise<MaintenanceEventListResult> {
  const storage = getStorage()
  const knife = await storage.getKnifeById(knifeId)
  if (!knife) {
    throw new Error(`Knife with id "${knifeId}" not found`)
  }

  const events = await storage.getMaintenanceEvents(knifeId)
  const lastDone: MaintenanceEventListResult['lastDone'] = {
    cleaned: null,
    lubricated: null,
    sharpened: null,
    disassembled: null,
  }

  for (const { type, key } of trackedTypes) {
    const match = events.find((event) => event.type === type)
    if (match) {
      lastDone[key] = match.occurredAt
    }
  }

  return { events, lastDone }
}

function validateMaintenanceInput(
  input: AddMaintenanceInput,
): MaintenanceEventInput {
  if (!isMaintenanceType(input.type)) {
    throw new Error(`Invalid maintenance type: ${input.type}`)
  }

  return {
    type: input.type,
    occurredAt: input.occurredAt?.trim() || new Date().toISOString(),
    notes: input.notes?.trim(),
    sharpeningDetails: input.sharpeningDetails,
  }
}

export async function addMaintenanceEvent(input: AddMaintenanceInput) {
  const storage = getStorage()
  const knife = await storage.getKnifeById(input.knifeId)
  if (!knife) {
    throw new Error(`Knife with id "${input.knifeId}" not found`)
  }

  const validated = validateMaintenanceInput(input)
  return storage.addMaintenanceEvent(input.knifeId, validated, {
    actor: input.origin === 'mcp' ? 'MCP client' : 'You',
    source:
      input.origin === 'mcp' ? 'MCP / add_maintenance_event' : 'Maintenance',
  })
}

export async function updateMaintenanceEvent(input: UpdateMaintenanceInput) {
  const storage = getStorage()
  const events = await storage.getMaintenanceEvents(input.knifeId)
  if (!events.some((event) => event.id === input.eventId)) {
    throw new Error(
      `Maintenance event with id "${input.eventId}" not found for knife "${input.knifeId}"`,
    )
  }

  const partial: MaintenanceEventUpdate = {}

  if (input.type !== undefined) {
    if (!isMaintenanceType(input.type)) {
      throw new Error(`Invalid maintenance type: ${input.type}`)
    }
    partial.type = input.type
  }

  if (input.occurredAt !== undefined) {
    partial.occurredAt = input.occurredAt.trim() || new Date().toISOString()
  }

  if (input.notes !== undefined) {
    partial.notes = input.notes.trim()
  }

  if (input.sharpeningDetails !== undefined) {
    partial.sharpeningDetails = input.sharpeningDetails
  }

  return storage.updateMaintenanceEvent(input.eventId, partial)
}

export async function deleteMaintenanceEvent(knifeId: string, eventId: number) {
  const storage = getStorage()
  const events = await storage.getMaintenanceEvents(knifeId)
  if (!events.some((event) => event.id === eventId)) {
    throw new Error(
      `Maintenance event with id "${eventId}" not found for knife "${knifeId}"`,
    )
  }
  await storage.deleteMaintenanceEvent(eventId)
}
