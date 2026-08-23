'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Loader2,
  Link2,
  AlertCircle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Monitor,
  X,
  RefreshCw,
} from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'

import {
  KnifeFormData,
  EMPTY_KNIFE_FORM,
  KnifeFormFields,
  formDataToKnifeDraft,
  readImageFiles,
} from '@/components/knife-form'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import { escapeHtmlAttribute, getSafeExternalUrl } from '@/lib/external-url'
import { ScrapedProduct } from '@/lib/scrape'
import { CustomField } from '@/lib/settings-shared'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'

const TABS = ['Scrape URL', 'Manual'] as const
type Tab = (typeof TABS)[number]

function hasKnifeFormContent(form: KnifeFormData): boolean {
  return Object.values(form).some((value) => {
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    return Object.values(value).some((entry) => entry.trim().length > 0)
  })
}

export function AddKnifeForm() {
  const router = useRouter()
  const { addKnife } = useKnives()
  const [activeTab, setActiveTab] = useState<Tab>('Scrape URL')
  const [form, setForm] = useState<KnifeFormData>(EMPTY_KNIFE_FORM)
  const [imageUrlInput, setImageUrlInput] = useState('')
  const [url, setUrl] = useState('')
  const [isScraping, setIsScraping] = useState(false)
  const [scrapeError, setScrapeError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [hasScraped, setHasScraped] = useState(false)
  const [scrapedHtml, setScrapedHtml] = useState<string>('')
  const [scrapedFinalUrl, setScrapedFinalUrl] = useState<string>('')
  const [showPreview, setShowPreview] = useState(true)
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set())
  const [isSaving, setIsSaving] = useState(false)
  const [interactiveSessionId, setInteractiveSessionId] = useState<
    string | null
  >(null)
  const interactiveSessionIdRef = useRef<string | null>(null)
  const [interactiveStatus, setInteractiveStatus] = useState<
    'starting' | 'waiting' | 'scraping' | null
  >(null)
  const [interactiveIsChallenge, setInteractiveIsChallenge] = useState<
    boolean | null
  >(null)
  const [interactiveError, setInteractiveError] = useState<string | null>(null)
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

  const seededForm = useMemo(() => {
    const seeded: KnifeFormData = {
      ...form,
      customFields: { ...form.customFields },
    }
    for (const field of customFields) {
      if (!(field.id in seeded.customFields)) {
        seeded.customFields[field.id] = ''
      }
    }
    return seeded
  }, [form, customFields])

  const hasUnsavedChanges = useMemo(
    () =>
      hasKnifeFormContent(form) ||
      url.trim().length > 0 ||
      imageUrlInput.trim().length > 0,
    [form, imageUrlInput, url],
  )
  const { allowNavigation, confirmDiscard } =
    useUnsavedChanges(hasUnsavedChanges)

  const handleCancel = () => {
    if (confirmDiscard()) router.back()
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

  const handleSave = async () => {
    if (!form.name.trim()) return
    setIsSaving(true)
    try {
      await addKnife(formDataToKnifeDraft(form, selectedImages))
      allowNavigation()
      router.push('/collection')
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : 'Failed to save knife',
      )
    } finally {
      setIsSaving(false)
    }
  }

  const applyScrapedProduct = (
    product: ScrapedProduct,
    html: string,
    finalUrl: string,
  ) => {
    setForm((prev) => ({
      ...prev,
      brand: product.brand ?? '',
      name: product.name ?? '',
      handleMaterial: product.handleMaterial ?? '',
      bladeStyle: product.bladeStyle ?? '',
      description: product.description ?? '',
      weight: product.specs?.weight ?? '',
      overallLength: product.specs?.overallLength ?? '',
      bladeLength: product.specs?.bladeLength ?? '',
      bladeThickness: product.specs?.bladeThickness ?? '',
      bladeCoating: product.specs?.bladeCoating ?? '',
      bladeMaterial: product.specs?.bladeMaterial ?? '',
      lockingMechanism: product.specs?.lockingMechanism ?? '',
      designer: product.specs?.designer ?? '',
      modelNumber: product.specs?.modelNumber ?? '',
      handleLength: product.specs?.handleLength ?? '',
      hardness: product.specs?.hardness ?? '',
      price: product.specs?.price ?? '',
      country: product.specs?.country ?? '',
      images: Array.isArray(product.images) ? product.images : [],
      sourceUrl: product.sourceUrl ?? url.trim(),
    }))
    setSelectedImages(
      new Set(Array.isArray(product.images) ? product.images : []),
    )
    setScrapedHtml(html)
    setScrapedFinalUrl(finalUrl)
    setHasScraped(true)
    setShowPreview(true)
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

      applyScrapedProduct(
        data.product,
        typeof data.html === 'string' ? data.html : '',
        typeof data.finalUrl === 'string' ? data.finalUrl : url.trim(),
      )
    } catch (error) {
      setScrapeError(
        error instanceof Error ? error.message : 'Something went wrong',
      )
    } finally {
      setIsScraping(false)
    }
  }

  const isBotProtectionError = (message: string | null) => {
    if (!message) return false
    const lower = message.toLowerCase()
    return (
      lower.includes('bot protection') ||
      lower.includes('security verification') ||
      lower.includes('cloudflare')
    )
  }

  const resetInteractiveState = () => {
    setInteractiveSessionId(null)
    setInteractiveStatus(null)
    setInteractiveIsChallenge(null)
    setInteractiveError(null)
  }

  const startInteractiveScrape = async () => {
    if (!url.trim()) return
    setInteractiveStatus('starting')
    setInteractiveError(null)

    try {
      const response = await fetch('/api/scrape/interactive/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      const data = await readJsonResponse<{
        error?: string
        sessionId?: string
      }>(response)

      if (!response.ok) {
        throw new Error(
          getApiErrorMessage(data, 'Failed to start interactive browser'),
        )
      }

      if (typeof data.sessionId !== 'string') {
        throw new Error('Invalid response from interactive scrape start')
      }

      setInteractiveSessionId(data.sessionId)
      setInteractiveStatus('waiting')
    } catch (error) {
      setInteractiveError(
        error instanceof Error ? error.message : 'Something went wrong',
      )
      setInteractiveStatus(null)
    }
  }

  const captureInteractiveScrape = async () => {
    if (!interactiveSessionId) return
    setInteractiveStatus('scraping')

    try {
      const response = await fetch(
        `/api/scrape/interactive/${interactiveSessionId}/scrape`,
        {
          method: 'POST',
        },
      )
      const data = await readJsonResponse<{
        error?: string
        product: ScrapedProduct
        html?: string
        finalUrl?: string
      }>(response)

      if (!response.ok) {
        throw new Error(
          getApiErrorMessage(data, 'Failed to capture product page'),
        )
      }

      applyScrapedProduct(
        data.product,
        typeof data.html === 'string' ? data.html : '',
        typeof data.finalUrl === 'string' ? data.finalUrl : url.trim(),
      )
      resetInteractiveState()
    } catch (error) {
      setInteractiveError(
        error instanceof Error ? error.message : 'Something went wrong',
      )
      setInteractiveStatus('waiting')
    }
  }

  const cancelInteractiveScrape = async () => {
    if (!interactiveSessionId) {
      resetInteractiveState()
      return
    }

    try {
      await fetch(`/api/scrape/interactive/${interactiveSessionId}/cancel`, {
        method: 'POST',
      })
    } catch {
      // ignore cancel errors
    } finally {
      resetInteractiveState()
    }
  }

  useEffect(() => {
    interactiveSessionIdRef.current = interactiveSessionId
  }, [interactiveSessionId])

  useEffect(() => {
    if (!interactiveSessionId || interactiveStatus !== 'waiting') return

    let cancelled = false
    const currentSessionId = interactiveSessionId
    const checkStatus = async () => {
      try {
        const response = await fetch(
          `/api/scrape/interactive/${currentSessionId}/status`,
        )
        if (cancelled) return
        const data = await readJsonResponse<{
          status?: string
          isSecurityChallenge?: boolean
        }>(response)
        setInteractiveIsChallenge(data.isSecurityChallenge ?? null)
      } catch {
        // ignore polling errors
      }
    }

    checkStatus()
    const interval = setInterval(checkStatus, 2500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [interactiveSessionId, interactiveStatus])

  useEffect(() => {
    return () => {
      const sessionId = interactiveSessionIdRef.current
      if (sessionId) {
        void fetch(`/api/scrape/interactive/${sessionId}/cancel`, {
          method: 'POST',
        })
      }
    }
  }, [])

  const canSave = form.name.trim().length > 0

  const safeSourceUrl = getSafeExternalUrl(form.sourceUrl)
  const safePreviewBaseUrl =
    getSafeExternalUrl(scrapedFinalUrl) ?? safeSourceUrl
  const previewHtml = scrapedHtml
    ? `${safePreviewBaseUrl ? `<base href="${escapeHtmlAttribute(safePreviewBaseUrl)}">\n` : ''}${scrapedHtml}`
    : ''

  const scrapeInput = (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Product URL
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2 className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
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
              {isScraping && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isScraping ? 'Scraping' : 'Scrape'}
            </Button>
          </div>
        </div>

        {scrapeError && (
          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{scrapeError}</span>
            </div>
            {isBotProtectionError(scrapeError) && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={startInteractiveScrape}
                disabled={interactiveStatus === 'starting'}
              >
                {interactiveStatus === 'starting' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Monitor className="h-3.5 w-3.5" />
                )}
                Try interactive browser
              </Button>
            )}
          </div>
        )}

        {(interactiveStatus === 'waiting' ||
          interactiveStatus === 'scraping') && (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-2">
            <div className="flex items-start gap-2 text-xs">
              <Monitor className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="space-y-1">
                <p>
                  A browser window has opened. Complete the retailer&apos;s
                  verification, then click <strong>Continue</strong> to scrape
                  the page.
                </p>
                {interactiveIsChallenge === true && (
                  <p className="text-amber-600 dark:text-amber-400">
                    Challenge page still detected.
                  </p>
                )}
                {interactiveIsChallenge === false && (
                  <p className="text-emerald-600 dark:text-emerald-400">
                    Product page detected.
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1"
                onClick={captureInteractiveScrape}
                disabled={interactiveStatus === 'scraping'}
              >
                {interactiveStatus === 'scraping' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Continue
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={cancelInteractiveScrape}
                disabled={interactiveStatus === 'scraping'}
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
            </div>
          </div>
        )}

        {interactiveError && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{interactiveError}</span>
          </div>
        )}

        {!hasScraped &&
          !scrapeError &&
          !isScraping &&
          interactiveStatus === null && (
            <p className="text-xs text-muted-foreground">
              Paste a knife product page URL and hit Scrape. The app will pull
              the title, brand, images, and specs when available. You can edit
              everything before saving.
            </p>
          )}
      </CardContent>
    </Card>
  )

  return (
    <div
      className={`flex flex-col w-full max-w-7xl mx-auto p-6 lg:p-8 ${
        hasScraped ? 'min-h-0 flex-1' : ''
      }`}
    >
      <PageHeader
        title="Add Knife"
        description="Scrape a product page or enter details manually."
        breadcrumbs={[{ label: 'Add' }]}
        actions={
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
        }
      />

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          setActiveTab(value as Tab)
          setScrapeError(null)
          setSaveError(null)
        }}
        className={`flex flex-col gap-6 ${hasScraped ? 'flex-1 min-h-0' : ''}`}
      >
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {tab}
            </TabsTrigger>
          ))}
        </TabsList>

        {activeTab === 'Scrape URL' && scrapeInput}

        {hasScraped ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 flex-1 min-h-0">
            <div className="flex flex-col min-h-0 overflow-y-auto space-y-4 pr-1">
              <KnifeFormFields
                form={seededForm}
                updateField={updateField}
                customFieldDefinitions={customFields}
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
                  >
                    {showPreview ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  {safeSourceUrl ? (
                    <a
                      href={safeSourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Open
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
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
                    <span className="text-xs">Preview hidden</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          activeTab === 'Manual' && (
            <KnifeFormFields
              form={seededForm}
              updateField={updateField}
              customFieldDefinitions={customFields}
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
          )
        )}
      </Tabs>

      {saveError && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={handleCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave || isSaving}>
          {isSaving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {isSaving ? 'Saving' : 'Save Item'}
        </Button>
      </div>
    </div>
  )
}
