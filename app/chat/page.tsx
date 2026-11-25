import type { Metadata } from 'next'
import { ChatView } from '@/components/chat/chat-view'

export const metadata: Metadata = {
  title: 'BladeVault | Chat',
  description:
    'Ask about your knives, collection stats, prices and maintenance with your AI model.',
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string | string[] }>
}) {
  const { c } = await searchParams
  return (
    <div
      data-chat-route
      className="flex w-full flex-1 flex-col p-3 sm:p-4 lg:p-6"
    >
      <ChatView
        initialConversation={typeof c === 'string' && c ? c : undefined}
      />
    </div>
  )
}
