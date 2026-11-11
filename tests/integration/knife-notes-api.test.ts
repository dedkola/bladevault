import { afterEach, describe, expect, it } from 'vitest'
import * as notesRoute from '@/app/api/knives/[id]/notes/route'
import * as noteRoute from '@/app/api/knives/[id]/notes/[noteId]/route'
import * as knifeRoute from '@/app/api/knives/[id]/route'
import * as knivesRoute from '@/app/api/knives/route'
import * as logsRoute from '@/app/api/logs/route'
import { getLocalDb, LOCAL_DB_SCHEMA_VERSION } from '@/lib/local-db'
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

function noteParams(id: string, noteId: string | number) {
  return { params: Promise.resolve({ id, noteId: String(noteId) }) }
}

type NotePayload = {
  note: { id: number; body: string; notedAt: string; knifeId: string }
}

async function createKnife(name: string) {
  const response = await knivesRoute.POST(
    jsonRequest('http://localhost/api/knives', 'POST', {
      name,
      brand: 'Benchmade',
      specs: { country: 'USA' },
    }),
  )
  return ((await response.json()) as { knife: { id: string } }).knife.id
}

async function listNotes(knifeId: string) {
  const response = await notesRoute.GET(
    new Request(`http://localhost/api/knives/${knifeId}/notes`),
    params(knifeId),
  )
  return {
    status: response.status,
    notes:
      ((await response.json()) as { notes?: NotePayload['note'][] }).notes ??
      [],
  }
}

afterEach(async () => {
  await vault?.cleanup()
  vault = null
})

describe('knife notes API routes', () => {
  it('adds, lists by date, edits, and deletes notes with log entries', async () => {
    vault = await createTempVault()
    expect(getLocalDb().pragma('user_version', { simple: true })).toBe(
      LOCAL_DB_SCHEMA_VERSION,
    )
    const knifeId = await createKnife('Bugout')

    expect(await listNotes(knifeId)).toEqual({ status: 200, notes: [] })

    const older = await notesRoute.POST(
      jsonRequest(`http://localhost/api/knives/${knifeId}/notes`, 'POST', {
        body: '  Arrived with a slightly off-center blade.  ',
        notedAt: '2026-10-01T09:00:00.000Z',
      }),
      params(knifeId),
    )
    expect(older.status).toBe(201)
    const olderNote = ((await older.json()) as NotePayload).note
    expect(olderNote.body).toBe('Arrived with a slightly off-center blade.')

    const newer = await notesRoute.POST(
      jsonRequest(`http://localhost/api/knives/${knifeId}/notes`, 'POST', {
        body: 'Centered after loosening the pivot.',
        notedAt: '2026-11-02T09:00:00.000Z',
      }),
      params(knifeId),
    )
    const newerNote = ((await newer.json()) as NotePayload).note

    expect((await listNotes(knifeId)).notes.map((note) => note.id)).toEqual([
      newerNote.id,
      olderNote.id,
    ])

    const edit = await noteRoute.PATCH(
      jsonRequest(
        `http://localhost/api/knives/${knifeId}/notes/${olderNote.id}`,
        'PATCH',
        { body: 'Arrived off-center.' },
      ),
      noteParams(knifeId, olderNote.id),
    )
    expect(edit.status).toBe(200)
    expect(((await edit.json()) as NotePayload).note).toMatchObject({
      body: 'Arrived off-center.',
      notedAt: '2026-10-01T09:00:00.000Z',
    })

    const remove = await noteRoute.DELETE(
      new Request(
        `http://localhost/api/knives/${knifeId}/notes/${newerNote.id}`,
        { method: 'DELETE' },
      ),
      noteParams(knifeId, newerNote.id),
    )
    expect(remove.status).toBe(200)
    expect((await listNotes(knifeId)).notes).toHaveLength(1)

    const logs = (await (
      await logsRoute.GET(new Request('http://localhost/api/logs'))
    ).json()) as {
      events: Array<{ knifeId: string; source: string; summary: string }>
    }
    const noteSummaries = logs.events
      .filter((event) => event.source === 'Notes')
      .map((event) => event.summary)
    expect(noteSummaries).toEqual([
      'A note was deleted.',
      'A note was updated.',
      'A note was added.',
      'A note was added.',
    ])
  })

  it('rejects empty notes and notes that belong to another knife', async () => {
    vault = await createTempVault()
    const first = await createKnife('Bugout')
    const second = await createKnife('Mini Bugout')

    const empty = await notesRoute.POST(
      jsonRequest(`http://localhost/api/knives/${first}/notes`, 'POST', {
        body: '   ',
      }),
      params(first),
    )
    expect(empty.status).toBe(400)

    const badDate = await notesRoute.POST(
      jsonRequest(`http://localhost/api/knives/${first}/notes`, 'POST', {
        body: 'Fine',
        notedAt: 'not a date',
      }),
      params(first),
    )
    expect(badDate.status).toBe(400)

    const created = await notesRoute.POST(
      jsonRequest(`http://localhost/api/knives/${first}/notes`, 'POST', {
        body: 'Belongs to the first knife.',
      }),
      params(first),
    )
    const note = ((await created.json()) as NotePayload).note

    const crossEdit = await noteRoute.PATCH(
      jsonRequest(
        `http://localhost/api/knives/${second}/notes/${note.id}`,
        'PATCH',
        { body: 'Hijacked' },
      ),
      noteParams(second, note.id),
    )
    expect(crossEdit.status).toBe(404)

    const missingKnife = await listNotes('missing-knife')
    expect(missingKnife.status).toBe(404)
  })

  it('removes a knife’s notes when the knife is deleted', async () => {
    vault = await createTempVault()
    const knifeId = await createKnife('Bugout')
    await notesRoute.POST(
      jsonRequest(`http://localhost/api/knives/${knifeId}/notes`, 'POST', {
        body: 'Gone with the knife.',
      }),
      params(knifeId),
    )

    const deleted = await knifeRoute.DELETE(
      new Request(`http://localhost/api/knives/${knifeId}`, {
        method: 'DELETE',
      }),
      params(knifeId),
    )
    expect(deleted.status).toBe(200)

    const remaining = getLocalDb()
      .prepare('SELECT COUNT(*) AS total FROM knife_notes WHERE knife_id = ?')
      .get(knifeId) as { total: number }
    expect(remaining.total).toBe(0)
  })
})
