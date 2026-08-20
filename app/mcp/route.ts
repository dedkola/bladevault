import { handleMcpHttpRequest } from '@/lib/mcp/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = handleMcpHttpRequest
export const POST = handleMcpHttpRequest
export const DELETE = handleMcpHttpRequest
