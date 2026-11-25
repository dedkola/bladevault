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
import {
  getPriceAttention,
  getPriceHistory,
  getPriceWatch,
  listPriceChanges,
  listPriceWatches,
  PRICE_CHANGE_KINDS,
  PRICE_WATCH_STATES,
  requestKnifePriceCheck,
  updatePriceWatch,
} from '@/lib/services/price-service'
import { addKnifeFromMcp } from '@/lib/services/knife-create-service'
import {
  addKnifeImagesFromMcp,
  MCP_MAX_IMAGE_URLS,
  refillKnifeImagesFromMcp,
} from '@/lib/services/knife-image-service'
import type { RenderProductPage } from '@/lib/services/product-scrape-service'
import { getAchievementReport } from '@/lib/services/achievements-service'
import { ACHIEVEMENT_CATEGORIES } from '@/lib/achievements/catalog'
import { HISTORY_RANGES } from '@/lib/price-monitor/insights'
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

/** Image writes download from the web, so they are open-world. */
const imageWriteAnnotations = {
  ...writeAnnotations,
  openWorldHint: true,
} as const

const imageUrlsSchema = z
  .array(z.string().min(1).max(2048))
  .max(MCP_MAX_IMAGE_URLS)

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
  /**
   * Renders product pages in a browser for refill_knife_images (the in-app
   * HTTP server). Without it, the page HTML is fetched directly.
   */
  renderProductPage?: RenderProductPage
}

export const BLADEVAULT_MCP_INSTRUCTIONS =
  'BladeVault manages one local knife collection. Read records before changing them. To add a knife, search first, preview add_knife, show the preview to the user, then apply it with the returned preview_hash. Photos are added by URL with add_knife (image_urls) or add_knife_images, or pulled from the knife’s source page with refill_knife_images; all preview first and apply with the preview_hash. Use propose_changes for candidate metadata, then preview bulk_update_knives before applying it. Updates require the latest updatedAt value. Never infer that duplicate candidates should be deleted, and never claim propose_changes modifies data. For store price monitoring, read get_price_watch before preview-then-apply changes with update_price_watch; request_price_check only queues checks at each store’s normal pace.'

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
    'get_achievements',
    {
      title: 'Get BladeVault achievements',
      description:
        'Return the collector rank, score, and badges with unlock dates or progress toward each target. Filter by status (all, unlocked, locked) or category. Locked secret badges are only counted, never described. Read-only: unlocks are recorded by the app.',
      inputSchema: z.object({
        status: z.enum(['all', 'unlocked', 'locked']).default('all'),
        category: z
          .enum(
            ACHIEVEMENT_CATEGORIES.map((entry) => entry.id) as [
              (typeof ACHIEVEMENT_CATEGORIES)[number]['id'],
              ...(typeof ACHIEVEMENT_CATEGORIES)[number]['id'][],
            ],
          )
          .optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    ({ status, category }) =>
      runTool(transport, () => getAchievementReport({ status, category })),
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
        'Add one new knife to the collection. Preview is the default and saves nothing; it returns the normalized record, possible duplicates, and a preview_hash. Show the preview to the user, then repeat the same request with apply: true and that preview_hash. Optional image_urls (public https image links, up to 12) are downloaded and checked in the preview and saved as the knife’s photos on apply; URLs that fail are listed and skipped.',
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        brand: textField,
        blade_style: textField,
        handle_material: textField,
        description: z.string().max(5000).optional(),
        source_url: z.string().max(2048).optional(),
        image_urls: imageUrlsSchema.optional(),
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
            imageUrls: input.image_urls,
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

  server.registerTool(
    'add_knife_images',
    {
      title: 'Preview or add photos to a knife',
      description:
        'Add photos to one knife from public https image URLs (up to 12). Preview is the default and saves nothing: it downloads and checks each URL and returns per-URL status (ok, duplicate, or error with a reason) and a preview_hash. Show it to the user, then repeat the same request with apply: true and that preview_hash. mode "append" (default) keeps the current photos; "replace" swaps them for the new ones, keeping a saved webpage screenshot. Failed URLs are skipped; exact duplicates of existing photos are not added again.',
      inputSchema: z.object({
        knife_id: z.string().min(1),
        image_urls: imageUrlsSchema.min(1),
        mode: z.enum(['append', 'replace']).default('append'),
        apply: z.boolean().default(false),
        preview_hash: z.string().optional(),
      }),
      annotations: imageWriteAnnotations,
    },
    ({ knife_id, image_urls, mode, apply, preview_hash }) =>
      runTool(transport, async () => {
        if (apply) requireMcpWrites()
        const result = await addKnifeImagesFromMcp({
          knifeId: knife_id,
          imageUrls: image_urls,
          mode,
          apply,
          previewHash: preview_hash,
          transport,
        })
        if (result.applied) recordMcpWrite()
        return result
      }),
  )

  server.registerTool(
    'refill_knife_images',
    {
      title: 'Preview or refill knife photos from its source page',
      description:
        "Replace one knife's photos with the product gallery from its source_url, like the app's Refill all images (a saved webpage screenshot is kept). Preview is the default and saves nothing: it reads the page, lists the images found (up to 12) with per-image status, and returns a preview_hash. Show it to the user, then repeat with apply: true and that preview_hash. Fails with a clear message when the knife has no source_url or the page has no usable images.",
      inputSchema: z.object({
        knife_id: z.string().min(1),
        apply: z.boolean().default(false),
        preview_hash: z.string().optional(),
      }),
      annotations: imageWriteAnnotations,
    },
    ({ knife_id, apply, preview_hash }) =>
      runTool(transport, async () => {
        if (apply) requireMcpWrites()
        const result = await refillKnifeImagesFromMcp({
          knifeId: knife_id,
          apply,
          previewHash: preview_hash,
          transport,
          renderPage: options.renderProductPage,
        })
        if (result.applied) recordMcpWrite()
        return result
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
        recordMcpWrite()
        return { event }
      }),
  )

  const sourceIdsSchema = z
    .array(z.number().int().positive())
    .max(10)
    .default([])

  server.registerTool(
    'list_price_watches',
    {
      title: 'List price-monitored knives',
      description:
        'List knives with store price monitoring: best current in-stock price, regular price, state (attention, drop, increase, out_of_stock, same, pending, not_monitored), last change, and last check. Prices include decimal amount, minor units, and currency.',
      inputSchema: z.object({
        monitored_only: z.boolean().default(true),
        state: z.enum(PRICE_WATCH_STATES).optional(),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: readOnlyAnnotations,
    },
    ({ monitored_only, state, limit, offset }) =>
      runTool(transport, () =>
        listPriceWatches({
          monitoredOnly: monitored_only,
          state,
          limit,
          offset,
        }),
      ),
  )

  server.registerTool(
    'list_price_changes',
    {
      title: 'List recent price and stock changes',
      description:
        'List price drops, increases, restocks (back_in_stock), and out-of-stock events within the last N days, newest first, plus the store listings that are out of stock right now.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).default(30),
        kinds: z.array(z.enum(PRICE_CHANGE_KINDS)).max(4).default([]),
        limit: z.number().int().min(1).max(500).default(50),
      }),
      annotations: readOnlyAnnotations,
    },
    ({ days, kinds, limit }) =>
      runTool(transport, () => listPriceChanges({ days, kinds, limit })),
  )

  server.registerTool(
    'get_price_history',
    {
      title: 'Get a knife’s price history',
      description:
        'Return one knife’s price history per store source for a range (7d, 1m, 3m, 6m, 1y, all): step points, latest/low/high price, and its price and stock change events.',
      inputSchema: z.object({
        knife_id: z.string().min(1),
        range: z.enum(HISTORY_RANGES).default('3m'),
      }),
      annotations: readOnlyAnnotations,
    },
    ({ knife_id, range }) =>
      runTool(transport, () => getPriceHistory({ knifeId: knife_id, range })),
  )

  server.registerTool(
    'get_price_watch',
    {
      title: 'Get a knife’s price monitoring setup',
      description:
        'Return one knife’s monitoring mode (auto, on, off), whether it is monitored and why, and its store sources with status, last price, stock, problems, and queued checks. Use the source IDs with update_price_watch.',
      inputSchema: z.object({ knife_id: z.string().min(1) }),
      annotations: readOnlyAnnotations,
    },
    ({ knife_id }) => runTool(transport, () => getPriceWatch(knife_id)),
  )

  server.registerTool(
    'get_price_attention',
    {
      title: 'Summarize price monitoring problems',
      description:
        'Summarize what needs attention in price monitoring: sources blocked by a bot check, failed checks, pages without a price, readings AI doubts, and stores paused after repeated blocks, with overall monitoring counts.',
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    () => runTool(transport, () => getPriceAttention()),
  )

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
