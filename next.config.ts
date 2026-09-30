import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },

  images: {
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

export default nextConfig
