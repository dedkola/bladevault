import { withVaultWrite } from '@/lib/vault-access'
import {
  KNIFE_NOTE_MAX_IMAGES,
  KNIFE_NOTE_MAX_LENGTH,
  type Knife,
  type KnifeNote,
  type KnifeNoteInput,
  type KnifeNoteUpdate,
} from '@/lib/data'
import { getStorage } from '@/lib/storage'

function parseNoteBody(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Note text must be a string')
  const body = value.trim()
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

const NOTE_IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i

function parseNoteImages(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Note photos must be a list')
  if (value.length > KNIFE_NOTE_MAX_IMAGES) {
    throw new Error(`A note can have at most ${KNIFE_NOTE_MAX_IMAGES} photos`)
  }
  return value.map((image) => {
    if (typeof image !== 'string' || !image.trim()) {
      throw new Error('Each note photo must be a non-empty string')
    }
    const trimmed = image.trim()
    if (trimmed.startsWith('data:') && !NOTE_IMAGE_DATA_URL.test(trimmed)) {
      throw new Error('Note photos must be images')
    }
    return trimmed
  })
}

/** Validates a create request body. */
export function parseKnifeNoteInput(body: unknown): KnifeNoteInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object')
  }
  const { body: text, notedAt, images } = body as Record<string, unknown>
  const input: KnifeNoteInput = {
    body: parseNoteBody(text),
    ...(notedAt !== undefined ? { notedAt: parseNotedAt(notedAt) } : {}),
    ...(images !== undefined ? { images: parseNoteImages(images) } : {}),
  }
  if (!input.body && !input.images?.length) {
    throw new Error('Note text or a photo is required')
  }
  return input
}

/** Validates an edit request body; omitted fields stay unchanged. */
export function parseKnifeNoteUpdate(body: unknown): KnifeNoteUpdate {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object')
  }
  const { body: text, notedAt, images } = body as Record<string, unknown>
  const update: KnifeNoteUpdate = {}
  if (text !== undefined) update.body = parseNoteBody(text)
  if (notedAt !== undefined) update.notedAt = parseNotedAt(notedAt)
  if (images !== undefined) update.images = parseNoteImages(images)
  return update
}

async function requireKnife(knifeId: string): Promise<Knife> {
  const knife = await getStorage().getKnifeById(knifeId)
  if (!knife) throw new Error(`Knife with id "${knifeId}" not found`)
  return knife
}

/**
 * Saves uploaded (`data:image`) note photos into the knife's gallery and
 * returns the note's photo list as gallery paths, plus the updated knife when
 * the gallery grew. Must run inside `withVaultWrite`.
 */
async function resolveNoteImages(
  knifeId: string,
  images: string[] | undefined,
): Promise<{ images: string[] | undefined; knife?: Knife }> {
  if (!images?.some((image) => image.startsWith('data:'))) return { images }
  const knife = await requireKnife(knifeId)
  const uploads = Array.from(
    new Set(images.filter((image) => image.startsWith('data:'))),
  )
  const updated = await getStorage().updateKnife(knifeId, {
    images: [...knife.images, ...uploads],
  })
  const previous = new Set(knife.images)
  const added = updated.images.filter((image) => !previous.has(image))
  if (added.length !== uploads.length) {
    throw new Error('Failed to save note photos')
  }
  const savedPaths = new Map(
    uploads.map((upload, index) => [upload, added[index]]),
  )
  return {
    images: images.map((image) => savedPaths.get(image) ?? image),
    knife: updated,
  }
}

export type KnifeNoteWriteResult = {
  note: KnifeNote
  /** Present when uploaded photos were added to the knife's gallery. */
  knife?: Knife
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
): Promise<KnifeNoteWriteResult> {
  return withVaultWrite(async () => {
    await requireKnife(knifeId)
    const resolved = await resolveNoteImages(knifeId, input.images)
    const note = await getStorage().addKnifeNote(knifeId, {
      ...input,
      ...(resolved.images ? { images: resolved.images } : {}),
    })
    return { note, ...(resolved.knife ? { knife: resolved.knife } : {}) }
  })
}

export async function updateKnifeNote(
  knifeId: string,
  noteId: number,
  input: KnifeNoteUpdate,
): Promise<KnifeNoteWriteResult> {
  return withVaultWrite(async () => {
    await requireNoteOnKnife(knifeId, noteId)
    const resolved = await resolveNoteImages(knifeId, input.images)
    const note = await getStorage().updateKnifeNote(noteId, {
      ...input,
      ...(resolved.images ? { images: resolved.images } : {}),
    })
    return { note, ...(resolved.knife ? { knife: resolved.knife } : {}) }
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
