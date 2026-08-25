import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import {
  findDuplicates,
  findMissingFields,
  getCollectionStats,
  getKnifeDetails,
  searchKnives,
} from '@/lib/services/collection-service'
import {
  bulkUpdateKnifeMetadata,
  proposeKnifeChanges,
  type McpTransport,
  updateKnifeMetadata,
} from '@/lib/services/knife-service'
import {
  addMaintenanceEvent,
  getKnifeMaintenance,
  type AddMaintenanceInput,
} from '@/lib/services/maintenance-service'
import { MAINTENANCE_TYPES } from '@/lib/data'
import { recordMcpToolCall } from '@/lib/mcp/activity'
import { areMcpWritesEnabled } from '@/lib/mcp/config'

const fieldValueSchema = z.union([z.string(), z.boolean(), z.null()])
const changeSchema = z.object({
  field: z.string().min(1),
  value: fieldValueSchema,
})

function toolResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : 'Unknown error'
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

async function runTool(
  transport: McpTransport,
  callback: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  recordMcpToolCall(transport)
  try {
    return toolResult(await callback())
  } catch (error) {
    return toolError(error)
  }
}

function requireMcpWrites(): void {
  if (!areMcpWritesEnabled()) {
    throw new Error(
      'MCP write tools are disabled. Enable write access in Settings → AI / MCP to allow audited metadata updates.',
    )
  }
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const

export function createBladeVaultMcpServer(transport: McpTransport): McpServer {
  const server = new McpServer(
    { name: 'bladevault', version: '1.0.2' },
    {
      instructions:
        'BladeVault manages one local knife collection. Read records before changing them. Use propose_changes for candidate metadata, then preview bulk_update_knives before applying it. Updates require the latest updatedAt value. Never infer that duplicate candidates should be deleted, and never claim propose_changes modifies data.',
    },
  )

  server.registerTool(
    'search_knives',
    {
      title: 'Search BladeVault knives',
      description:
        'Search the local collection by text and exact field filters. Common aliases include model, steel, designer, country, blade_length, and weight.',
      inputSchema: z.object({
        query: z.string().default(''),
        filters: z
          .array(
            z.object({
              field: z.string().min(1),
              value: z.union([z.string(), z.boolean()]),
            }),
          )
          .default([]),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: readOnlyAnnotations,
    },
    (input) => runTool(transport, () => searchKnives(input)),
  )

  server.registerTool(
    'get_knife',
    {
      title: 'Get a BladeVault knife',
      description:
        'Retrieve the complete collection record, metadata, custom-field definitions, and safe image references for one exact knife ID.',
      inputSchema: z.object({ knife_id: z.string().min(1) }),
      annotations: readOnlyAnnotations,
    },
    ({ knife_id }) => runTool(transport, () => getKnifeDetails(knife_id)),
  )

  server.registerTool(
    'get_collection_stats',
    {
      title: 'Get BladeVault collection statistics',
      description:
        'Summarize collection size, completeness, distributions, measurements, recent records, and duplicate-candidate count. Optionally include the supported field schema.',
      inputSchema: z.object({ include_schema: z.boolean().default(false) }),
      annotations: readOnlyAnnotations,
    },
    ({ include_schema }) =>
      runTool(transport, () =>
        getCollectionStats({ includeSchema: include_schema }),
      ),
  )

  server.registerTool(
    'find_missing_fields',
    {
      title: 'Find missing BladeVault fields',
      description:
        'Find knives with empty built-in or configured custom fields. Returns canonical field paths and concise knife records.',
      inputSchema: z.object({
        fields: z.array(z.string().min(1)).min(1),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: readOnlyAnnotations,
    },
    (input) => runTool(transport, () => findMissingFields(input)),
  )

  server.registerTool(
    'find_duplicates',
    {
      title: 'Find possible duplicate knives',
      description:
        'Return possible duplicate pairs with deterministic scores and matching signals. This tool never merges or deletes records.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: readOnlyAnnotations,
    },
    (input) => runTool(transport, () => findDuplicates(input)),
  )

  server.registerTool(
    'propose_changes',
    {
      title: 'Validate proposed BladeVault changes',
      description:
        'Validate AI-created metadata proposals and enrich them with current values and timestamps without modifying the collection.',
      inputSchema: z.object({
        proposals: z
          .array(
            z.object({
              knife_id: z.string().min(1),
              field: z.string().min(1),
              proposed_value: fieldValueSchema,
              reason: z.string().min(1),
              confidence: z.number().min(0).max(1).optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
      annotations: readOnlyAnnotations,
    },
    ({ proposals }) =>
      runTool(transport, () =>
        proposeKnifeChanges(
          proposals.map((proposal) => ({
            knifeId: proposal.knife_id,
            field: proposal.field,
            proposedValue: proposal.proposed_value,
            reason: proposal.reason,
            confidence: proposal.confidence,
          })),
        ),
      ),
  )

  server.registerTool(
    'update_knife',
    {
      title: 'Update one BladeVault knife',
      description:
        'Update whitelisted metadata on one knife. Requires the latest updated_at value returned by get_knife and records an audit entry.',
      inputSchema: z.object({
        knife_id: z.string().min(1),
        expected_updated_at: z.string().min(1),
        changes: z.array(changeSchema).min(1).max(30),
      }),
      annotations: writeAnnotations,
    },
    ({ knife_id, expected_updated_at, changes }) =>
      runTool(transport, async () => {
        requireMcpWrites()
        return updateKnifeMetadata({
          knifeId: knife_id,
          expectedUpdatedAt: expected_updated_at,
          changes,
          transport,
        })
      }),
  )

  server.registerTool(
    'bulk_update_knives',
    {
      title: 'Preview or apply BladeVault bulk updates',
      description:
        'Validate explicit per-knife metadata changes. Preview is the default; applying requires the exact fresh preview_hash and is atomic.',
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              knife_id: z.string().min(1),
              expected_updated_at: z.string().optional(),
              changes: z.array(changeSchema).min(1).max(30),
            }),
          )
          .min(1)
          .max(100),
        apply: z.boolean().default(false),
        preview_hash: z.string().optional(),
      }),
      annotations: writeAnnotations,
    },
    ({ items, apply, preview_hash }) =>
      runTool(transport, async () => {
        if (apply) requireMcpWrites()
        return bulkUpdateKnifeMetadata({
          items: items.map((item) => ({
            knifeId: item.knife_id,
            expectedUpdatedAt: item.expected_updated_at,
            changes: item.changes,
          })),
          apply,
          previewHash: preview_hash,
          transport,
        })
      }),
  )

  server.registerTool(
    'get_knife_maintenance',
    {
      title: 'Get knife maintenance history',
      description:
        'Return maintenance events and last-done summary for a specific knife.',
      inputSchema: z.object({
        knife_id: z.string().min(1),
      }),
      annotations: readOnlyAnnotations,
    },
    ({ knife_id }) => runTool(transport, () => getKnifeMaintenance(knife_id)),
  )

  const sharpeningDetailsSchema = z
    .object({
      grit: z.string().optional(),
      angle: z.string().optional(),
      system: z.string().optional(),
      passes: z.number().int().min(0).optional(),
      ceramic: z.string().optional(),
      strop: z.string().optional(),
      compound: z.string().optional(),
      notes: z.string().optional(),
    })
    .optional()

  server.registerTool(
    'add_maintenance_event',
    {
      title: 'Add a maintenance event to a knife',
      description:
        'Log cleaning, lubrication, sharpening, disassembly, or other maintenance for a specific knife.',
      inputSchema: z.object({
        knife_id: z.string().min(1),
        type: z.enum(MAINTENANCE_TYPES as [string, ...string[]]),
        occurred_at: z.string().optional(),
        notes: z.string().optional(),
        sharpening_details: sharpeningDetailsSchema,
      }),
      annotations: writeAnnotations,
    },
    ({ knife_id, type, occurred_at, notes, sharpening_details }) =>
      runTool(transport, async () => {
        requireMcpWrites()
        const input: AddMaintenanceInput = {
          knifeId: knife_id,
          type: type as AddMaintenanceInput['type'],
          occurredAt: occurred_at,
          notes,
          sharpeningDetails: sharpening_details,
          origin: 'mcp',
        }
        const event = await addMaintenanceEvent(input)
        return { event }
      }),
  )

  return server
}
