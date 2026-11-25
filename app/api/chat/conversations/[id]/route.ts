import { NextResponse } from 'next/server'
import { z } from 'zod/v4'
import { requireAppUnlock } from '@/lib/app-lock'
import { CHAT_TITLE_MAX_LENGTH } from '@/lib/chat/shared'
import {
  ChatNotFoundError,
  deleteConversation,
  getConversation,
  updateConversation,
} from '@/lib/chat/store'
import { reportServerError } from '@/lib/sentry/server'
import { vaultAccessErrorResponse } from '@/lib/vault-access'
import { withVaultMutationRequest } from '@/lib/vault-mutation-request'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'no-store' }

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(CHAT_TITLE_MAX_LENGTH).optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.archived !== undefined,
    {
      message: 'Nothing to change.',
    },
  )

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof ChatNotFoundError)
    return NextResponse.json({ error: error.message }, { status: 404 })
  const vaultResponse = vaultAccessErrorResponse(error)
  if (vaultResponse) return vaultResponse
  reportServerError(error, '/api/chat/conversations/[id]')
  return NextResponse.json({ error: fallback }, { status: 500 })
}

/** One chat with all its messages. */
export async function GET(request: Request, { params }: Context) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  const { id } = await params
  try {
    return NextResponse.json(getConversation(id), { headers: NO_STORE })
  } catch (error) {
    return errorResponse(error, 'Could not load the chat.')
  }
}

/** Renames, archives or restores a chat. */
export async function PATCH(request: Request, { params }: Context) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    const { id } = await params
    const parsed = patchSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success)
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
        { status: 400 },
      )
    try {
      return NextResponse.json(
        { conversation: updateConversation(id, parsed.data) },
        { headers: NO_STORE },
      )
    } catch (error) {
      return errorResponse(error, 'Could not save the chat.')
    }
  })
}

/** Deletes a chat and its messages for good. */
export async function DELETE(request: Request, { params }: Context) {
  return withVaultMutationRequest(request, async () => {
    const locked = requireAppUnlock(request)
    if (locked) return locked
    const { id } = await params
    try {
      deleteConversation(id)
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    } catch (error) {
      return errorResponse(error, 'Could not delete the chat.')
    }
  })
}
