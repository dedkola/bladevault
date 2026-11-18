const { spawn } = require('child_process')
const os = require('os')
const path = require('path')

const electronBinary = require('electron')

const projectRoot = process.cwd()
const nextBin = path.join(
  projectRoot,
  'node_modules',
  'next',
  'dist',
  'bin',
  'next',
)
const dataDir = path.join(os.homedir(), '.bladevault-desktop-dev', 'data')
const devUrl = 'http://127.0.0.1:3000'
// Keep the dev app's MCP endpoint file apart from the installed app's.
const mcpDiscoveryFile = path.join(
  os.homedir(),
  '.bladevault-desktop-dev',
  'mcp-endpoint.json',
)

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForUrl(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (response.ok) {
        return
      }
    } catch {
      // The dev server is still compiling.
    }

    await delay(500)
  }

  throw new Error(`Timed out waiting for ${url}`)
}

function stopChild(child) {
  if (!child || child.killed) {
    return
  }

  child.kill()
}

async function main() {
  let electronProcess = null

  const nextProcess = spawn(process.execPath, [nextBin, 'dev'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      BLADEVAULT_DATA_DIR: dataDir,
      BLADEVAULT_DESKTOP_RUNTIME: '1',
      BLADEVAULT_MCP_DISCOVERY_FILE: mcpDiscoveryFile,
      PORT: new URL(devUrl).port,
    },
    stdio: 'inherit',
  })

  const cleanup = () => {
    stopChild(nextProcess)
    stopChild(electronProcess)
  }

  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  process.on('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })

  nextProcess.once('exit', (code) => {
    if (code !== 0) {
      process.exit(code ?? 1)
    }
  })

  await waitForUrl(devUrl)

  electronProcess = spawn(electronBinary, ['.'], {
    cwd: projectRoot,
    env: { ...process.env, BLADEVAULT_MCP_DISCOVERY_FILE: mcpDiscoveryFile },
    stdio: 'inherit',
  })

  electronProcess.once('exit', (code) => {
    stopChild(nextProcess)
    process.exit(code ?? 0)
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
