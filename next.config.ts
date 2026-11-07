import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs/config'
import pkg from './package.json'

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim()

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },

  images: {
    localPatterns: [
      { pathname: '/**', search: '' },
      // Restore changes the vault version even when an image reuses its path.
      { pathname: '/api/images/**' },
    ],
    // The desktop server runs from the installed application directory. Keep
    // its image cache disabled so runtime files never make that directory
    // mutable or create Windows paths too long for NSIS upgrades. Docker uses
    // a bounded cache mounted outside the application image.
    maximumDiskCacheSize: 0,
    ...(process.env.BLADEVAULT_DOCKER_RUNTIME === '1'
      ? { maximumDiskCacheSize: 500_000_000 }
      : {}),
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
  allowedDevOrigins: ['192.168.0.155'],
  outputFileTracingIncludes: {
    '/api/scrape': ['./node_modules/playwright-core/**/*'],
    '/api/knives/*/screenshot': ['./node_modules/playwright-core/**/*'],
    '/api/settings/webpage-screenshots': [
      './node_modules/playwright-core/**/*',
    ],
    '/api/scrape/interactive/*': ['./node_modules/playwright-core/**/*'],
  },
  serverExternalPackages: ['unzipper', 'yazl'],
  // Vercel supplies its own deployment adapter; standalone output is only
  // needed by BladeVault's self-hosted and desktop builds.
  output: process.env.VERCEL ? undefined : 'standalone',
  turbopack: {},
  webpack: (config, { dev }) => {
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/,
      }
    }
    return config
  },
}

// Source maps upload only from release CI, where SENTRY_AUTH_TOKEN is set.
// Local, fork, and test builds skip Sentry's source map handling entirely.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: sentryAuthToken,
  telemetry: false,
  silent: !process.env.CI,
  release: {
    name: process.env.SENTRY_RELEASE?.trim() || `bladevault@${pkg.version}`,
    create: Boolean(sentryAuthToken),
    finalize: Boolean(sentryAuthToken),
    setCommits: false,
  },
  sourcemaps: {
    disable: !sentryAuthToken,
    deleteSourcemapsAfterUpload: true,
  },
  // A failed upload must not block a release build.
  errorHandler: (error) => {
    console.warn(`[sentry] Source map upload failed: ${error.message}`)
  },
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeReplayIframe: true,
    excludeReplayShadowDom: true,
    excludeReplayWorker: true,
  },
  suppressOnRouterTransitionStartWarning: true,
})
