export type WebpageScreenshot = {
  path: string
  sourceUrl: string
  capturedAt: string
  width: number
  height: number
}

export function isWebpageScreenshot(path: string): boolean {
  return /(?:^|\/)webpage-[0-9a-f-]{36}\.png$/.test(path)
}

export function screenshotsLast(images: string[]): string[] {
  return [
    ...images.filter((image) => !isWebpageScreenshot(image)),
    ...images.filter(isWebpageScreenshot),
  ]
}

export type ScreenshotBackfillItem = {
  id: string
  name: string
  status: 'pending' | 'running' | 'failed' | 'completed' | 'skipped'
  error: string | null
}

export function isScreenshotDraft(src: string): boolean {
  return /^__webpage_drafts\/webpage-[0-9a-f-]{36}\.png$/.test(src)
}
