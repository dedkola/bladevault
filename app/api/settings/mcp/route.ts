import { z } from 'zod/v4'
import {
  getMcpRuntimeStatus,
  McpSettingManagedError,
  updateMcpRuntimeSettings,
} from '@/lib/mcp/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    writeEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.enabled !== undefined || value.writeEnabled !== undefined,
    { message: 'Provide an MCP setting to update.' },
  )

export async function GET() {
  try {
    return Response.json(
      { mcp: getMcpRuntimeStatus() },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load MCP settings.'
    return Response.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message || 'Invalid MCP settings.' },
      { status: 400 },
    )
  }

  try {
    return Response.json(
      { mcp: updateMcpRuntimeSettings(parsed.data) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to save MCP settings.'
    return Response.json(
      { error: message },
      { status: error instanceof McpSettingManagedError ? 409 : 500 },
    )
  }
}
