'use client'

import { useId, useRef, useState } from 'react'
import Image from 'next/image'
import {
  Loader2,
  Link2,
  Plus,
  Trash2,
  AlertCircle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Upload,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Merge,
  ImageIcon,
} from 'lucide-react'
import { getImageUrl, Knife, KnifeDraft } from '@/lib/data'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import { escapeHtmlAttribute, getSafeExternalUrl } from '@/lib/external-url'
import { ScrapedProduct } from '@/lib/scrape'
import { CustomField, CustomFieldType } from '@/lib/settings-shared'
import { PageHeader, BreadcrumbItemData } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'

export type KnifeFormData = {
  brand: string
  name: string
  handleMaterial: string
  bladeStyle: string
  description: string
  weight: string
  overallLength: string
  bladeLength: string
  bladeThickness: string
  bladeCoating: string
  bladeMaterial: string
  lockingMechanism: string
  designer: string
  modelNumber: string
  handleLength: string
  hardness: string
  price: string
  country: string
  customFields: Record<string, string>
  images: string[]
  sourceUrl: string
}

export const EMPTY_KNIFE_FORM: KnifeFormData = {
  brand: '',
  name: '',
  handleMaterial: '',
  bladeStyle: '',
  description: '',
  weight: '',
  overallLength: '',
  bladeLength: '',
  bladeThickness: '',
  bladeCoating: '',
  bladeMaterial: '',
  lockingMechanism: '',
  designer: '',
  modelNumber: '',
  handleLength: '',
  hardness: '',
  price: '',
  country: '',
  customFields: {},
  images: [],
  sourceUrl: '',
}

function seedCustomFields(
  customFields: Record<string, string>,
  definitions: CustomField[],
): Record<string, string> {
  const seeded: Record<string, string> = {}
  for (const field of definitions) {
    seeded[field.id] = customFields[field.id] ?? ''
  }
  return seeded
}

export function knifeToFormData(
  knife: Knife,
  customFieldDefinitions: CustomField[] = [],
): KnifeFormData {
  return {
    brand: knife.brand,
    name: knife.name,
    handleMaterial: knife.handleMaterial,
    bladeStyle: knife.bladeStyle,
    description: knife.description,
    weight: knife.specs.weight,
    overallLength: knife.specs.overallLength,
    bladeLength: knife.specs.bladeLength,
    bladeThickness: knife.specs.bladeThickness ?? '',
    bladeCoating: knife.specs.bladeCoating ?? '',
    bladeMaterial: knife.specs.bladeMaterial ?? '',
    lockingMechanism: knife.specs.lockingMechanism ?? '',
    designer: knife.specs.designer ?? '',
    modelNumber: knife.specs.modelNumber ?? '',
    handleLength: knife.specs.handleLength ?? '',
    hardness: knife.specs.hardness ?? '',
    price: knife.specs.price ?? '',
    country: knife.specs.country,
    customFields: seedCustomFields(knife.customFields, customFieldDefinitions),
    images: knife.images,
    sourceUrl: knife.sourceUrl,
  }
}

export function formDataToKnifeDraft(
  form: KnifeFormData,
  selectedImages: Set<string>,
): KnifeDraft {
  return {
    brand: form.brand,
    name: form.name,
    bladeStyle: form.bladeStyle,
    handleMaterial: form.handleMaterial,
    pinned: false,
    images: form.images.filter((src) => selectedImages.has(src)),
    specs: {
      weight: form.weight,
      overallLength: form.overallLength,
      bladeLength: form.bladeLength,
      bladeThickness: form.bladeThickness,
      bladeCoating: form.bladeCoating,
      bladeMaterial: form.bladeMaterial,
      lockingMechanism: form.lockingMechanism,
      designer: form.designer,
      modelNumber: form.modelNumber,
      handleLength: form.handleLength,
      hardness: form.hardness,
      price: form.price,
      country: form.country,
    },
    customFields: form.customFields,
    description: form.description,
    sourceUrl: form.sourceUrl,
  }
}

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error(`Could not read ${file.name}`))
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

export async function readImageFiles(files: File[]): Promise<string[]> {
  const results = await Promise.allSettled(
    files.filter((file) => file.type.startsWith('image/')).map(readImageFile),
  )

  return Array.from(
    new Set(
      results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      ),
    ),
  )
}

type KnifeFormFieldsProps = {
  form: KnifeFormData
  updateField: <K extends keyof KnifeFormData>(
    field: K,
    value: KnifeFormData[K],
  ) => void
  customFieldDefinitions: CustomField[]
  imageUrlInput: string
  setImageUrlInput: (value: string) => void
  addImageUrl: () => void
  onImageFilesSelect: (files: File[]) => void
  selectedImages: Set<string>
  toggleImageSelection: (src: string) => void
  selectAllImages: () => void
  deselectAllImages: () => void
  removeImage: (index: number) => void
}

function inputTypeForCustomField(type: CustomFieldType): string {
  switch (type) {
    case 'number':
      return 'number'
    case 'date':
      return 'date'
    default:
      return 'text'
  }
}

function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl border border-[var(--bladevault-line)] bg-background shadow-none',
        className,
      )}
    >
      <div className="border-b border-[var(--bladevault-line)] bg-[color:var(--bladevault-surface-soft)]/70 px-4 py-3 dark:border-[#d3c097]/30">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function KnifeFormFields({
  form,
  updateField,
  customFieldDefinitions,
  imageUrlInput,
  setImageUrlInput,
  addImageUrl,
  onImageFilesSelect,
  selectedImages,
  toggleImageSelection,
  selectAllImages,
  deselectAllImages,
  removeImage,
}: KnifeFormFieldsProps) {
  const imageInputRef = useRef<HTMLInputElement>(null)
  const formId = useId()
  const [isDraggingImages, setIsDraggingImages] = useState(false)

  const importImageFiles = (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length > 0) onImageFilesSelect(imageFiles)
  }

  const reorderImage = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= form.images.length) return

    const reordered = [...form.images]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(newIndex, 0, moved)
    updateField('images', reordered)
  }

  const setFirstImage = (index: number) => {
    if (index <= 0) return
    const reordered = [
      form.images[index],
      ...form.images.filter((_, i) => i !== index),
    ]
    updateField('images', reordered)
  }

  const inputField = (
    label: string,
    field: keyof KnifeFormData,
    placeholder: string,
    span: 1 | 2 = 1,
  ) => {
    const inputId = `${formId}-${field}`

    return (
      <div className={cn('space-y-2', span === 2 && 'sm:col-span-2')}>
        <label
          htmlFor={inputId}
          className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
        >
          {label}
        </label>
        <Input
          id={inputId}
          value={form[field] as string}
          onChange={(e) =>
            updateField(field, e.target.value as KnifeFormData[typeof field])
          }
          placeholder={placeholder}
          className="bg-background/80"
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <FormSection title="Identity">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {inputField('Brand / Maker', 'brand', 'e.g. Chris Reeve Knives', 2)}
          {inputField('Model Name', 'name', 'e.g. Sebenza 31', 2)}
          {inputField('Model Number', 'modelNumber', 'e.g. 1122A4')}
          {inputField('Designer', 'designer', 'e.g. Chris Reeve')}
          {inputField('Country', 'country', 'e.g. USA')}
          {inputField('Price', 'price', 'e.g. $525')}
        </div>
      </FormSection>

      <FormSection title="Dimensions">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {inputField('Overall Length', 'overallLength', 'e.g. 8.33 in')}
          {inputField('Blade Length', 'bladeLength', 'e.g. 3.61 in')}
          {inputField('Blade Thickness', 'bladeThickness', 'e.g. 3.7 mm')}
          {inputField('Handle Length', 'handleLength', 'e.g. 3.77 in')}
          {inputField('Weight', 'weight', 'e.g. 4.7 oz')}
        </div>
      </FormSection>

      <FormSection title="Construction">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {inputField('Blade Material', 'bladeMaterial', 'e.g. AEB-L')}
          {inputField('Blade Style', 'bladeStyle', 'e.g. Drop Point')}
          {inputField('Blade Coating / Finish', 'bladeCoating', 'e.g. Satin')}
          {inputField('Handle Material', 'handleMaterial', 'e.g. Titanium')}
          {inputField(
            'Locking Mechanism',
            'lockingMechanism',
            'e.g. Compression lock',
          )}
          {inputField('Hardness', 'hardness', 'e.g. 58-60 HRC')}
        </div>
      </FormSection>

      {customFieldDefinitions.length > 0 && (
        <FormSection
          title="Custom Fields"
          description="Team-specific metadata configured in settings."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {customFieldDefinitions.map((field) => (
              <div key={field.id} className="space-y-2">
                <label
                  htmlFor={`${formId}-custom-${field.id}`}
                  className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
                >
                  {field.name}
                </label>
                <Input
                  id={`${formId}-custom-${field.id}`}
                  type={inputTypeForCustomField(field.type)}
                  step={field.type === 'number' ? 'any' : undefined}
                  value={form.customFields[field.id] ?? ''}
                  onChange={(e) =>
                    updateField('customFields', {
                      ...form.customFields,
                      [field.id]: e.target.value,
                    })
                  }
                  placeholder={field.name}
                  className="bg-background/80"
                />
              </div>
            ))}
          </div>
        </FormSection>
      )}

      <FormSection title="Notes">
        <div className="space-y-2">
          <label
            htmlFor={`${formId}-description`}
            className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
          >
            Description
          </label>
          <Textarea
            id={`${formId}-description`}
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            rows={5}
            placeholder="Short description of the knife..."
            className="bg-background/80"
          />
        </div>
      </FormSection>

      <FormSection title="Images">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Image Library
              {form.images.length > 0 && (
                <span className="ml-2 font-sans text-[10px] font-normal normal-case text-muted-foreground/70">
                  {selectedImages.size} of {form.images.length} selected
                </span>
              )}
            </div>
            {form.images.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAllImages}
                  className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground"
                >
                  Select all
                </button>
                <span className="text-border">|</span>
                <button
                  type="button"
                  onClick={deselectAllImages}
                  className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground"
                >
                  Deselect all
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-[var(--bladevault-line)]/70 bg-[color:var(--bladevault-surface-soft)]/45 p-2 sm:flex-row">
            <Input
              aria-label="Image URL"
              type="url"
              value={imageUrlInput}
              onChange={(e) => setImageUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addImageUrl()}
              placeholder="Paste image URL and press Enter"
              className="bg-background/90"
            />
            <div className="flex items-center gap-2 self-end sm:self-auto">
              <Button
                variant="outline"
                size="icon-sm"
                onClick={addImageUrl}
                disabled={!imageUrlInput.trim()}
                aria-label="Add image URL"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              importImageFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault()
              setIsDraggingImages(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setIsDraggingImages(true)
            }}
            onDragLeave={(event) => {
              if (
                !event.relatedTarget ||
                !event.currentTarget.contains(event.relatedTarget as Node)
              ) {
                setIsDraggingImages(false)
              }
            }}
            onDrop={(event) => {
              event.preventDefault()
              setIsDraggingImages(false)
              importImageFiles(Array.from(event.dataTransfer.files))
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.items).flatMap(
                (item) => {
                  const file = item.kind === 'file' ? item.getAsFile() : null
                  return file?.type.startsWith('image/') ? [file] : []
                },
              )
              if (files.length === 0) return
              event.preventDefault()
              importImageFiles(files)
            }}
            className={cn(
              'group flex min-h-24 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--bladevault-line)] bg-background/65 px-4 py-5 text-center transition-colors outline-none hover:bg-[color:var(--bladevault-surface-soft)]/70 focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-2',
              isDraggingImages &&
                'border-[var(--bladevault-gold)] bg-[color:var(--bladevault-surface-soft)] ring-2 ring-[var(--bladevault-gold)]/30',
            )}
          >
            <span className="flex size-9 items-center justify-center rounded-full border border-[var(--bladevault-line)] bg-[color:var(--bladevault-surface-soft)] text-[var(--bladevault-olive)] transition-transform group-hover:-translate-y-0.5 dark:text-[var(--bladevault-gold)]">
              <Upload className="size-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-medium text-foreground">
              {isDraggingImages
                ? 'Drop images to add them'
                : 'Drop images here or choose files'}
            </span>
            <span className="text-xs text-muted-foreground">
              Select multiple images, or paste from the clipboard
            </span>
          </button>

          {form.images.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {form.images.map((src, index) => {
                const isSelected = selectedImages.has(src)
                const isFirst = index === 0
                return (
                  <div
                    key={`${src}-${index}`}
                    onClick={() => toggleImageSelection(src)}
                    className={`group relative aspect-square cursor-pointer overflow-hidden rounded-xl border bg-white transition-colors ${
                      isSelected
                        ? 'border-emerald-500 ring-2 ring-emerald-500/15'
                        : 'border-border opacity-80 hover:opacity-100'
                    }`}
                  >
                    <Image
                      src={getImageUrl(src)}
                      alt={`Scraped image ${index + 1}`}
                      fill
                      sizes="(max-width: 640px) 33vw, 25vw"
                      className="object-cover"
                      referrerPolicy="no-referrer"
                      unoptimized
                    />
                    <div className="absolute left-2 top-2 z-10">
                      <Checkbox
                        aria-label={`Include image ${index + 1}`}
                        checked={isSelected}
                        onCheckedChange={() => toggleImageSelection(src)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeImage(index)
                      }}
                      className="absolute right-1 top-1 z-10 rounded-md bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-2"
                      aria-label={`Remove image ${index + 1}`}
                      title="Remove image"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                    {isFirst && (
                      <div className="absolute top-1 left-1/2 z-10 -translate-x-1/2 rounded bg-emerald-500 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white">
                        Cover
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-2 px-1 py-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          reorderImage(index, -1)
                        }}
                        disabled={index === 0}
                        className="rounded-full bg-white/90 p-1 text-foreground transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-2 disabled:opacity-30 disabled:hover:bg-white/90"
                        aria-label="Move image earlier"
                        title="Move earlier"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      {!isFirst && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setFirstImage(index)
                          }}
                          className="rounded-full bg-white/90 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-foreground transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-2"
                          aria-label="Set as cover image"
                          title="Set as cover"
                        >
                          Cover
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          reorderImage(index, 1)
                        }}
                        disabled={index === form.images.length - 1}
                        className="rounded-full bg-white/90 p-1 text-foreground transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-2 disabled:opacity-30 disabled:hover:bg-white/90"
                        aria-label="Move image later"
                        title="Move later"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {isSelected && (
                      <div className="absolute right-1 bottom-1 rounded-full bg-emerald-500 p-1">
                        <Check className="h-2.5 w-2.5 text-white" />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex w-full justify-center rounded-xl border border-dashed border-[var(--bladevault-line)] bg-[color:var(--bladevault-surface-soft)]/45 px-6 py-10">
              <div className="text-center">
                <div className="text-sm font-medium text-foreground/80">
                  No images yet
                </div>
                <div className="mt-1 text-xs text-muted-foreground/70">
                  Scrape a URL or paste image URLs above
                </div>
              </div>
            </div>
          )}
        </div>
      </FormSection>
    </div>
  )
}

type KnifeScrapeEditorProps = {
  initialData: KnifeFormData
  customFieldDefinitions?: CustomField[]
  mode: 'add' | 'edit'
  title: string
  description?: string
  breadcrumbs?: BreadcrumbItemData[]
  onSave: (form: KnifeFormData, selectedImages: Set<string>) => Promise<void>
  onCancel: () => void
  isSaving?: boolean
  saveError?: string | null
  actions?: React.ReactNode
}

function getKnifeFormSnapshot(
  form: KnifeFormData,
  selectedImages: Set<string>,
): string {
  return JSON.stringify({
    ...form,
    images: form.images.filter((image) => selectedImages.has(image)),
  })
}

export function KnifeScrapeEditor({
  initialData,
  customFieldDefinitions = [],
  mode,
  title,
  description,
  breadcrumbs,
  onSave,
  onCancel,
  isSaving = false,
  saveError = null,
  actions,
}: KnifeScrapeEditorProps) {
  const editorId = useId()
  const [form, setForm] = useState<KnifeFormData>(initialData)
  const [imageUrlInput, setImageUrlInput] = useState('')
  const [url, setUrl] = useState(initialData.sourceUrl)
  const [isScraping, setIsScraping] = useState(false)
  const [scrapeError, setScrapeError] = useState<string | null>(null)
  const [hasScraped, setHasScraped] = useState(false)
  const [scrapedHtml, setScrapedHtml] = useState<string>('')
  const [scrapedFinalUrl, setScrapedFinalUrl] = useState<string>('')
  const [showPreview, setShowPreview] = useState(true)
  const [selectedImages, setSelectedImages] = useState<Set<string>>(
    new Set(initialData.images),
  )
  const [lastScrapedProduct, setLastScrapedProduct] =
    useState<ScrapedProduct | null>(null)
  const [initialSnapshot] = useState(() =>
    getKnifeFormSnapshot(initialData, new Set(initialData.images)),
  )
  const hasUnsavedChanges =
    getKnifeFormSnapshot(form, selectedImages) !== initialSnapshot ||
    imageUrlInput.trim().length > 0 ||
    url !== initialData.sourceUrl
  const { confirmDiscard } = useUnsavedChanges(hasUnsavedChanges)

  const handleCancel = () => {
    if (confirmDiscard()) onCancel()
  }

  const updateField = <K extends keyof KnifeFormData>(
    field: K,
    value: KnifeFormData[K],
  ) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const addImageUrl = () => {
    const trimmed = imageUrlInput.trim()
    if (!trimmed) return
    if (form.images.includes(trimmed)) {
      setImageUrlInput('')
      return
    }
    updateField('images', [...form.images, trimmed])
    setSelectedImages((prev) => new Set(prev).add(trimmed))
    setImageUrlInput('')
  }

  const handleImageFilesSelect = async (files: File[]) => {
    const dataUrls = await readImageFiles(files)
    if (dataUrls.length === 0) return

    setForm((prev) => ({
      ...prev,
      images: [
        ...prev.images,
        ...dataUrls.filter((dataUrl) => !prev.images.includes(dataUrl)),
      ],
    }))
    setSelectedImages((prev) => {
      const next = new Set(prev)
      dataUrls.forEach((dataUrl) => next.add(dataUrl))
      return next
    })
  }

  const removeImage = (index: number) => {
    const removed = form.images[index]
    updateField(
      'images',
      form.images.filter((_, i) => i !== index),
    )
    setSelectedImages((prev) => {
      const next = new Set(prev)
      next.delete(removed)
      return next
    })
  }

  const toggleImageSelection = (src: string) => {
    setSelectedImages((prev) => {
      const next = new Set(prev)
      if (next.has(src)) {
        next.delete(src)
      } else {
        next.add(src)
      }
      return next
    })
  }

  const selectAllImages = () => {
    setSelectedImages(new Set(form.images))
  }

  const deselectAllImages = () => {
    setSelectedImages(new Set())
  }

  const applyScrapedProduct = (product: ScrapedProduct) => {
    setForm((prev) => ({
      ...prev,
      brand: product.brand || prev.brand,
      name: product.name || prev.name,
      handleMaterial: product.handleMaterial || prev.handleMaterial,
      bladeStyle: product.bladeStyle || prev.bladeStyle,
      description: product.description || prev.description,
      weight: product.specs.weight || prev.weight,
      overallLength: product.specs.overallLength || prev.overallLength,
      bladeLength: product.specs.bladeLength || prev.bladeLength,
      bladeThickness: product.specs.bladeThickness || prev.bladeThickness,
      bladeCoating: product.specs.bladeCoating || prev.bladeCoating,
      bladeMaterial: product.specs.bladeMaterial || prev.bladeMaterial,
      lockingMechanism: product.specs.lockingMechanism || prev.lockingMechanism,
      designer: product.specs.designer || prev.designer,
      modelNumber: product.specs.modelNumber || prev.modelNumber,
      handleLength: product.specs.handleLength || prev.handleLength,
      hardness: product.specs.hardness || prev.hardness,
      price: product.specs.price || prev.price,
      country: product.specs.country || prev.country,
      sourceUrl: product.sourceUrl || prev.sourceUrl,
    }))
  }

  const applyOverwriteScraped = (product: ScrapedProduct) => {
    setForm((prev) => ({
      ...prev,
      brand: product.brand || '',
      name: product.name || '',
      handleMaterial: product.handleMaterial || '',
      bladeStyle: product.bladeStyle || '',
      description: product.description || '',
      weight: product.specs.weight || '',
      overallLength: product.specs.overallLength || '',
      bladeLength: product.specs.bladeLength || '',
      bladeThickness: product.specs.bladeThickness || '',
      bladeCoating: product.specs.bladeCoating || '',
      bladeMaterial: product.specs.bladeMaterial || '',
      lockingMechanism: product.specs.lockingMechanism || '',
      designer: product.specs.designer || '',
      modelNumber: product.specs.modelNumber || '',
      handleLength: product.specs.handleLength || '',
      hardness: product.specs.hardness || '',
      price: product.specs.price || '',
      country: product.specs.country || '',
      sourceUrl: product.sourceUrl || prev.sourceUrl,
    }))
  }

  const applyScrapedImages = (product: ScrapedProduct) => {
    const newImages = Array.isArray(product.images) ? product.images : []
    setForm((prev) => ({
      ...prev,
      images: newImages,
    }))
    setSelectedImages(new Set(newImages))
  }

  const handleScrape = async () => {
    if (!url.trim()) return
    setIsScraping(true)
    setScrapeError(null)
    setHasScraped(false)
    setScrapedHtml('')
    setScrapedFinalUrl('')

    try {
      const response = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      const data = await readJsonResponse<{
        error?: string
        product: ScrapedProduct
        html?: string
        finalUrl?: string
      }>(response)

      if (!response.ok) {
        throw new Error(
          getApiErrorMessage(data, 'Failed to scrape product page'),
        )
      }

      const product = data.product
      setLastScrapedProduct(product)

      if (mode === 'add') {
        applyScrapedProduct(product)
      }
      setScrapedHtml(typeof data.html === 'string' ? data.html : '')
      setScrapedFinalUrl(
        typeof data.finalUrl === 'string' ? data.finalUrl : url.trim(),
      )
      setHasScraped(true)
      setShowPreview(true)
    } catch (error) {
      setScrapeError(
        error instanceof Error ? error.message : 'Something went wrong',
      )
    } finally {
      setIsScraping(false)
    }
  }

  const handleSave = async () => {
    if (!form.name.trim()) return
    await onSave(form, selectedImages)
  }

  const canSave = form.name.trim().length > 0
  const showForm = mode === 'edit' || hasScraped
  const safeSourceUrl = getSafeExternalUrl(form.sourceUrl)
  const safePreviewBaseUrl =
    getSafeExternalUrl(scrapedFinalUrl) ?? safeSourceUrl
  const previewHtml = scrapedHtml
    ? `${safePreviewBaseUrl ? `<base href="${escapeHtmlAttribute(safePreviewBaseUrl)}">\n` : ''}${scrapedHtml}`
    : ''

  return (
    <div className="flex flex-col min-h-0 flex-1 w-full">
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={breadcrumbs}
        actions={
          <>
            {actions}
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={isSaving}
            >
              Cancel
            </Button>
          </>
        }
      />

      <div className="space-y-6 flex-1 min-h-0 flex flex-col">
        <Card size="sm">
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor={`${editorId}-product-url`}
                className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                Product URL
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Link2 className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id={`${editorId}-product-url`}
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleScrape()}
                    placeholder="https://retailer.com/..."
                    className="pl-9"
                  />
                </div>
                <Button
                  onClick={handleScrape}
                  disabled={isScraping || !url.trim()}
                  size="sm"
                >
                  {isScraping && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {isScraping ? 'Scraping' : 'Scrape'}
                </Button>
              </div>
            </div>

            {scrapeError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{scrapeError}</span>
              </div>
            )}

            {mode === 'add' && !hasScraped && !scrapeError && !isScraping && (
              <p className="text-xs text-muted-foreground">
                Paste a knife product page URL and hit Scrape. The app will pull
                the title, brand, images, and specs when available. You can edit
                everything before saving.
              </p>
            )}

            {mode === 'edit' && !hasScraped && !scrapeError && !isScraping && (
              <p className="text-xs text-muted-foreground">
                Paste a product URL to load a preview of the source page.
                Existing fields are not changed.
              </p>
            )}

            {mode === 'edit' && hasScraped && lastScrapedProduct && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Apply scraped data:
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => applyScrapedProduct(lastScrapedProduct)}
                  title="Fill only empty fields with scraped values"
                >
                  <Merge className="h-3.5 w-3.5" />
                  Fill empty fields
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => applyOverwriteScraped(lastScrapedProduct)}
                  title="Replace all fields with scraped values"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Overwrite all fields
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => applyScrapedImages(lastScrapedProduct)}
                  title="Replace all images with scraped images"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  Refill all images
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {showForm && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 flex-1 min-h-0">
            <div className="flex flex-col min-h-0 overflow-y-auto space-y-4 pr-1">
              <KnifeFormFields
                form={form}
                updateField={updateField}
                customFieldDefinitions={customFieldDefinitions}
                imageUrlInput={imageUrlInput}
                setImageUrlInput={setImageUrlInput}
                addImageUrl={addImageUrl}
                onImageFilesSelect={handleImageFilesSelect}
                selectedImages={selectedImages}
                toggleImageSelection={toggleImageSelection}
                selectAllImages={selectAllImages}
                deselectAllImages={deselectAllImages}
                removeImage={removeImage}
              />
            </div>

            <Card className="flex flex-col overflow-hidden h-full min-h-0">
              <CardHeader className="border-b flex flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                  <CardTitle className="text-sm">
                    Scraped page preview
                  </CardTitle>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setShowPreview((prev) => !prev)}
                    title={showPreview ? 'Hide preview' : 'Show preview'}
                    aria-label={showPreview ? 'Hide preview' : 'Show preview'}
                  >
                    {showPreview ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  {safeSourceUrl && (
                    <a
                      href={safeSourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Open
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </CardHeader>
              <CardContent className="relative flex-1 min-h-0 p-0">
                {showPreview && previewHtml ? (
                  <iframe
                    title="Scraped page preview"
                    srcDoc={previewHtml}
                    sandbox=""
                    className="absolute inset-0 w-full h-full border-0 bg-white"
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <EyeOff className="h-8 w-8 mb-3 opacity-40" />
                    <span className="text-xs">
                      {hasScraped
                        ? 'Preview hidden'
                        : 'Scrape a URL to see the page preview'}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {(saveError || scrapeError) && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{saveError ?? scrapeError}</span>
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCancel}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave || isSaving}>
          {isSaving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {isSaving ? 'Saving' : mode === 'edit' ? 'Save Changes' : 'Save Item'}
        </Button>
      </div>
    </div>
  )
}
