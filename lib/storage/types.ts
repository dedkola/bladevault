import { Knife, KnifeUpdates } from '@/lib/data'

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

export interface Storage {
  getAllKnives(): Promise<Knife[]>
  getKnifeById(id: string): Promise<Knife | undefined>
  createKnife(input: CreateKnifeInput): Promise<Knife>
  updateKnife(id: string, updates: KnifeUpdates): Promise<Knife>
  bulkUpdateKnives(ids: string[], updates: KnifeUpdates): Promise<Knife[]>
  deleteKnife(id: string): Promise<void>
  getImage(path: string): Promise<ImageData>
  getImageStream?(path: string): Promise<ImageStream>
  init?(): Promise<void>
  getCompareList(): Promise<string[]>
  addToCompare(id: string): Promise<void>
  removeFromCompare(id: string): Promise<void>
  clearCompareList(): Promise<void>
}
