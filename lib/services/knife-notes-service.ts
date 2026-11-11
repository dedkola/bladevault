import { withVaultWrite } from '@/lib/vault-access'
import {
  KNIFE_NOTE_MAX_LENGTH,
  type KnifeNote,
  type KnifeNoteInput,
  type KnifeNoteUpdate,
} from '@/lib/data'
import { getStorage } from '@/lib/storage'

function parseNoteBody(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Note text must be a string')
  const body = value.trim()
  if (!body) throw new Error('Note text is required')
  if (body.length > KNIFE_NOTE_MAX_LENGTH) {
    throw new Error(
      `Notes can be at most ${KNIFE_NOTE_MAX_LENGTH.toLocaleString('en-US')} characters`,
    )
  }
  return body
}

function parseNotedAt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('notedAt must be a non-empty date string')
  }
  const trimmed = value.trim()
  if (Number.isNaN(new Date(trimmed).getTime())) {
    throw new Error('notedAt must be a valid date')
  }
  return trimmed
}

/** Validates a create request body. */
export function parseKnifeNoteInput(body: unknown): KnifeNoteInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object')
  }
  const { body: text, notedAt } = body as Record<string, unknown>
  return {
    body: parseNoteBody(text),
    ...(notedAt !== undefined ? { notedAt: parseNotedAt(notedAt) } : {}),
  }
}

/** Validates an edit request body; omitted fields stay unchanged. */
export function parseKnifeNoteUpdate(body: unknown): KnifeNoteUpdate {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object')
  }
  const { body: text, notedAt } = body as Record<string, unknown>
  const update: KnifeNoteUpdate = {}
  if (text !== undefined) update.body = parseNoteBody(text)
  if (notedAt !== undefined) update.notedAt = parseNotedAt(notedAt)
  return update
}

async function requireKnife(knifeId: string) {
  const knife = await getStorage().getKnifeById(knifeId)
  if (!knife) throw new Error(`Knife with id "${knifeId}" not found`)
}

async function requireNoteOnKnife(knifeId: string, noteId: number) {
  const notes = await getStorage().getKnifeNotes(knifeId)
  if (!notes.some((note) => note.id === noteId)) {
    throw new Error(`Note with id "${noteId}" not found for knife "${knifeId}"`)
  }
}

export async function getKnifeNotes(knifeId: string): Promise<KnifeNote[]> {
  await requireKnife(knifeId)
  return getStorage().getKnifeNotes(knifeId)
}

export async function addKnifeNote(
  knifeId: string,
  input: KnifeNoteInput,
): Promise<KnifeNote> {
  return withVaultWrite(async () => {
    await requireKnife(knifeId)
    return getStorage().addKnifeNote(knifeId, input)
  })
}

export async function updateKnifeNote(
  knifeId: string,
  noteId: number,
  input: KnifeNoteUpdate,
): Promise<KnifeNote> {
  return withVaultWrite(async () => {
    await requireNoteOnKnife(knifeId, noteId)
    return getStorage().updateKnifeNote(noteId, input)
  })
}

export async function deleteKnifeNote(
  knifeId: string,
  noteId: number,
): Promise<void> {
  return withVaultWrite(async () => {
    await requireNoteOnKnife(knifeId, noteId)
    await getStorage().deleteKnifeNote(noteId)
  })
}
