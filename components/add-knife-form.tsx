'use client'

import { screenshotsLast } from '@/lib/webpage-screenshot-shared'

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  Loader2,
  Link2,
  AlertCircle,
  Check,
  ChevronRight,
  ClipboardPaste,
  ExternalLink,
  Eye,
  FileUp,
  Globe,
  EyeOff,
  Layers,
  Monitor,
  PenLine,
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
import { readJsonResponse } from '@/lib/api-response'
import { ScrapeError } from '@/lib/scrape-errors'
import { requestScrape } from '@/lib/scrape-request'
import {
  MAX_SAVED_PAGE_FILE_BYTES,
  SAVED_PAGE_ACCEPT,
  parseSavedPage,
} from '@/lib/saved-page'
import { BatchScrapeDialog } from '@/components/batch-scrape-dialog'
import { ResizablePreviewLayout } from '@/components/resizable-preview-layout'
import { escapeHtmlAttribute, getSafeExternalUrl } from '@/lib/external-url'
import { ScrapedProduct } from '@/lib/scrape'
import { CustomField } from '@/lib/settings-shared'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'
import {
  cleanScrapePreview,
  replaceScrapePreviewEmbeds,
} from '@/lib/scrape-popup-cleanup'

function hasKnifeFormContent(form: KnifeFormData): boolean {
  return Object.values(form).some((value) => {
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    return Object.values(value).some((entry) => entry.trim().length > 0)
  })
}

const subscribeToNothing = () => () => {}
const getHasDesktopBrowser = () =>
  Boolean(window.bladevaultDesktop?.scrapeBrowser)
const getServerHasDesktopBrowser = () => false
const getCanPaste = () => Boolean(navigator.clipboard?.readText)

export function AddKnifeForm() {
  const router = useRouter()
  const formId = useId()
  const previewToggleRef = useRef<HTMLButtonElement>(null)
  const savedPageInputRef = useRef<HTMLInputElement>(null)
  const editedFieldsRef = useRef(new Set<keyof KnifeFormData>())
  const { addKnife } = useKnives()
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [isManual, setIsManual] = useState(false)
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
  const [hidePreviewPopups, setHidePreviewPopups] = useState(false)
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set())
  const [isSaving, setIsSaving] = useState(false)
  const [interactiveSessionId, setInteractiveSessionId] = useState<
    string | null
  >(null)
  const interactiveSessionIdRef = useRef<string | null>(null)
  const scrapeRequestRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const [interactiveStatus, setInteractiveStatus] = useState<
    'starting' | 'waiting' | 'scraping' | 'browser' | null
  >(null)
  const desktopBrowserOpenRef = useRef(false)
  const hasDesktopBrowser = useSyncExternalStore(
    subscribeToNothing,
    getHasDesktopBrowser,
    getServerHasDesktopBrowser,
  )
  const canPaste = useSyncExternalStore(
    subscribeToNothing,
    getCanPaste,
    getServerHasDesktopBrowser,
  )
  const [interactiveIsChallenge, setInteractiveIsChallenge] = useState<
    boolean | null
  >(null)
  const [interactiveError, setInteractiveError] = useState<string | null>(null)
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [isBatchOpen, setIsBatchOpen] = useState(false)

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
    editedFieldsRef.current.add(field)
    setForm((prev) => ({
      ...prev,
      [field]: field === 'images' ? screenshotsLast(value as string[]) : value,
    }))
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

    editedFieldsRef.current.add('images')
    setForm((prev) => ({
      ...prev,
      images: screenshotsLast([
        ...prev.images,
        ...dataUrls.filter((dataUrl) => !prev.images.includes(dataUrl)),
      ]),
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
    editedFieldsRef.current.add('images')
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
    editedFieldsRef.current.add('images')
    setSelectedImages(new Set(form.images))
  }

  const deselectAllImages = () => {
    editedFieldsRef.current.add('images')
    setSelectedImages(new Set())
  }

  const handleSave = async () => {
    if (!form.name.trim() || isScraping || interactiveStatus !== null) return
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
    preserveEdits = false,
  ) => {
    const importedFields: Partial<KnifeFormData> = {
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
    }
    const fields = preserveEdits
      ? Object.fromEntries(
          Object.entries(importedFields).filter(
            ([field]) =>
              !editedFieldsRef.current.has(field as keyof KnifeFormData),
          ),
        )
      : importedFields
    setForm((prev) => ({ ...prev, ...fields }))
    if (!preserveEdits || !editedFieldsRef.current.has('images')) {
      setSelectedImages(
        new Set(Array.isArray(product.images) ? product.images : []),
      )
    }
    if (!preserveEdits) editedFieldsRef.current.clear()
    setScrapedHtml(html)
    setScrapedFinalUrl(finalUrl)
    setHasScraped(true)
    setShowPreview(true)
    setHidePreviewPopups(false)
  }

  const [screenshotWarning, setScreenshotWarning] = useState('')
  const [scrapeWarnings, setScrapeWarnings] = useState<string[]>([])

  const handleScrape = async () => {
    if (!url.trim() || scrapeRequestRef.current || interactiveStatus !== null)
      return
    const controller = new AbortController()
    scrapeRequestRef.current = controller
    setIsScraping(true)
    setScreenshotWarning('')
    setScrapeWarnings([])
    setScrapeError(null)
    setInteractiveError(null)
    setHasScraped(false)
    setScrapedHtml('')
    setScrapedFinalUrl('')

    try {
      const data = await requestScrape<{
        product: ScrapedProduct
        html?: string
        screenshotWarning?: string
        warnings?: string[]
        finalUrl?: string
      }>('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
        signal: controller.signal,
      })
      if (!mountedRef.current || scrapeRequestRef.current !== controller) return
      if (
        !data.product ||
        typeof data.product !== 'object' ||
        Array.isArray(data.product) ||
        typeof data.product.name !== 'string'
      ) {
        throw new ScrapeError('invalid_response')
      }

      setScreenshotWarning(data.screenshotWarning || '')
      setScrapeWarnings(data.warnings || [])
      applyScrapedProduct(
        data.product,
        typeof data.html === 'string' ? data.html : '',
        typeof data.finalUrl === 'string' ? data.finalUrl : url.trim(),
      )
    } catch (error) {
      if (!mountedRef.current || scrapeRequestRef.current !== controller) return
      setScrapeError(
        error instanceof Error ? error.message : 'Something went wrong',
      )
    } finally {
      if (scrapeRequestRef.current === controller) {
        scrapeRequestRef.current = null
        if (mountedRef.current) setIsScraping(false)
      }
    }
  }

  const importPage = async (
    loadPage: () => Promise<{
      html: string
      url: string
      savedUrl?: string
      source?: 'browser'
    }>,
    resolveImages?: (urls: string[]) => Promise<(string | null)[]>,
  ) => {
    const controller = new AbortController()
    scrapeRequestRef.current = controller
    setIsScraping(true)
    setScreenshotWarning('')
    setScrapeWarnings([])
    setScrapeError(null)
    setInteractiveError(null)

    try {
      const page = await loadPage()
      const data = await requestScrape<{
        product: ScrapedProduct
        html?: string
        warnings?: string[]
        finalUrl?: string
      }>('/api/scrape/saved-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: page.html,
          url: page.url,
          savedUrl: page.savedUrl ?? '',
          ...(page.source ? { source: page.source } : {}),
        }),
        signal: controller.signal,
      })
      if (!mountedRef.current || scrapeRequestRef.current !== controller) return
      if (
        !data.product ||
        typeof data.product !== 'object' ||
        Array.isArray(data.product) ||
        typeof data.product.name !== 'string'
      ) {
        throw new ScrapeError('invalid_response')
      }
      const product = data.product
      if (resolveImages && Array.isArray(product.images)) {
        // Download images with the same cookies that passed the site's bot
        // check; keep the original address when a download fails.
        const downloaded = await resolveImages(product.images).catch(() => [])
        if (!mountedRef.current || scrapeRequestRef.current !== controller)
          return
        product.images = product.images.map((src, index) => {
          const dataUrl = downloaded[index]
          return typeof dataUrl === 'string' &&
            dataUrl.startsWith('data:image/')
            ? dataUrl
            : src
        })
      }
      const finalUrl =
        typeof data.finalUrl === 'string' ? data.finalUrl : url.trim()
      if (!url.trim() && finalUrl) setUrl(finalUrl)
      setScrapeWarnings(data.warnings || [])
      applyScrapedProduct(
        product,
        typeof data.html === 'string' ? data.html : '',
        finalUrl,
      )
    } catch (error) {
      if (!mountedRef.current || scrapeRequestRef.current !== controller) return
      setScrapeError(
        error instanceof Error ? error.message : 'Something went wrong',
      )
    } finally {
      if (scrapeRequestRef.current === controller) {
        scrapeRequestRef.current = null
        if (mountedRef.current) setIsScraping(false)
      }
    }
  }

  const importSavedPage = async (file: File) => {
    if (scrapeRequestRef.current || interactiveStatus !== null) return
    await importPage(async () => {
      if (file.size > MAX_SAVED_PAGE_FILE_BYTES)
        throw new Error(
          'This saved page is too large to import. Save only the product page and try again.',
        )
      const page = parseSavedPage(file.name, await file.text())
      return { html: page.html, url: url.trim(), savedUrl: page.url ?? '' }
    })
  }

  const openDesktopBrowser = async () => {
    const desktopBrowser = window.bladevaultDesktop?.scrapeBrowser
    if (
      !desktopBrowser ||
      !url.trim() ||
      scrapeRequestRef.current ||
      interactiveStatus !== null
    )
      return
    desktopBrowserOpenRef.current = true
    setInteractiveStatus('browser')
    setInteractiveError(null)
    setScrapeError(null)

    let result: Awaited<ReturnType<typeof desktopBrowser.open>>
    try {
      result = await desktopBrowser.open(url.trim())
    } catch (error) {
      if (mountedRef.current)
        setInteractiveError(
          error instanceof Error
            ? error.message.replace(
                /^Error invoking remote method '[^']+': (Error: )?/,
                '',
              )
            : 'The BladeVault browser could not be opened.',
        )
      return
    } finally {
      desktopBrowserOpenRef.current = false
      if (mountedRef.current) setInteractiveStatus(null)
    }
    if (!mountedRef.current || result.status !== 'captured') return
    const captured = result
    await importPage(
      async () => ({
        html: captured.html,
        url: captured.url,
        source: 'browser',
      }),
      (urls) => desktopBrowser.fetchImages(urls),
    )
  }

  const resetInteractiveState = () => {
    interactiveSessionIdRef.current = null
    setInteractiveSessionId(null)
    setInteractiveStatus(null)
    setInteractiveIsChallenge(null)
    setInteractiveError(null)
  }

  const startInteractiveScrape = async () => {
    if (!url.trim() || scrapeRequestRef.current || interactiveStatus !== null)
      return
    const controller = new AbortController()
    scrapeRequestRef.current = controller
    setInteractiveStatus('starting')
    setInteractiveError(null)
    setScrapeError(null)

    try {
      const data = await requestScrape<{ sessionId?: string }>(
        '/api/scrape/interactive/start',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url.trim() }),
          signal: controller.signal,
        },
      )
      if (!mountedRef.current || scrapeRequestRef.current !== controller) return

      if (typeof data.sessionId !== 'string') {
        throw new Error('Invalid response from interactive scrape start')
      }

      interactiveSessionIdRef.current = data.sessionId
      setInteractiveSessionId(data.sessionId)
      setInteractiveStatus('waiting')
    } catch (error) {
      if (!mountedRef.current || scrapeRequestRef.current !== controller) return
      setInteractiveError(
        error instanceof Error ? error.message : 'Something went wrong',
      )
      setInteractiveStatus(null)
    } finally {
      if (scrapeRequestRef.current === controller)
        scrapeRequestRef.current = null
    }
  }

  const captureInteractiveScrape = async () => {
    if (!interactiveSessionId || scrapeRequestRef.current) return
    const controller = new AbortController()
    scrapeRequestRef.current = controller
    setInteractiveStatus('scraping')
    setInteractiveError(null)

    try {
      const data = await requestScrape<{
        product: ScrapedProduct
        html?: string
        screenshotWarning?: string
        warnings?: string[]
        finalUrl?: string
      }>(`/api/scrape/interactive/${interactiveSessionId}/scrape`, {
        method: 'POST',
        signal: controller.signal,
      })
      if (!mountedRef.current || scrapeRequestRef.current !== controller) return
      if (
        !data.product ||
        typeof data.product !== 'object' ||
        Array.isArray(data.product) ||
        typeof data.product.name !== 'string'
      ) {
        throw new ScrapeError('invalid_response')
      }

      setScreenshotWarning(data.screenshotWarning || '')
      setScrapeWarnings(data.warnings || [])
      applyScrapedProduct(
        data.product,
        typeof data.html === 'string' ? data.html : '',
        typeof data.finalUrl === 'string' ? data.finalUrl : url.trim(),
        true,
      )
      resetInteractiveState()
    } catch (error) {
      if (!mountedRef.current || scrapeRequestRef.current !== controller) return
      if (error instanceof ScrapeError && error.code === 'challenge') {
        setInteractiveStatus('waiting')
        setInteractiveIsChallenge(true)
      } else {
        resetInteractiveState()
        void requestScrape(
          `/api/scrape/interactive/${interactiveSessionId}/cancel`,
          { method: 'POST' },
          { timeoutMs: 10000 },
        ).catch(() => {})
      }
      setInteractiveError(
        error instanceof Error ? error.message : 'Something went wrong',
      )
    } finally {
      if (scrapeRequestRef.current === controller)
        scrapeRequestRef.current = null
    }
  }

  const cancelInteractiveScrape = () => {
    const sessionId = interactiveSessionIdRef.current
    scrapeRequestRef.current?.abort()
    scrapeRequestRef.current = null
    resetInteractiveState()
    if (sessionId) {
      void requestScrape(
        `/api/scrape/interactive/${sessionId}/cancel`,
        { method: 'POST' },
        { timeoutMs: 10000 },
      ).catch(() => {
        if (mountedRef.current && !interactiveSessionIdRef.current) {
          setInteractiveError(
            'The import was cancelled, but the browser could not be closed. Close its window if it is still open.',
          )
        }
      })
    }
  }

  useEffect(() => {
    if (!interactiveSessionId || interactiveStatus !== 'waiting') return

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const currentSessionId = interactiveSessionId
    const checkStatus = async () => {
      try {
        const data = await requestScrape<{
          status?: string
          error?: string
          isSecurityChallenge?: boolean
        }>(
          `/api/scrape/interactive/${currentSessionId}/status`,
          { signal: controller.signal },
          { timeoutMs: 10000 },
        )
        if (controller.signal.aborted) return
        if (data.status !== 'waiting' && data.status !== 'scraping') {
          throw new Error(
            data.error ||
              'The interactive browser session has ended. Choose Interact with page to open it again.',
          )
        }
        setInteractiveIsChallenge(data.isSecurityChallenge ?? null)
        timer = setTimeout(checkStatus, 2500)
      } catch (error) {
        if (controller.signal.aborted) return
        interactiveSessionIdRef.current = null
        setInteractiveSessionId(null)
        setInteractiveStatus(null)
        setInteractiveIsChallenge(null)
        setInteractiveError(
          error instanceof Error
            ? error.message
            : 'Unable to check the browser session.',
        )
        void requestScrape(
          `/api/scrape/interactive/${currentSessionId}/cancel`,
          { method: 'POST' },
          { timeoutMs: 10000 },
        ).catch(() => {})
      }
    }

    checkStatus()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [interactiveSessionId, interactiveStatus])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      scrapeRequestRef.current?.abort()
      scrapeRequestRef.current = null
      if (desktopBrowserOpenRef.current) {
        desktopBrowserOpenRef.current = false
        void window.bladevaultDesktop?.scrapeBrowser?.cancel().catch(() => {})
      }
      const sessionId = interactiveSessionIdRef.current
      interactiveSessionIdRef.current = null
      if (sessionId) {
        void requestScrape(
          `/api/scrape/interactive/${sessionId}/cancel`,
          { method: 'POST', keepalive: true },
          { timeoutMs: 10000 },
        ).catch(() => {})
      }
    }
  }, [])

  const canSave = form.name.trim().length > 0

  const safeSourceUrl = getSafeExternalUrl(form.sourceUrl)
  const safePreviewBaseUrl =
    getSafeExternalUrl(scrapedFinalUrl) ?? safeSourceUrl
  const preview = useMemo(() => {
    if (!scrapedHtml) return { html: scrapedHtml, removed: 0 }
    const cleaned = hidePreviewPopups
      ? cleanScrapePreview(scrapedHtml)
      : { html: scrapedHtml, removed: 0 }
    return { ...cleaned, html: replaceScrapePreviewEmbeds(cleaned.html) }
  }, [hidePreviewPopups, scrapedHtml])
  const previewHtml = preview.html
    ? `${safePreviewBaseUrl ? `<base href="${escapeHtmlAttribute(safePreviewBaseUrl)}">\n` : ''}${preview.html}`
    : ''
  const isPreviewVisible = Boolean(previewHtml) && showPreview
  const togglePreview = (visible: boolean) => {
    setShowPreview(visible)
    requestAnimationFrame(() =>
      previewToggleRef.current?.focus({ preventScroll: true }),
    )
  }

  const isBusy = isScraping || interactiveStatus !== null
  // Keep the form on screen once it holds anything, so a failed re-scrape
  // never hides details that are already filled in.
  const showForm = hasScraped || isManual || hasKnifeFormContent(form)

  const pasteUrl = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (text) setUrl(text)
    } catch {
      // Clipboard access was refused; the field is still there to paste into.
    }
    urlInputRef.current?.focus()
  }

  const interactActions = (
    <>
      <Button
        variant={scrapeError ? 'outline' : 'link'}
        size="sm"
        className={scrapeError ? undefined : 'h-auto px-0'}
        onClick={startInteractiveScrape}
        disabled={isBusy || !url.trim()}
      >
        {interactiveStatus === 'starting' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Monitor className="h-3.5 w-3.5" />
        )}
        Interact with page
      </Button>
      {hasDesktopBrowser && (
        <Button
          variant={scrapeError ? 'outline' : 'link'}
          size="sm"
          className={scrapeError ? undefined : 'h-auto px-0'}
          onClick={openDesktopBrowser}
          disabled={isBusy || !url.trim()}
          title="Open the page in a browser window inside BladeVault. Use it when a site's security check keeps repeating."
        >
          <Globe className="h-3.5 w-3.5" />
          Open in BladeVault browser
        </Button>
      )}
    </>
  )

  const otherWays = [
    {
      id: 'batch',
      icon: Layers,
      title: 'Batch scrape',
      description: 'Paste a list of product links and add them in one run',
    },
    {
      id: 'saved-page',
      icon: FileUp,
      title: 'Import saved page',
      description:
        'Use a product page you saved from your browser (File → Save Page As)',
    },
    {
      id: 'manual',
      icon: PenLine,
      title: 'Enter manually',
      description: 'Type the details yourself, no link needed',
    },
  ] as const

  const chooseOtherWay = (id: (typeof otherWays)[number]['id']) => {
    if (id === 'batch') setIsBatchOpen(true)
    else if (id === 'saved-page') savedPageInputRef.current?.click()
    else {
      setIsManual(true)
      setScrapeError(null)
      setSaveError(null)
    }
  }

  const scrapeInput = (
    <div
      className={cn(
        'w-full space-y-3',
        !showForm && 'mx-auto max-w-2xl pt-2 md:pt-[5vh]',
      )}
    >
      {!showForm && (
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Paste a product link
          </h2>
          <p className="text-sm text-muted-foreground">
            BladeVault fills in the title, brand, images, and specs when
            available. You can edit everything before saving.
          </p>
        </div>
      )}
      <label htmlFor={`${formId}-product-url`} className="sr-only">
        Product URL
      </label>
      <div
        className={cn(
          'flex items-center gap-2 rounded-xl border border-input bg-card py-1.5 pr-1.5 pl-3.5 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
          !showForm && 'shadow-sm',
        )}
      >
        <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={urlInputRef}
          id={`${formId}-product-url`}
          type="url"
          value={url}
          disabled={isBusy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleScrape()}
          placeholder="https://retailer.com/..."
          className="h-9 min-w-0 flex-1 border-0 bg-transparent text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        />
        {canPaste && !url && !isBusy && (
          <Button
            variant="ghost"
            onClick={pasteUrl}
            aria-label="Paste link"
            className="text-muted-foreground"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Paste</span>
          </Button>
        )}
        <Button
          size="lg"
          className="px-4"
          onClick={handleScrape}
          disabled={isBusy || !url.trim()}
        >
          {isScraping && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isScraping ? 'Scraping' : 'Scrape'}
        </Button>
      </div>
      <input
        ref={savedPageInputRef}
        type="file"
        accept={SAVED_PAGE_ACCEPT}
        className="hidden"
        aria-label="Saved product page file"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void importSavedPage(file)
        }}
      />
      {!scrapeError && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs xl:text-sm text-muted-foreground">
          <span>Popup, sign-in, or security check in the way?</span>
          {interactActions}
        </div>
      )}

      {scrapeWarnings.length > 0 && (
        <div
          role="status"
          className="space-y-1 text-sm text-amber-700 dark:text-amber-400"
        >
          {scrapeWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
      {screenshotWarning && (
        <p
          role="status"
          className="text-sm xl:text-base text-amber-700 dark:text-amber-400"
        >
          Webpage screenshot unavailable: {screenshotWarning}
        </p>
      )}
      {scrapeError && (
        <div className="space-y-2">
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs xl:text-sm text-destructive"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{scrapeError}</span>
          </div>
          <div className="flex flex-wrap gap-2">{interactActions}</div>
        </div>
      )}

      {(interactiveStatus === 'waiting' ||
        interactiveStatus === 'scraping') && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-2">
          <div className="flex items-start gap-2 text-xs xl:text-sm">
            <Monitor className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
            <div className="space-y-1">
              <p>
                A browser window has opened on the computer running BladeVault.
                Close popups or complete verification, then click{' '}
                <strong>Continue</strong> to import the page. Your manual field
                edits will be kept.
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
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      {interactiveStatus === 'browser' && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-2">
          <div className="flex items-start gap-2 text-xs xl:text-sm">
            <Globe className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
            <p>
              The BladeVault browser is open. Complete any security check, wait
              for the product page to load, then click <strong>Continue</strong>{' '}
              in its toolbar or here. Sign-ins and passed checks are remembered
              for next time.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              onClick={() =>
                void window.bladevaultDesktop?.scrapeBrowser
                  ?.capture()
                  .catch(() => {})
              }
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Continue
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.bladevaultDesktop?.scrapeBrowser
                  ?.cancel()
                  .catch(() => {})
              }
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      )}

      {interactiveError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs xl:text-sm text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{interactiveError}</span>
        </div>
      )}

      {!showForm && (
        <ul className="mt-7 divide-y divide-border border-y border-border">
          {otherWays.map(({ id, icon: Icon, title, description }) => (
            <li key={id}>
              <button
                type="button"
                aria-label={title}
                aria-describedby={`${formId}-${id}-hint`}
                onClick={() => chooseOtherWay(id)}
                disabled={isBusy}
                className="flex w-full items-center gap-3 rounded-md px-1 py-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{title}</span>
                  <span
                    id={`${formId}-${id}-hint`}
                    className="block text-xs xl:text-sm text-muted-foreground"
                  >
                    {description}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <div
      className={`flex flex-col w-full p-6 lg:p-8 ${
        hasScraped ? 'min-h-0 flex-1' : ''
      }`}
    >
      <PageHeader
        title="Add knife"
        breadcrumbs={[{ label: 'Add' }]}
        actions={
          <>
            {previewHtml && !showPreview && (
              <Button
                variant="outline"
                size="sm"
                ref={previewToggleRef}
                onClick={() => togglePreview(true)}
              >
                <Eye className="h-3.5 w-3.5" />
                Show preview
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
          </>
        }
      />

      <div
        className={`flex flex-col gap-6 ${hasScraped ? 'flex-1 min-h-0' : ''}`}
      >
        {scrapeInput}

        {hasScraped ? (
          <ResizablePreviewLayout
            preview={
              isPreviewVisible && (
                <Card className="flex flex-col overflow-hidden h-full min-h-[32rem] lg:min-h-0">
                  <CardHeader className="border-b flex flex-row flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                      <CardTitle className="text-sm xl:text-base">
                        Scraped page preview
                      </CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        ref={previewToggleRef}
                        onClick={() => togglePreview(false)}
                        title="Hide preview"
                        aria-label="Hide preview"
                      >
                        <EyeOff className="h-3.5 w-3.5" />
                      </Button>
                      {safeSourceUrl ? (
                        <a
                          href={safeSourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[10px] xl:text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Open
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                    <div className="flex basis-full flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setHidePreviewPopups(true)}
                        disabled={hidePreviewPopups}
                      >
                        Hide popups
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setHidePreviewPopups(false)}
                        disabled={!hidePreviewPopups}
                      >
                        Restore original
                      </Button>
                      {hidePreviewPopups && (
                        <p
                          role="status"
                          className="text-xs text-muted-foreground"
                        >
                          {preview.removed > 0
                            ? `${preview.removed} popup${preview.removed === 1 ? '' : 's'} hidden in this preview.`
                            : 'No popups found. Try Interact with page for other overlays.'}
                        </p>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="relative flex-1 min-h-0 p-0">
                    <iframe
                      title="Scraped page preview"
                      srcDoc={previewHtml}
                      sandbox=""
                      className="absolute inset-0 w-full h-full border-0 bg-white"
                    />
                  </CardContent>
                </Card>
              )
            }
          >
            <KnifeFormFields
              wideLayout={!isPreviewVisible}
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
          </ResizablePreviewLayout>
        ) : (
          showForm && (
            <KnifeFormFields
              wideLayout
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
      </div>

      {saveError && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs xl:text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{saveError}</span>
        </div>
      )}

      {showForm && (
        <div className="mt-6 flex items-center justify-end gap-2 xl:sticky xl:bottom-0 xl:z-10 xl:border-t xl:border-[var(--bladevault-line)] xl:bg-background/95 xl:py-3 xl:backdrop-blur-sm">
          <p className="mr-auto hidden text-xs text-muted-foreground sm:block">
            Nothing is saved until you press Save Item.
          </p>
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={
              !canSave || isSaving || isScraping || interactiveStatus !== null
            }
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {isSaving ? 'Saving' : 'Save Item'}
          </Button>
        </div>
      )}

      <BatchScrapeDialog open={isBatchOpen} onOpenChange={setIsBatchOpen} />
    </div>
  )
}
