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
  Pin,
  Scale,
  IdCard,
  Ruler,
  Layers,
  FileText,
  ListPlus,
  type LucideIcon,
} from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { Knife, KnifeUpdates } from '@/lib/data'
import { knifeToFormData, KnifeScrapeEditor } from '@/components/knife-form'
import { CustomField } from '@/lib/settings-shared'
import { readJsonResponse } from '@/lib/api-response'
import { getSafeExternalUrl } from '@/lib/external-url'
import { PageHeader } from '@/components/page-header'
import { ImageCountBadge } from '@/components/image-count-badge'
import { Gallery } from '@/components/gallery'
import { MaintenanceSection } from '@/components/maintenance/maintenance-section'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  activeKnifeActionStyle,
  activeKnifeOutlineClassName,
} from '@/lib/knife-action-styles'

function DetailSection({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: LucideIcon
  children: React.ReactNode
}) {
  return (
    <section
      aria-label={title}
      className="mx-5 border-t border-border/60 py-5 first:border-t-0"
    >
      <h3 className="mb-4 flex items-center gap-2 text-xs font-semibold text-foreground">
        <Icon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--bladevault-title)] dark:text-[var(--bladevault-gold)]"
          strokeWidth={1.6}
        />
        {title}
      </h3>
      {children}
    </section>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const isMissing = !value.trim() || value === 'N/A'

  return (
    <div className="min-w-0">
      <dt className="mb-1 text-[10px] leading-relaxed text-muted-foreground">
        {label}
      </dt>
      <dd className="text-[13px] leading-relaxed font-medium text-foreground tabular-nums [overflow-wrap:anywhere]">
        {isMissing ? (
          <>
            <span
              aria-hidden="true"
              className="font-normal text-muted-foreground/70"
            >
              —
            </span>
            <span className="sr-only">Not recorded</span>
          </>
        ) : (
          value
        )}
      </dd>
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
                  <Pin />
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
        title={
          <span className="inline-flex items-center gap-2">
            {[knife.brand, knife.name].filter(Boolean).join(' ')}
            <ImageCountBadge count={knife.images.length} />
          </span>
        }
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
                <Pin />
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
        <div className="contents lg:flex lg:flex-col lg:gap-6">
          <div className="order-1 lg:order-none">
            <Gallery images={knife.images} />
          </div>
          <div className="order-3 lg:order-none">
            <MaintenanceSection knifeId={knife.id} />
          </div>
        </div>

        <div className="order-2 flex flex-col gap-6 lg:order-none">
          <Card size="sm" className="gap-0 border border-border/65 py-0 ring-0">
            <CardContent className="px-0">
              {safeSourceUrl ? (
                <div className="flex items-center justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <h3 className="mb-1 text-[10px] text-muted-foreground">
                      Source
                    </h3>
                    <Link
                      href={safeSourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={safeSourceUrl}
                      className="inline-flex max-w-full items-center gap-2 rounded-sm text-xs font-medium text-foreground hover:text-[var(--bladevault-title)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring dark:hover:text-[var(--bladevault-gold)]"
                    >
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {new URL(safeSourceUrl).hostname}
                      </span>
                      <ExternalLink
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-[var(--bladevault-title)] dark:text-[var(--bladevault-gold)]"
                      />
                      <span className="sr-only">(opens in a new tab)</span>
                    </Link>
                  </div>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    Product page
                  </span>
                </div>
              ) : null}

              <DetailSection title="Identity" icon={IdCard}>
                <dl className="grid grid-cols-2 gap-x-5 gap-y-3.5">
                  {identityRows.map(({ label, value }) => (
                    <DetailRow key={label} label={label} value={value} />
                  ))}
                </dl>
              </DetailSection>

              <DetailSection title="Dimensions" icon={Ruler}>
                <dl className="grid grid-cols-2 gap-x-5 gap-y-3.5">
                  {dimensionRows.map(({ label, value }) => (
                    <DetailRow key={label} label={label} value={value} />
                  ))}
                </dl>
              </DetailSection>

              <DetailSection title="Construction" icon={Layers}>
                <dl className="grid grid-cols-2 gap-x-5 gap-y-3.5">
                  {constructionRows.map(({ label, value }) => (
                    <DetailRow key={label} label={label} value={value} />
                  ))}
                </dl>
              </DetailSection>

              <DetailSection title="Notes" icon={FileText}>
                <div className="space-y-3">
                  {knife.description ? (
                    knife.description
                      .split(/\n\s*\n/)
                      .map((p) => p.trim())
                      .filter(Boolean)
                      .map((paragraph, index) => (
                        <p
                          key={index}
                          className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
                        >
                          {paragraph}
                        </p>
                      ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No description provided.
                    </p>
                  )}
                </div>
              </DetailSection>

              {customFieldRows.length > 0 && (
                <DetailSection title="Custom Fields" icon={ListPlus}>
                  <dl className="grid grid-cols-2 gap-x-5 gap-y-3.5">
                    {customFieldRows.map(({ label, value }) => (
                      <DetailRow key={label} label={label} value={value} />
                    ))}
                  </dl>
                </DetailSection>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
