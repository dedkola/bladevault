/**
 * Features that need the BladeVault server (price monitoring, scraping,
 * backups) are missing in the static web app, which answers its API calls
 * in the browser. The static app marks itself before its first render.
 */
let staticBrowserApp = false

export function markStaticBrowserApp(): void {
  staticBrowserApp = true
}

export function hasServerRuntime(): boolean {
  return !staticBrowserApp
}
