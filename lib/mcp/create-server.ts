import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import {
  bulkUpdateKnifeMetadata,
  type McpTransport,
  updateKnifeMetadata,
} from '@/lib/services/knife-service'
import {
  addMaintenanceEvent,
  type AddMaintenanceInput,
} from '@/lib/services/maintenance-service'
import {
  requestKnifePriceCheck,
  updatePriceWatch,
} from '@/lib/services/price-service'
import { addKnifeFromMcp } from '@/lib/services/knife-create-service'
import { READ_TOOLS } from '@/lib/tools/read-tools'
import { PRICE_WATCH_MODES } from '@/lib/price-monitor/shared'
import { MAINTENANCE_TYPES } from '@/lib/data'
import { recordMcpToolCall, recordMcpWrite } from '@/lib/mcp/activity'
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

const checkAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

export type BladeVaultMcpServerOptions = {
  /**
   * Starts Check now in this process (the in-app HTTP server). Without it,
   * request_price_check only marks sources for the running app's queue.
   */
  requestPriceChecks?: (sourceIds: readonly number[]) => Promise<number[]>
}

export const BLADEVAULT_MCP_INSTRUCTIONS =
  'BladeVault manages one local knife collection. Read records before changing them. To add a knife, search first, preview add_knife, show the preview to the user, then apply it with the returned preview_hash. Use propose_changes for candidate metadata, then preview bulk_update_knives before applying it. Updates require the latest updatedAt value. Never infer that duplicate candidates should be deleted, and never claim propose_changes modifies data. For store price monitoring, read get_price_watch before preview-then-apply changes with update_price_watch; request_price_check only queues checks at each store’s normal pace.'

export function createBladeVaultMcpServer(
  transport: McpTransport,
  options: BladeVaultMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: 'bladevault', version: '1.0.2' },
    {
      instructions: BLADEVAULT_MCP_INSTRUCTIONS,
    },
  )

  // Read-only tools: one definition shared with the in-app chat.
  for (const tool of READ_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: readOnlyAnnotations,
      },
      (input) => runTool(transport, () => tool.run(input)),
    )
  }

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
        const result = await updateKnifeMetadata({
          knifeId: knife_id,
          expectedUpdatedAt: expected_updated_at,
          changes,
          transport,
        })
        recordMcpWrite()
        return result
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
        const result = await bulkUpdateKnifeMetadata({
          items: items.map((item) => ({
            knifeId: item.knife_id,
            expectedUpdatedAt: item.expected_updated_at,
            changes: item.changes,
          })),
          apply,
          previewHash: preview_hash,
          transport,
        })
        if (apply) recordMcpWrite()
        return result
      }),
  )

  const textField = z.string().max(500).optional()
  server.registerTool(
    'add_knife',
    {
      title: 'Preview or add a new knife',
      description:
        'Add one new knife to the collection. Preview is the default and saves nothing; it returns the normalized record, possible duplicates, and a preview_hash. Show the preview to the user, then repeat the same request with apply: true and that preview_hash. Images are not added through MCP.',
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        brand: textField,
        blade_style: textField,
        handle_material: textField,
        description: z.string().max(5000).optional(),
        source_url: z.string().max(2048).optional(),
        specs: z
          .object({
            weight: textField,
            overall_length: textField,
            blade_length: textField,
            blade_thickness: textField,
            blade_coating: textField,
            blade_material: textField,
            locking_mechanism: textField,
            designer: textField,
            model_number: textField,
            handle_length: textField,
            hardness: textField,
            price: textField,
            country: textField,
          })
          .default({}),
        apply: z.boolean().default(false),
        preview_hash: z.string().optional(),
        allow_duplicate: z.boolean().default(false),
      }),
      annotations: writeAnnotations,
    },
    (input) =>
      runTool(transport, async () => {
        if (input.apply) requireMcpWrites()
        const s = input.specs
        const result = await addKnifeFromMcp({
          knife: {
            name: input.name,
            brand: input.brand,
            bladeStyle: input.blade_style,
            handleMaterial: input.handle_material,
            description: input.description,
            sourceUrl: input.source_url,
            specs: {
              weight: s.weight,
              overallLength: s.overall_length,
              bladeLength: s.blade_length,
              bladeThickness: s.blade_thickness,
              bladeCoating: s.blade_coating,
              bladeMaterial: s.blade_material,
              lockingMechanism: s.locking_mechanism,
              designer: s.designer,
              modelNumber: s.model_number,
              handleLength: s.handle_length,
              hardness: s.hardness,
              price: s.price,
              country: s.country,
            },
          },
          apply: input.apply,
          previewHash: input.preview_hash,
          allowDuplicate: input.allow_duplicate,
          transport,
        })
        if (result.applied) recordMcpWrite()
        return result
      }),
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
        recordMcpWrite()
        return { event }
      }),
  )

  const sourceIdsSchema = z
    .array(z.number().int().positive())
    .max(10)
    .default([])

  server.registerTool(
    'update_price_watch',
    {
      title: 'Preview or apply price monitoring changes',
      description:
        'Change one knife’s price monitoring: set mode (auto, on, off), add store product URLs (at most 10 sources per knife), and pause, resume, or remove sources by ID. The source from the knife’s product link can only be paused. Preview is the default; applying requires the exact fresh preview_hash.',
      inputSchema: z.object({
        knife_id: z.string().min(1),
        mode: z.enum(PRICE_WATCH_MODES).optional(),
        add: z
          .array(
            z.object({
              url: z.string().min(1).max(2048),
              store_name: z.string().max(80).optional(),
            }),
          )
          .max(10)
          .default([]),
        pause: sourceIdsSchema,
        resume: sourceIdsSchema,
        remove: sourceIdsSchema,
        apply: z.boolean().default(false),
        preview_hash: z.string().optional(),
      }),
      annotations: writeAnnotations,
    },
    ({ knife_id, mode, add, pause, resume, remove, apply, preview_hash }) =>
      runTool(transport, async () => {
        if (apply) requireMcpWrites()
        const result = await updatePriceWatch({
          knifeId: knife_id,
          mode,
          add: add.map((item) => ({
            url: item.url,
            storeName: item.store_name,
          })),
          pause,
          resume,
          remove,
          apply,
          previewHash: preview_hash,
        })
        if (result.applied) recordMcpWrite()
        return result
      }),
  )

  server.registerTool(
    'request_price_check',
    {
      title: 'Check a knife’s store prices now',
      description:
        'Queue Check now for every active store source of one knife. Checks run at each store’s normal pace and wait out bot-check pauses; this never fetches pages immediately. Read get_price_watch later for results.',
      inputSchema: z.object({ knife_id: z.string().min(1) }),
      annotations: checkAnnotations,
    },
    ({ knife_id }) =>
      runTool(transport, async () => {
        requireMcpWrites()
        const result = await requestKnifePriceCheck({
          knifeId: knife_id,
          startChecks: options.requestPriceChecks,
        })
        recordMcpWrite()
        return result
      }),
  )

  return server
}
