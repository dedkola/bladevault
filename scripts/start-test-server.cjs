const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = process.cwd()
const port = process.env.BLADEVAULT_TEST_PORT || '3199'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-e2e-'))
const standaloneDir = path.join(projectRoot, '.next', 'standalone')
const serverEntry = path.join(standaloneDir, 'server.js')
const nextStaticDir = path.join(projectRoot, '.next', 'static')
const standaloneStaticDir = path.join(standaloneDir, '.next', 'static')
const publicDir = path.join(projectRoot, 'public')
const standalonePublicDir = path.join(standaloneDir, 'public')

function copyDirectory(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true })
}

if (!fs.existsSync(serverEntry)) {
  throw new Error('Missing standalone build. Run "npm run build" first.')
}

copyDirectory(nextStaticDir, standaloneStaticDir)
if (fs.existsSync(publicDir)) copyDirectory(publicDir, standalonePublicDir)

const child = spawn(process.execPath, [serverEntry], {
  cwd: standaloneDir,
  env: {
    ...process.env,
    BLADEVAULT_DATA_DIR: dataDir,
    HOSTNAME: '127.0.0.1',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'production',
    PORT: port,
  },
  stdio: 'inherit',
})

let shuttingDown = false

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  if (child.exitCode === null) child.kill(signal)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

child.once('exit', (code) => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(code ?? 0)
})
