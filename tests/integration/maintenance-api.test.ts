import { afterEach, describe, expect, it } from 'vitest'
import * as activityRoute from '@/app/api/activity/route'
import * as maintenanceRoute from '@/app/api/knives/[id]/maintenance/route'
import * as maintenanceEventRoute from '@/app/api/knives/[id]/maintenance/[eventId]/route'
import * as knivesRoute from '@/app/api/knives/route'
import * as logsRoute from '@/app/api/logs/route'
import { createTempVault, type TempVault } from '@/tests/helpers/temp-vault'

let vault: TempVault | null = null

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

function eventParams(id: string, eventId: string) {
  return { params: Promise.resolve({ id, eventId }) }
}

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('maintenance API routes', () => {
  it('lists, creates, edits, and deletes maintenance events', async () => {
    vault = await createTempVault()

    const created = await knivesRoute.POST(
      jsonRequest('http://localhost/api/knives', 'POST', {
        name: 'Bugout',
        brand: 'Benchmade',
        specs: { country: 'USA' },
      }),
    )
    const { knife } = (await created.json()) as { knife: { id: string } }

    const empty = await maintenanceRoute.GET(
      new Request('http://localhost/api/knives/bugout/maintenance'),
      params(knife.id),
    )
    const emptyPayload = (await empty.json()) as {
      events: unknown[]
      lastDone: Record<string, unknown>
    }
    expect(empty.status).toBe(200)
    expect(emptyPayload.events).toEqual([])
    expect(emptyPayload.lastDone.cleaned).toBeNull()

    const add = await maintenanceRoute.POST(
      jsonRequest(
        `http://localhost/api/knives/${knife.id}/maintenance`,
        'POST',
        {
          type: 'cleaning',
          notes: 'Ultrasonic bath',
        },
      ),
      params(knife.id),
    )
    expect(add.status).toBe(201)
    const addPayload = (await add.json()) as {
      event: { id: number; type: string; notes: string }
    }
    expect(addPayload.event.type).toBe('cleaning')

    const activityPayload = (await (await activityRoute.GET()).json()) as {
      activity: Array<{
        knifeId: string
        type: string
      }>
    }
    expect(activityPayload.activity).toContainEqual(
      expect.objectContaining({
        knifeId: knife.id,
        type: 'maintained',
      }),
    )

    const logsPayload = (await (await logsRoute.GET()).json()) as {
      events: Array<{
        knifeId: string | null
        source: string
        summary: string
      }>
    }
    expect(logsPayload.events).toContainEqual(
      expect.objectContaining({
        knifeId: knife.id,
        source: 'Maintenance',
        summary: 'Cleaning was logged.',
      }),
    )

    const sharpen = await maintenanceRoute.POST(
      jsonRequest(
        `http://localhost/api/knives/${knife.id}/maintenance`,
        'POST',
        {
          type: 'sharpening',
          occurredAt: '2026-08-05T00:00:00.000Z',
          sharpeningDetails: {
            grit: '600',
            passes: 50,
          },
        },
      ),
      params(knife.id),
    )
    const sharpenPayload = (await sharpen.json()) as {
      event: { sharpeningDetails: { grit: string; passes: number } }
    }
    expect(sharpenPayload.event.sharpeningDetails).toEqual({
      grit: '600',
      passes: 50,
    })

    const sharpenEvent = sharpenPayload.event as {
      id: number
      sharpeningDetails?: { grit: string; passes: number }
      type?: string
    }
    const clearSharpening = await maintenanceEventRoute.PATCH(
      jsonRequest(
        `http://localhost/api/knives/${knife.id}/maintenance/${sharpenEvent.id}`,
        'PATCH',
        {
          type: 'cleaning',
          sharpeningDetails: null,
        },
      ),
      eventParams(knife.id, String(sharpenEvent.id)),
    )
    const clearSharpeningPayload = (await clearSharpening.json()) as {
      event: { type: string; sharpeningDetails?: unknown }
    }
    expect(clearSharpeningPayload.event.type).toBe('cleaning')
    expect(clearSharpeningPayload.event.sharpeningDetails).toBeUndefined()

    const list = (await (
      await maintenanceRoute.GET(
        new Request('http://localhost/api/knives/bugout/maintenance'),
        params(knife.id),
      )
    ).json()) as {
      events: Array<{ id: number; type: string }>
      lastDone: { sharpened: string | null }
    }
    expect(list.events).toHaveLength(2)
    expect(list.lastDone.sharpened).toBeNull()

    const edit = await maintenanceEventRoute.PATCH(
      jsonRequest(
        `http://localhost/api/knives/${knife.id}/maintenance/${addPayload.event.id}`,
        'PATCH',
        {
          notes: 'Updated notes',
        },
      ),
      eventParams(knife.id, String(addPayload.event.id)),
    )
    const editPayload = (await edit.json()) as { event: { notes: string } }
    expect(editPayload.event.notes).toBe('Updated notes')

    const remove = await maintenanceEventRoute.DELETE(
      new Request(
        `http://localhost/api/knives/${knife.id}/maintenance/${addPayload.event.id}`,
        { method: 'DELETE' },
      ),
      eventParams(knife.id, String(addPayload.event.id)),
    )
    expect(remove.status).toBe(200)

    const afterDelete = (await (
      await maintenanceRoute.GET(
        new Request('http://localhost/api/knives/bugout/maintenance'),
        params(knife.id),
      )
    ).json()) as { events: unknown[] }
    expect(afterDelete.events).toHaveLength(1)
  })

  it('returns 404 for unknown knives', async () => {
    vault = await createTempVault()

    const get = await maintenanceRoute.GET(
      new Request('http://localhost/api/knives/missing/maintenance'),
      params('missing'),
    )
    expect(get.status).toBe(404)

    const post = await maintenanceRoute.POST(
      jsonRequest('http://localhost/api/knives/missing/maintenance', 'POST', {
        type: 'cleaning',
      }),
      params('missing'),
    )
    expect(post.status).toBe(404)
  })

  it('rejects invalid maintenance payloads', async () => {
    vault = await createTempVault()

    const created = await knivesRoute.POST(
      jsonRequest('http://localhost/api/knives', 'POST', {
        name: 'Bugout',
        brand: 'Benchmade',
      }),
    )
    const { knife } = (await created.json()) as { knife: { id: string } }

    const invalid = await maintenanceRoute.POST(
      jsonRequest(
        `http://localhost/api/knives/${knife.id}/maintenance`,
        'POST',
        { type: 'invalid' },
      ),
      params(knife.id),
    )
    expect(invalid.status).toBe(400)
  })

  it('does not edit or delete an event through another knife', async () => {
    vault = await createTempVault()

    const firstKnifeResponse = await knivesRoute.POST(
      jsonRequest('http://localhost/api/knives', 'POST', {
        name: 'Bugout',
        brand: 'Benchmade',
      }),
    )
    const secondKnifeResponse = await knivesRoute.POST(
      jsonRequest('http://localhost/api/knives', 'POST', {
        name: 'Para 3',
        brand: 'Spyderco',
      }),
    )
    const { knife: firstKnife } = (await firstKnifeResponse.json()) as {
      knife: { id: string }
    }
    const { knife: secondKnife } = (await secondKnifeResponse.json()) as {
      knife: { id: string }
    }

    const add = await maintenanceRoute.POST(
      jsonRequest(
        `http://localhost/api/knives/${firstKnife.id}/maintenance`,
        'POST',
        { type: 'cleaning' },
      ),
      params(firstKnife.id),
    )
    const { event } = (await add.json()) as { event: { id: number } }

    const edit = await maintenanceEventRoute.PATCH(
      jsonRequest(
        `http://localhost/api/knives/${secondKnife.id}/maintenance/${event.id}`,
        'PATCH',
        { notes: 'Wrong knife' },
      ),
      eventParams(secondKnife.id, String(event.id)),
    )
    expect(edit.status).toBe(404)

    const remove = await maintenanceEventRoute.DELETE(
      new Request(
        `http://localhost/api/knives/${secondKnife.id}/maintenance/${event.id}`,
        { method: 'DELETE' },
      ),
      eventParams(secondKnife.id, String(event.id)),
    )
    expect(remove.status).toBe(404)

    const firstKnifeEvents = (await (
      await maintenanceRoute.GET(
        new Request(`http://localhost/api/knives/${firstKnife.id}/maintenance`),
        params(firstKnife.id),
      )
    ).json()) as { events: unknown[] }
    expect(firstKnifeEvents.events).toHaveLength(1)
  })
})
