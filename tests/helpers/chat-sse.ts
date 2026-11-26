/** An OpenAI-style server-sent event response, split at odd places. */
export function sseResponse(chunks: unknown[], splitAt = 7): Response {
  const text =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
    'data: [DONE]\n\n'
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += splitAt)
        controller.enqueue(bytes.slice(index, index + splitAt))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

export const textChunk = (content: string) => ({
  choices: [{ delta: { content } }],
})

/** One streamed tool call (name and arguments in one chunk). */
export const toolCallChunk = (id: string, name: string, args: unknown) => ({
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id,
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
})
