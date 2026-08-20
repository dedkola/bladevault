import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { closeLocalDb } from '@/lib/local-db'
import { createBladeVaultMcpServer } from '@/lib/mcp/create-server'

async function main() {
  if (process.argv[2] !== 'mcp') {
    console.error('Usage: bladevault mcp')
    process.exitCode = 1
    return
  }

  const running = serveStdio(() => createBladeVaultMcpServer('stdio'), {
    onerror(error) {
      console.error('[bladevault-mcp]', error)
    },
  })

  const close = async () => {
    await running.close()
    closeLocalDb()
  }
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
}

void main().catch((error) => {
  console.error('[bladevault-mcp]', error)
  process.exitCode = 1
})
