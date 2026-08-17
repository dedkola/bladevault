import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },

  images: {
    // The desktop server runs from the installed application directory. Keep
    // Next's image optimizer in memory so runtime cache files never make that
    // directory mutable or create Windows paths too long for NSIS upgrades.
    maximumDiskCacheSize: 0,
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
  allowedDevOrigins: ['192.168.0.155'],
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
