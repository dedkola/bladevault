const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const target = path.join(root, 'static-app')
fs.cpSync(path.join(root, 'public'), path.join(target, 'public'), {
  recursive: true,
})
for (const icon of ['icon.svg', 'favicon.ico', 'apple-icon.png']) {
  fs.copyFileSync(
    path.join(root, 'app', icon),
    path.join(target, 'public', icon),
  )
}
fs.writeFileSync(
  path.join(target, 'public', '_headers'),
  '/*\n  X-Robots-Tag: noindex\n\n/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n',
)
const build = spawnSync(
  process.execPath,
  [require.resolve('next/dist/bin/next'), 'build', target, '--webpack'],
  { cwd: root, stdio: 'inherit' },
)
if (build.error) throw build.error
process.exit(build.status ?? 1)
