import { Knife, KnifeActivityEvent, KnifeUpdates } from '@/lib/data'
import type { ValidatedKnifeChange } from '@/lib/knife-fields'

export type CreateKnifeInput = Omit<
  Knife,
  'id' | 'addedAt' | 'updatedAt' | 'images' | 'customFields'
> & {
  imageUrls: string[]
  customFields?: Partial<Knife['customFields']>
}

export interface ImageData {
  buffer: Buffer
  contentType: string
}

export interface ImageStream {
  stream: ReadableStream<Uint8Array>
  contentType: string
}

export type KnifeMutationContext = {
  operationId: string
  source: 'mcp'
  transport: 'stdio' | 'http'
  changes: ValidatedKnifeChange[]
}

export type KnifeUpdateOptions = {
  expectedUpdatedAt?: string
  mutation?: KnifeMutationContext
}

export type BulkKnifeUpdateItem = {
  id: string
  updates: KnifeUpdates
  expectedUpdatedAt: string
  changes: ValidatedKnifeChange[]
}

export interface Storage {
  getAllKnives(): Promise<Knife[]>
  getKnifeActivity(): Promise<KnifeActivityEvent[]>
  getKnifeById(id: string): Promise<Knife | undefined>
  createKnife(input: CreateKnifeInput): Promise<Knife>
  updateKnife(
    id: string,
    updates: KnifeUpdates,
    options?: KnifeUpdateOptions,
  ): Promise<Knife>
  bulkUpdateKnives(ids: string[], updates: KnifeUpdates): Promise<Knife[]>
  bulkUpdateKnifeItems(
    items: BulkKnifeUpdateItem[],
    context: Omit<KnifeMutationContext, 'changes'>,
  ): Promise<Knife[]>
  deleteKnife(id: string): Promise<void>
  getImage(path: string): Promise<ImageData>
  getImageStream?(path: string): Promise<ImageStream>
  init?(): Promise<void>
  getCompareList(): Promise<string[]>
  addToCompare(id: string): Promise<void>
  removeFromCompare(id: string): Promise<void>
  clearCompareList(): Promise<void>
}
