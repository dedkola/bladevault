const path = require('path')
const { readReleaseHighlights } = require('./scripts/release-highlights.cjs')

const isMacHost = process.platform === 'darwin'
const isMacSigningEnabled = process.env.BLADEVAULT_MAC_SIGN === '1'
const isMacNotarizeEnabled = process.env.BLADEVAULT_MAC_NOTARIZE === '1'
const isUnsignedMacBuild = isMacHost && !isMacSigningEnabled
const dmgLaunchTextPath = path.join(__dirname, 'build', 'First Launch.txt')
const dmgWindow = {
  width: 920,
  height: 720,
}
const dmgContents = [
  {
    x: 241,
    y: 394,
    type: 'file',
  },
  {
    x: 679,
    y: 394,
    type: 'link',
    path: '/Applications',
  },
  {
    x: 717,
    y: 601,
    type: 'file',
    path: dmgLaunchTextPath,
  },
]

// Release CI provides the Sentry DSNs. Builds without them (local, forks)
// ship no DSN, so the desktop error reporting option stays unavailable.
const sentryDesktopDsn = process.env.SENTRY_DESKTOP_DSN?.trim()
const sentryAppDsn = process.env.SENTRY_APP_DSN?.trim()
const errorReportingMetadata =
  sentryDesktopDsn && sentryAppDsn
    ? {
        bladevaultErrorReporting: {
          desktopDsn: sentryDesktopDsn,
          appDsn: sentryAppDsn,
        },
      }
    : undefined

// The short "What's new" list shown after an update, from the commit titles
// since the previous tag. Shallow clones ship none, and the dialog is skipped.
const releaseHighlights = readReleaseHighlights(__dirname)

const extraMetadata =
  errorReportingMetadata || releaseHighlights
    ? {
        ...errorReportingMetadata,
        ...(releaseHighlights
          ? { bladevaultWhatsNew: releaseHighlights }
          : undefined),
      }
    : undefined

const config = {
  appId: 'com.bladevault.desktop',
  extraMetadata,
  productName: 'BladeVault',
  asar: true,
  asarUnpack: [
    '.next/standalone/**/*',
    'node_modules/**/*.node',
    'node_modules/better-sqlite3/**/*',
  ],
  directories: {
    output: 'dist/desktop',
    buildResources: 'build',
  },
  // The deb and AppImage install icons into the system theme; this copy is the
  // window icon Linux shells read from the process.
  extraResources: [
    {
      from: path.join('build', 'icons', '256x256.png'),
      to: 'icon.png',
    },
  ],
  files: ['package.json', 'electron/**/*', '.next/standalone/**/*'],
  publish: {
    provider: 'github',
    owner: 'dedkola',
    repo: 'bladevault',
    releaseType: 'release',
  },
  mac: {
    category: 'public.app-category.utilities',
    minimumSystemVersion: '13.0',
    target: ['dmg', 'zip'],
    artifactName: 'BladeVault.${ext}',
    identity: isUnsignedMacBuild ? null : undefined,
    hardenedRuntime: isMacSigningEnabled,
    gatekeeperAssess: false,
    entitlements: path.join('build', 'entitlements.mac.plist'),
    entitlementsInherit: path.join('build', 'entitlements.mac.inherit.plist'),
  },
  dmg: {
    background: 'background.png',
    window: {
      width: dmgWindow.width,
      height: dmgWindow.height,
    },
    contents: dmgContents,
    iconSize: 108,
    iconTextSize: 15,
    title: '${productName} ${version}',
  },
  afterSign:
    isMacSigningEnabled && isMacNotarizeEnabled
      ? path.join(__dirname, 'scripts', 'notarize-macos.cjs')
      : undefined,
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
  },
  nsis: {
    // Keep the installer process name different from BladeVault.exe. The NSIS
    // app-closing macro treats a matching filename as its own app process and
    // skips the shutdown check, leaving the installed files locked on upgrade.
    artifactName: 'BladeVault-Setup.${ext}',
    include: 'installer.nsh',
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    target: [
      {
        target: 'AppImage',
        arch: ['x64'],
      },
      {
        target: 'deb',
        arch: ['x64'],
      },
    ],
    category: 'Utility',
    // A directory of sizes, so the deb installs into hicolor 16x16 through
    // 512x512. A single 1024x1024 file is not listed in Ubuntu's hicolor theme
    // index, which leaves the shell falling back to a generic icon.
    icon: 'build/icons',
    artifactName: 'BladeVault.${ext}',
    // Electron derives WM_CLASS from the packaged package.json name, which
    // electron-builder rewrites to "bladevault" (productName is not included),
    // so the shell needs that value to match the window to this entry.
    desktop: {
      entry: {
        StartupWMClass: 'bladevault',
      },
    },
    maintainer: 'BladeVault <dedkola@users.noreply.github.com>',
    synopsis: 'A sharp, local-first knife collection manager',
  },
}

module.exports = config
