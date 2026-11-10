// Large JSON payloads (collection, activity, logs) are compressed by Next's
// built-in response compression. Route handlers must not gzip bodies
// themselves: Next strips `Content-Encoding` from route responses (since
// 16.4.5), which would leave clients with undecodable gzip bytes.
export async function dockerJsonResponse(
  _request: Request,
  payload: unknown,
  init: ResponseInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'private, no-store')
  }

  return new Response(JSON.stringify(payload), { ...init, headers })
}
