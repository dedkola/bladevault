// Copy-ready setup text for MCP clients, shown in Settings → AI / MCP.

const SERVER_NAME = 'bladevault'

type McpClientSetupInput = { url: string; token: string }

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// mcp-remote refuses plain HTTP to anything but localhost without --allow-http,
// which LAN servers (Unraid, Docker on another machine) need.
function needsAllowHttp(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && !LOCAL_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

/** One-line `claude mcp add` command; `--scope user` makes it work in every project. */
export function buildClaudeCodeMcpCommand({
  url,
  token,
}: McpClientSetupInput): string {
  return `claude mcp add --transport http --scope user ${SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`
}

/**
 * Claude Desktop only starts local servers, so the entry runs mcp-remote as a
 * stdio bridge to the HTTP endpoint. The token sits in env because Claude
 * Desktop on Windows doesn't escape spaces inside args.
 */
export function buildClaudeDesktopMcpConfig({
  url,
  token,
}: McpClientSetupInput): string {
  const args = [
    '-y',
    'mcp-remote',
    url,
    '--header',
    'Authorization:${AUTH_HEADER}',
  ]
  if (needsAllowHttp(url)) args.push('--allow-http')

  return JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          command: 'npx',
          args,
          env: { AUTH_HEADER: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}
