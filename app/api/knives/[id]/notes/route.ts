import { withVaultMutationRequest } from '@/lib/vault-mutation-request'
import { requireAppUnlock } from '@/lib/app-lock'
import { NextResponse } from 'next/server'
import { reportServerError } from '@/lib/sentry/server'
import {
  addKnifeNote,
  getKnifeNotes,
  parseKnifeNoteInput,
} from '@/lib/services/knife-notes-service'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const locked = requireAppUnlock(request)
  if (locked) return locked

  try {
    const { id } = await params
    const notes = await getKnifeNotes(id)
    return NextResponse.json({ notes })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message.includes('not found') ? 404 : 500
    if (status === 500) reportServerError(error, '/api/knives/[id]/notes')
    return NextResponse.json({ error: message }, { status })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked

    try {
      const { id } = await params
      const input = parseKnifeNoteInput(await request.json())
      const note = await addKnifeNote(id, input)
      return NextResponse.json({ note }, { status: 201 })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      const status = message.includes('not found') ? 404 : 400
      return NextResponse.json({ error: message }, { status })
    }
  })
}
