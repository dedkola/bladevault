import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const loadCommonJs = createRequire(import.meta.url)
const claudeConfig = loadCommonJs('../../electron/claude-desktop-config.cjs')

const ENTRY = claudeConfig.buildBladeVaultServerEntry({
  command: '/Applications/BladeVault.app/Contents/MacOS/BladeVault',
  bridgePath: '/Applications/BladeVault.app/Contents/Resources/mcp-stdio.cjs',
  discoveryFile: '/Users/me/Library/Application Support/BladeVault/mcp.json',
})

const tempDirs: string[] = []
function makeConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bladevault-claude-'))
  tempDirs.push(dir)
  return path.join(dir, 'Claude', 'claude_desktop_config.json')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Claude Desktop config setup', () => {
  it('builds a stdio entry that runs the bridge with Electron in Node mode', () => {
    expect(ENTRY).toEqual({
      command: '/Applications/BladeVault.app/Contents/MacOS/BladeVault',
      args: ['/Applications/BladeVault.app/Contents/Resources/mcp-stdio.cjs'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        BLADEVAULT_MCP_DISCOVERY_FILE:
          '/Users/me/Library/Application Support/BladeVault/mcp.json',
      },
    })
  })

  it('resolves the platform config path', () => {
    expect(
      claudeConfig.getClaudeDesktopConfigPath({
        platform: 'darwin',
        homedir: '/Users/me',
        env: {},
      }),
    ).toBe(
      '/Users/me/Library/Application Support/Claude/claude_desktop_config.json',
    )
    expect(
      claudeConfig.getClaudeDesktopConfigPath({
        platform: 'win32',
        homedir: 'C:\\Users\\me',
        env: { APPDATA: '/appdata' },
      }),
    ).toBe(path.join('/appdata', 'Claude', 'claude_desktop_config.json'))
  })

  it('creates the config when Claude Desktop has none yet', () => {
    const configPath = makeConfigPath()
    const result = claudeConfig.installClaudeDesktopServer({
      configPath,
      entry: ENTRY,
    })

    expect(result).toEqual({ configPath, backupPath: null, changed: true })
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: { bladevault: ENTRY },
    })
  })

  it('backs up the config and replaces only the bladevault entry', () => {
    const configPath = makeConfigPath()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const original = {
      globalShortcut: 'Alt+Space',
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', 'fs-server'] },
        bladevault: {
          url: 'http://127.0.0.1:5501/mcp',
          headers: { Authorization: 'Bearer old' },
        },
      },
    }
    const originalText = JSON.stringify(original, null, 2)
    fs.writeFileSync(configPath, originalText)

    const result = claudeConfig.installClaudeDesktopServer({
      configPath,
      entry: ENTRY,
      now: new Date('2026-11-18T10:20:30.000Z'),
    })

    expect(result.changed).toBe(true)
    expect(result.backupPath).toBe(
      `${configPath}.bladevault-backup-2026-11-18T10-20-30-000Z`,
    )
    expect(fs.readFileSync(result.backupPath, 'utf8')).toBe(originalText)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      globalShortcut: 'Alt+Space',
      mcpServers: {
        filesystem: original.mcpServers.filesystem,
        bladevault: ENTRY,
      },
    })
  })

  it('leaves the file alone when the entry is already current', () => {
    const configPath = makeConfigPath()
    claudeConfig.installClaudeDesktopServer({ configPath, entry: ENTRY })
    const before = fs.readFileSync(configPath, 'utf8')

    const result = claudeConfig.installClaudeDesktopServer({
      configPath,
      entry: ENTRY,
    })

    expect(result).toEqual({ configPath, backupPath: null, changed: false })
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
    expect(fs.readdirSync(path.dirname(configPath))).toEqual([
      'claude_desktop_config.json',
    ])
  })

  it('refuses to overwrite a config it cannot parse', () => {
    const configPath = makeConfigPath()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, '{ "mcpServers": ')

    expect(() =>
      claudeConfig.installClaudeDesktopServer({ configPath, entry: ENTRY }),
    ).toThrow(/isn't valid JSON/)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ "mcpServers": ')
  })

  it('refuses a config whose mcpServers is not an object', () => {
    expect(() =>
      claudeConfig.mergeClaudeDesktopConfig('{"mcpServers": []}', ENTRY),
    ).toThrow(/mcpServers/)
  })
})
