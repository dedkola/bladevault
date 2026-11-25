const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

async function build() {
  const root = path.resolve(__dirname, '..')
  const output = path.join(root, 'dist', 'mcp', 'bladevault.mjs')

  await esbuild.build({
    entryPoints: [path.join(root, 'cli', 'bladevault.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'bundle',
    external: ['better-sqlite3'],
    // Bundled CommonJS dependencies (the scraper's iconv-lite) call require()
    // for Node built-ins, which an ESM bundle only has through createRequire.
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __bladevaultCreateRequire } from 'node:module';",
        'const require = __bladevaultCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    sourcemap: true,
    tsconfig: path.join(root, 'tsconfig.json'),
  })
  fs.chmodSync(output, 0o755)

  const standalone = path.join(root, '.next', 'standalone')
  if (fs.existsSync(standalone)) {
    fs.copyFileSync(output, path.join(standalone, 'bladevault-mcp.mjs'))
    fs.copyFileSync(
      `${output}.map`,
      path.join(standalone, 'bladevault-mcp.mjs.map'),
    )
  }
}

build().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
