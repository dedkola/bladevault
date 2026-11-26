import { z } from 'zod/v4'
import {
  findDuplicates,
  findMissingFields,
  getCollectionStats,
  getKnifeDetails,
  searchKnives,
} from '@/lib/services/collection-service'
import { proposeKnifeChanges } from '@/lib/services/knife-service'
import { getKnifeMaintenance } from '@/lib/services/maintenance-service'
import {
  getPriceAttention,
  getPriceHistory,
  getPriceWatch,
  listPriceChanges,
  listPriceWatches,
  PRICE_CHANGE_KINDS,
  PRICE_WATCH_STATES,
} from '@/lib/services/price-service'
import { getAchievementReport } from '@/lib/services/achievements-service'
import { ACHIEVEMENT_CATEGORIES } from '@/lib/achievements/catalog'
import { HISTORY_RANGES } from '@/lib/price-monitor/insights'

/**
 * The read-only vault tools, shared by the MCP server and the in-app chat so
 * both describe and run them the same way. Each tool validates its own input
 * (`run` parses with `inputSchema`), so callers may pass raw arguments.
 */
export type ReadTool = {
  name: string
  title: string
  description: string
  inputSchema: z.ZodObject
  run: (input: unknown) => Promise<Record<string, unknown>>
}

function defineReadTool<S extends z.ZodObject>(tool: {
  name: string
  title: string
  description: string
  inputSchema: S
  run: (input: z.output<S>) => Promise<Record<string, unknown>>
}): ReadTool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    run: (input) => tool.run(tool.inputSchema.parse(input ?? {})),
  }
}

const fieldValueSchema = z.union([z.string(), z.boolean(), z.null()])

export const READ_TOOLS: readonly ReadTool[] = [
  defineReadTool({
    name: 'search_knives',
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
    run: (input) => searchKnives(input),
  }),
  defineReadTool({
    name: 'get_knife',
    title: 'Get a BladeVault knife',
    description:
      'Retrieve the complete collection record, metadata, custom-field definitions, and safe image references for one exact knife ID.',
    inputSchema: z.object({ knife_id: z.string().min(1) }),
    run: ({ knife_id }) => getKnifeDetails(knife_id),
  }),
  defineReadTool({
    name: 'get_collection_stats',
    title: 'Get BladeVault collection statistics',
    description:
      'Summarize collection size, completeness, distributions, measurements, recent records, and duplicate-candidate count. Optionally include the supported field schema.',
    inputSchema: z.object({ include_schema: z.boolean().default(false) }),
    run: ({ include_schema }) =>
      getCollectionStats({ includeSchema: include_schema }),
  }),
  defineReadTool({
    name: 'get_achievements',
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
    run: ({ status, category }) => getAchievementReport({ status, category }),
  }),
  defineReadTool({
    name: 'find_missing_fields',
    title: 'Find missing BladeVault fields',
    description:
      'Find knives with empty built-in or configured custom fields. Returns canonical field paths and concise knife records.',
    inputSchema: z.object({
      fields: z.array(z.string().min(1)).min(1),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    run: (input) => findMissingFields(input),
  }),
  defineReadTool({
    name: 'find_duplicates',
    title: 'Find possible duplicate knives',
    description:
      'Return possible duplicate pairs with deterministic scores and matching signals. This tool never merges or deletes records.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(500).default(100),
    }),
    run: (input) => findDuplicates(input),
  }),
  defineReadTool({
    name: 'propose_changes',
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
    run: ({ proposals }) =>
      proposeKnifeChanges(
        proposals.map((proposal) => ({
          knifeId: proposal.knife_id,
          field: proposal.field,
          proposedValue: proposal.proposed_value,
          reason: proposal.reason,
          confidence: proposal.confidence,
        })),
      ),
  }),
  defineReadTool({
    name: 'get_knife_maintenance',
    title: 'Get knife maintenance history',
    description:
      'Return maintenance events and last-done summary for a specific knife.',
    inputSchema: z.object({ knife_id: z.string().min(1) }),
    run: ({ knife_id }) => getKnifeMaintenance(knife_id),
  }),
  defineReadTool({
    name: 'list_price_watches',
    title: 'List price-monitored knives',
    description:
      'List knives with store price monitoring: best current in-stock price, regular price, state (attention, drop, increase, out_of_stock, same, pending, not_monitored), last change, and last check. Prices include decimal amount, minor units, and currency.',
    inputSchema: z.object({
      monitored_only: z.boolean().default(true),
      state: z.enum(PRICE_WATCH_STATES).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    }),
    run: ({ monitored_only, state, limit, offset }) =>
      listPriceWatches({ monitoredOnly: monitored_only, state, limit, offset }),
  }),
  defineReadTool({
    name: 'list_price_changes',
    title: 'List recent price and stock changes',
    description:
      'List price drops, increases, restocks (back_in_stock), and out-of-stock events within the last N days, newest first, plus the store listings that are out of stock right now.',
    inputSchema: z.object({
      days: z.number().int().min(1).max(365).default(30),
      kinds: z.array(z.enum(PRICE_CHANGE_KINDS)).max(4).default([]),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    run: ({ days, kinds, limit }) => listPriceChanges({ days, kinds, limit }),
  }),
  defineReadTool({
    name: 'get_price_history',
    title: 'Get a knife’s price history',
    description:
      'Return one knife’s price history per store source for a range (7d, 1m, 3m, 6m, 1y, all): step points, latest/low/high price, and its price and stock change events.',
    inputSchema: z.object({
      knife_id: z.string().min(1),
      range: z.enum(HISTORY_RANGES).default('3m'),
    }),
    run: ({ knife_id, range }) => getPriceHistory({ knifeId: knife_id, range }),
  }),
  defineReadTool({
    name: 'get_price_watch',
    title: 'Get a knife’s price monitoring setup',
    description:
      'Return one knife’s monitoring mode (auto, on, off), whether it is monitored and why, and its store sources with status, last price, stock, problems, and queued checks. Use the source IDs with update_price_watch.',
    inputSchema: z.object({ knife_id: z.string().min(1) }),
    run: ({ knife_id }) => getPriceWatch(knife_id),
  }),
  defineReadTool({
    name: 'get_price_attention',
    title: 'Summarize price monitoring problems',
    description:
      'Summarize what needs attention in price monitoring: sources blocked by a bot check, failed checks, pages without a price, readings AI doubts, and stores paused after repeated blocks, with overall monitoring counts.',
    inputSchema: z.object({}),
    run: () => getPriceAttention(),
  }),
]

export function findReadTool(name: string): ReadTool | undefined {
  return READ_TOOLS.find((tool) => tool.name === name)
}
