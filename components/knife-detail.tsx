'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  ExternalLink,
  Scale,
} from 'lucide-react'
import { BookmarkIcon } from '@/components/bookmark-icon'
import { useKnives } from '@/components/providers/knives-provider'
import { Knife, KnifeUpdates } from '@/lib/data'
import { knifeToFormData, KnifeScrapeEditor } from '@/components/knife-form'
import { CustomField } from '@/lib/settings-shared'
import { readJsonResponse } from '@/lib/api-response'
import { getSafeExternalUrl } from '@/lib/external-url'
import { PageHeader } from '@/components/page-header'
import { Gallery } from '@/components/gallery'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  activeKnifeActionStyle,
  activeKnifeOutlineClassName,
} from '@/lib/knife-action-styles'

function DetailSection({
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

function DetailRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--bladevault-line)]/60 py-2.5 last:border-b-0 last:pb-0 first:pt-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="max-w-[60%] text-right text-xs text-foreground">
        {value}
      </span>
    </div>
  )
}

export default function KnifeDetail({ knife: initialKnife }: { knife: Knife }) {
  const router = useRouter()
  const {
    knives,
    updateKnife,
    deleteKnife,
    compareIds,
    addToCompare,
    removeFromCompare,
  } = useKnives()

  const knife = knives.find((k) => k.id === initialKnife.id) ?? initialKnife
  const safeSourceUrl = getSafeExternalUrl(knife.sourceUrl)
  const pinned = knife.pinned
  const inCompare = compareIds.includes(knife.id)
  const knifeBreadcrumbs = [
    { label: 'Collection', href: '/collection' },
    ...(knife.brand
      ? [
          {
            label: knife.brand,
            href: `/collection?brand=${encodeURIComponent(knife.brand)}`,
          },
        ]
      : []),
    { label: knife.name },
  ]

  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isTogglingPin, setIsTogglingPin] = useState(false)
  const [isTogglingCompare, setIsTogglingCompare] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customFields, setCustomFields] = useState<CustomField[]>([])

  useEffect(() => {
    let cancelled = false

    async function loadSettings() {
      try {
        const response = await fetch('/api/settings', { cache: 'no-store' })
        const data = await readJsonResponse<{
          error?: string
          settings?: { customFields?: CustomField[] }
        }>(response)
        if (!cancelled && response.ok && data.settings?.customFields) {
          setCustomFields(data.settings.customFields)
        }
      } catch {
        // ignore
      }
    }

    loadSettings()
    return () => {
      cancelled = true
    }
  }, [])

  const handleCancel = () => {
    setError(null)
    setIsEditing(false)
  }

  const handleTogglePin = async () => {
    setIsTogglingPin(true)
    setError(null)
    try {
      await updateKnife(knife.id, { pinned: !pinned })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update pin')
    } finally {
      setIsTogglingPin(false)
    }
  }

  const handleToggleCompare = async () => {
    setIsTogglingCompare(true)
    setError(null)
    try {
      if (inCompare) {
        await removeFromCompare(knife.id)
      } else {
        await addToCompare(knife.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update compare')
    } finally {
      setIsTogglingCompare(false)
    }
  }

  const handleSave = async (
    form: ReturnType<typeof knifeToFormData>,
    selectedImages: Set<string>,
  ) => {
    setError(null)
    setIsSaving(true)

    try {
      const updates: KnifeUpdates = {
        brand: form.brand,
        name: form.name,
        bladeStyle: form.bladeStyle,
        handleMaterial: form.handleMaterial,
        description: form.description,
        sourceUrl: form.sourceUrl,
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
      }
      await updateKnife(knife.id, updates)
      setIsEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes')
      throw err
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to delete this knife? This action cannot be undone.',
    )
    if (!confirmed) return

    setIsDeleting(true)
    setError(null)

    try {
      await deleteKnife(knife.id)
      router.push('/collection')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete knife')
      setIsDeleting(false)
    }
  }

  if (isEditing) {
    return (
      <div className="flex flex-col min-h-0 flex-1 p-6 lg:p-8 w-full max-w-7xl mx-auto">
        <KnifeScrapeEditor
          mode="edit"
          initialData={knifeToFormData(knife, customFields)}
          customFieldDefinitions={customFields}
          title="Edit Knife"
          description="Edit knife details manually. Scrape loads a page preview without changing fields."
          breadcrumbs={knifeBreadcrumbs}
          onSave={handleSave}
          onCancel={handleCancel}
          isSaving={isSaving}
          saveError={error}
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleCompare}
                disabled={isSaving || isTogglingCompare}
                className={cn(
                  'text-[var(--bladevault-olive)] hover:text-[var(--bladevault-olive)] dark:text-[var(--bladevault-gold)] dark:hover:text-[var(--bladevault-gold)]',
                  inCompare && activeKnifeOutlineClassName,
                )}
                style={inCompare ? activeKnifeActionStyle : undefined}
              >
                {isTogglingCompare ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Scale className="h-3.5 w-3.5" />
                )}
                {inCompare ? 'Comparing' : 'Compare'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTogglePin}
                disabled={isSaving || isTogglingPin}
                className={cn(
                  'text-[var(--bladevault-olive)] hover:text-[var(--bladevault-olive)] dark:text-[var(--bladevault-gold)] dark:hover:text-[var(--bladevault-gold)]',
                  pinned && activeKnifeOutlineClassName,
                )}
                style={pinned ? activeKnifeActionStyle : undefined}
              >
                {isTogglingPin ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <BookmarkIcon active={pinned} />
                )}
                {pinned ? 'Pinned' : 'Pin'}
              </Button>
            </>
          }
        />
      </div>
    )
  }

  const identityRows = [
    { label: 'Model Number', value: knife.specs.modelNumber || 'N/A' },
    { label: 'Designer', value: knife.specs.designer || 'N/A' },
    { label: 'Origin', value: knife.specs.country || 'N/A' },
    { label: 'Price', value: knife.specs.price || 'N/A' },
  ]

  const constructionRows = [
    { label: 'Blade Material', value: knife.specs.bladeMaterial || 'N/A' },
    { label: 'Blade Style', value: knife.bladeStyle || 'N/A' },
    {
      label: 'Blade Coating / Finish',
      value: knife.specs.bladeCoating || 'N/A',
    },
    { label: 'Handle Material', value: knife.handleMaterial || 'N/A' },
    {
      label: 'Locking Mechanism',
      value: knife.specs.lockingMechanism || 'N/A',
    },
    { label: 'Hardness', value: knife.specs.hardness || 'N/A' },
  ]

  const dimensionRows = [
    { label: 'Overall Length', value: knife.specs.overallLength || 'N/A' },
    { label: 'Blade Length', value: knife.specs.bladeLength || 'N/A' },
    { label: 'Blade Thickness', value: knife.specs.bladeThickness || 'N/A' },
    { label: 'Handle Length', value: knife.specs.handleLength || 'N/A' },
    { label: 'Weight', value: knife.specs.weight || 'N/A' },
  ]

  const customFieldRows = customFields
    .map((field) => ({
      label: field.name,
      value: knife.customFields[field.id] || 'N/A',
    }))
    .filter(Boolean)

  return (
    <div className="flex-1 p-6 lg:p-8 w-full max-w-7xl 2xl:max-w-[100rem] mx-auto">
      <PageHeader
        title={[knife.brand, knife.name].filter(Boolean).join(' ')}
        breadcrumbs={knifeBreadcrumbs}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleCompare}
              disabled={isTogglingCompare}
              className={cn(
                'text-[var(--bladevault-olive)] hover:text-[var(--bladevault-olive)] dark:text-[var(--bladevault-gold)] dark:hover:text-[var(--bladevault-gold)]',
                inCompare && activeKnifeOutlineClassName,
              )}
              style={inCompare ? activeKnifeActionStyle : undefined}
            >
              {isTogglingCompare ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Scale className="h-3.5 w-3.5" />
              )}
              {inCompare ? 'Comparing' : 'Compare'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleTogglePin}
              disabled={isTogglingPin}
              className={cn(
                'text-[var(--bladevault-olive)] hover:text-[var(--bladevault-olive)] dark:text-[var(--bladevault-gold)] dark:hover:text-[var(--bladevault-gold)]',
                pinned && activeKnifeOutlineClassName,
              )}
              style={pinned ? activeKnifeActionStyle : undefined}
            >
              {isTogglingPin ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <BookmarkIcon active={pinned} />
              )}
              {pinned ? 'Pinned' : 'Pin'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(true)}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              disabled={isDeleting}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {isDeleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.25fr_380px] 2xl:grid-cols-[1.5fr_420px]">
        <div className="flex flex-col gap-6">
          <Gallery images={knife.images} />

          <DetailSection
            title="Notes"
          >
            <div className="max-w-3xl space-y-3">
              {knife.description ? (
                knife.description
                  .split(/\n\s*\n/)
                  .map((p) => p.trim())
                  .filter(Boolean)
                  .map((paragraph, index) => (
                    <p
                      key={index}
                      className="text-sm leading-relaxed whitespace-pre-line text-muted-foreground"
                    >
                      {paragraph}
                    </p>
                  ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No description provided.
                </p>
              )}
            </div>
          </DetailSection>

        </div>

        <div className="flex flex-col gap-6">
          <Card size="sm">
            <CardContent className="space-y-4">
              {safeSourceUrl ? (
                <div className="rounded-lg border border-[var(--bladevault-line)]/70 bg-[color:var(--bladevault-surface-soft)]/45 px-3 py-3">
                  <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Source
                  </h3>
                  <Link
                    href={safeSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 break-all text-xs text-muted-foreground hover:text-foreground"
                  >
                    {knife.sourceUrl}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </Link>
                </div>
              ) : null}

              <DetailSection title="Identity" className="rounded-lg">
                <div>
                  {identityRows.map(({ label, value }) => (
                    <DetailRow key={label} label={label} value={value} />
                  ))}
                </div>
              </DetailSection>

              <DetailSection title="Dimensions" className="rounded-lg">
                <div>
                  {dimensionRows.map(({ label, value }) => (
                    <DetailRow key={label} label={label} value={value} />
                  ))}
                </div>
              </DetailSection>

              <DetailSection title="Construction" className="rounded-lg">
                <div>
                  {constructionRows.map(({ label, value }) => (
                    <DetailRow key={label} label={label} value={value} />
                  ))}
                </div>
              </DetailSection>

              {customFieldRows.length > 0 && (
                <DetailSection
                  title="Custom Fields"
                  className="rounded-lg"
                >
                  <div>
                    {customFieldRows.map(({ label, value }) => (
                      <DetailRow key={label} label={label} value={value} />
                    ))}
                  </div>
                </DetailSection>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
