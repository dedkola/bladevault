import type { NextConfig } from 'next'
import path from 'node:path'

const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  webpack(config) {
    // Only this static target uses browser navigation. The main app retains
    // Next's server routing, database, proxy, and desktop build unchanged.
    config.resolve.alias['next/navigation$'] = path.join(
      __dirname,
      'navigation.tsx',
    )
    config.resolve.alias['next/link$'] = path.join(__dirname, 'link.tsx')
    return config
  },
}

export default config
