import type { BrowserContext } from 'playwright'

export async function installScrapeBrowserInitScript(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        {
          name: 'Chrome PDF Viewer',
          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
        },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    })
    const w = window as unknown as Record<string, unknown>
    w.chrome = (w.chrome as Record<string, unknown>) || { runtime: {} }
    delete w.__playwright
    delete w.__pw_manual
  })
}
