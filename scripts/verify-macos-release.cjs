const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function exec(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
  })

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()

  if (result.status !== 0) {
    const message = output || `${command} exited with status ${result.status}`
    throw new Error(message)
  }

  return output
}

function findMacApp() {
  const desktopRoot = path.join(process.cwd(), 'dist', 'desktop')

  if (!fs.existsSync(desktopRoot)) {
    throw new Error(
      'dist/desktop does not exist. Build a macOS desktop release first.',
    )
  }

  const platformDirs = fs
    .readdirSync(desktopRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => entry.name)

  for (const dirName of platformDirs) {
    const appPath = path.join(desktopRoot, dirName, 'BladeVault.app')
    if (fs.existsSync(appPath)) {
      return appPath
    }
  }

  throw new Error('Could not find BladeVault.app under dist/desktop/mac*/.')
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('Skipping macOS verification because this host is not macOS.')
    return
  }

  const appPath = findMacApp()
  const isSignedRelease = process.env.BLADEVAULT_MAC_SIGN === '1'

  console.log(`Inspecting ${appPath}`)
  console.log(exec('codesign', ['-dv', '--verbose=4', appPath]))

  if (!isSignedRelease) {
    console.log('')
    console.log('Unsigned tester build detected.')
    console.log(
      'Expected behavior: Gatekeeper will block direct first launch from a downloaded DMG.',
    )
    console.log(
      'Tester install flow: drag the app from the DMG into Applications, then open First Launch.txt from the DMG and run those Terminal commands.',
    )
    return
  }

  exec('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])
  console.log('codesign verification passed.')
  console.log(exec('spctl', ['-a', '-vv', appPath]))
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
