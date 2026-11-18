import { NextResponse } from 'next/server'
import { requireAppUnlock } from '@/lib/app-lock'
import { extractOfferWithAi } from '@/lib/price-monitor/ai'
import { NO_STORE, priceAiErrorResponse } from '@/lib/price-monitor/ai-route'
import { readPriceAiKey } from '@/lib/price-monitor/secrets'
import { getSettings } from '@/lib/settings'
import { normalizeAiModel } from '@/lib/settings-shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A made-up product page; nothing from the vault is sent. */
const SAMPLE_PAGE = `<!doctype html><html><head><title>Sample folding knife</title></head>
<body><h1>Sample folding knife</h1>
<div class="product-info"><span class="price price--compare">$149.00</span>
<span class="price price--sale">$123.45</span></div>
<p class="stock-status">In stock, ships today</p></body></html>`
const EXPECTED_AMOUNT = 123.45

/**
 * Test connection: one tiny extraction request with the saved base URL,
 * the stored key and the saved model (or `{ model }` to try another).
 */
export async function POST(request: Request) {
  const locked = requireAppUnlock(request)
  if (locked) return locked
  const body = (await request.json().catch(() => null)) as {
    model?: unknown
  } | null
  try {
    const settings = getSettings().priceMonitoring.ai
    const model =
      body?.model === undefined
        ? settings.model
        : (normalizeAiModel(body.model) ?? '')
    if (!settings.baseUrl)
      return NextResponse.json(
        { error: 'Set the AI base URL first.' },
        { status: 400 },
      )
    if (!model)
      return NextResponse.json(
        { error: 'Choose a model first.' },
        { status: 400 },
      )
    const started = Date.now()
    const result = await extractOfferWithAi({
      html: SAMPLE_PAGE,
      endpoint: { baseUrl: settings.baseUrl, apiKey: await readPriceAiKey() },
      model,
      signal: request.signal,
    })
    const latencyMs = Date.now() - started
    if (result.status !== 'ok')
      return NextResponse.json(
        {
          ok: false,
          latencyMs,
          message:
            'The model answered, but not with the sample price. It may be too small for reading prices.',
        },
        { headers: NO_STORE },
      )
    const correct = result.offer.amount === EXPECTED_AMOUNT
    return NextResponse.json(
      {
        ok: correct,
        latencyMs,
        model,
        price: result.offer.amount,
        currency: result.offer.currency,
        message: correct
          ? `Connected: the model read ${result.offer.amount} ${result.offer.currency} from the sample page.`
          : `Connected, but the model read ${result.offer.amount} ${result.offer.currency} instead of the sale price ${EXPECTED_AMOUNT}.`,
      },
      { headers: NO_STORE },
    )
  } catch (error) {
    return priceAiErrorResponse(error, '/api/settings/price-ai-test')
  }
}
