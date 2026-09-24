import { z } from 'zod'

export const LEGACY_COMPARISON_ID = 'default-comparison'
export const COMPARISONS_REFRESH_EVENT = 'bladevault:comparisons-refresh'
const id = z.string().trim().min(1)
const name = z
  .string()
  .trim()
  .min(1, 'Enter a comparison name.')
  .max(60, 'Use 60 characters or fewer.')
const ids = z.array(id)
export const comparisonSchema = z.object({
  id,
  name,
  ids,
  createdAt: z.string(),
  updatedAt: z.string(),
  differencesOnly: z.boolean(),
  revision: z.number().int().nonnegative(),
})
export type Comparison = z.infer<typeof comparisonSchema>
const target = {
  id,
  expectedRevision: z.number().int().nonnegative().optional(),
}
export const comparisonCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), name, ids: ids.default([]) }),
  z.object({ action: z.literal('rename'), ...target, name }),
  z.object({ action: z.literal('duplicate'), ...target }),
  z.object({ action: z.literal('delete'), ...target }),
  z.object({ action: z.literal('clear'), ...target }),
  z.object({ action: z.literal('add'), ...target, ids: ids.min(1) }),
  z.object({ action: z.literal('remove'), ...target, ids: ids.min(1) }),
  z.object({
    action: z.literal('preference'),
    ...target,
    differencesOnly: z.boolean(),
  }),
  z.object({
    action: z.literal('memberships'),
    ids: ids.min(1),
    changes: z.array(z.object({ ...target, selected: z.boolean() })),
  }),
  z.object({
    action: z.literal('restore'),
    list: comparisonSchema,
    expectedRevision: z.number().int().nonnegative().nullable(),
  }),
])
export type ComparisonCommand = z.infer<typeof comparisonCommandSchema>
export type ComparisonResponse = {
  lists: Comparison[]
  listId?: string
  undo?: ComparisonCommand
}
