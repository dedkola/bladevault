import { describe, expect, it } from 'vitest'
import {
  buildClaudeCodeMcpCommand,
  buildClaudeDesktopMcpConfig,
} from '@/lib/mcp-client-setup'

const token = 'tok_123'

describe('buildClaudeCodeMcpCommand', () => {
  it('adds the HTTP server at user scope with the bearer header', () => {
    expect(
      buildClaudeCodeMcpCommand({
        url: 'http://192.168.0.234:3000/mcp',
        token,
      }),
    ).toBe(
      'claude mcp add --transport http --scope user bladevault http://192.168.0.234:3000/mcp --header "Authorization: Bearer tok_123"',
    )
  })
})

describe('buildClaudeDesktopMcpConfig', () => {
  const parse = (url: string) =>
    JSON.parse(buildClaudeDesktopMcpConfig({ url, token })).mcpServers
      .bladevault

  it('bridges a LAN server through mcp-remote with the token in env', () => {
    expect(parse('http://192.168.0.234:3000/mcp')).toEqual({
      command: 'npx',
      args: [
        '-y',
        'mcp-remote',
        'http://192.168.0.234:3000/mcp',
        '--header',
        'Authorization:${AUTH_HEADER}',
        '--allow-http',
      ],
      env: { AUTH_HEADER: 'Bearer tok_123' },
    })
  })

  it('skips --allow-http for localhost and HTTPS', () => {
    expect(parse('http://localhost:5500/mcp').args).not.toContain(
      '--allow-http',
    )
    expect(parse('http://127.0.0.1:5501/mcp').args).not.toContain(
      '--allow-http',
    )
    expect(parse('https://vault.example.com/mcp').args).not.toContain(
      '--allow-http',
    )
  })

  it('keeps spaces out of args', () => {
    for (const arg of parse('http://192.168.0.234:3000/mcp').args) {
      expect(arg).not.toContain(' ')
    }
  })
})
