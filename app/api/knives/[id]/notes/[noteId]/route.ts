import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import {
  deleteKnifeNote,
  parseKnifeNoteUpdate,
  updateKnifeNote,
} from '@/lib/services/knife-notes-service'

function parseNoteId(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Invalid note id')
  }
  return parsed
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown error'
  const status = message.includes('not found') ? 404 : 400
  return NextResponse.json({ error: message }, { status })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    try {
      const { id, noteId } = await params
      const input = parseKnifeNoteUpdate(await request.json())
      const note = await updateKnifeNote(id, parseNoteId(noteId), input)
      return NextResponse.json({ note })
    } catch (error) {
      return errorResponse(error)
    }
  })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    try {
      const { id, noteId } = await params
      await deleteKnifeNote(id, parseNoteId(noteId))
      return NextResponse.json({ success: true })
    } catch (error) {
      return errorResponse(error)
    }
  })
}
