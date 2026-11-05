import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api';
import { useApiMutation, useDetail } from '@/lib/query';
import { streamChat } from './chat-stream';
import type { LiveTool } from './MessageBubble';
import type { ChatEvent, ChatMessage, ChatReply, Conversation } from './types';

function applyEvent(tools: LiveTool[], event: ChatEvent): LiveTool[] {
  if (event.type === 'tool_start') return [...tools, { name: event.name, status: 'running' }];
  if (event.type !== 'tool_end') return tools;
  const index = tools.findLastIndex((tool) => tool.name === event.name && tool.status === 'running');
  return tools.map((tool, i) => (i === index ? { name: tool.name, status: event.status } : tool));
}

interface AssistantChatOptions {
  conversationId: string;
  onConversation: (id: string) => void;
  /** Off until the sheet opens, so a closed one loads nothing. */
  enabled?: boolean;
}

/** One conversation: its messages, what is running, and sending. The page and the sheet share this. */
export function useAssistantChat({ conversationId, onConversation, enabled = true }: AssistantChatOptions) {
  const { i18n } = useTranslation('ai');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<LiveTool[]>([]);

  const conversation = useDetail<Conversation>(enabled && conversationId ? `/ai/conversations/${conversationId}` : null);

  const send = useApiMutation<string, ChatReply>({
    mutationFn: (message) =>
      streamChat(
        { conversationId: conversationId || undefined, message, language: i18n.language },
        (event) => setLive((tools) => applyEvent(tools, event)),
      ),
    invalidate: ['/ai/conversations', '/ai/proposals'],
    silentError: true,
    onSuccess: (reply) => {
      setMessages((current) => [...current, reply.message]);
      onConversation(reply.conversationId);
      setLive([]);
    },
    onError: (_error, message) => {
      // Give the question back, so a failed send loses nothing.
      setMessages((current) => current.slice(0, -1));
      setDraft(message);
      setLive([]);
    },
  });

  // The server copy wins once loaded, except while an answer is on its way.
  useEffect(() => {
    if (send.isPending) return;
    if (conversation.data) setMessages(conversation.data.messages);
    else if (!conversationId) setMessages([]);
  }, [conversation.data, conversationId, send.isPending]);

  const reset = send.reset;
  const startNew = useCallback(() => {
    onConversation('');
    setMessages([]);
    reset();
  }, [onConversation, reset]);

  // A remembered conversation may have been deleted, or belong to someone else on this device.
  const gone = conversation.error instanceof ApiError && conversation.error.status === 404;
  useEffect(() => {
    if (gone) startNew();
  }, [gone, startNew]);

  const ask = (text: string) => {
    const message = text.trim();
    if (!message || send.isPending) return;
    send.reset();
    setDraft('');
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: 'user', createdAt: new Date().toISOString(), text: message },
    ]);
    send.mutate(message);
  };

  return {
    conversationId,
    messages,
    draft,
    setDraft,
    live,
    ask,
    startNew,
    sending: send.isPending,
    sendError: send.error,
    loading: conversation.isLoading,
    // A failed refresh keeps the conversation on screen.
    loadError: gone || conversation.data ? null : conversation.error,
    reload: () => void conversation.refetch(),
  };
}

export type AssistantChat = ReturnType<typeof useAssistantChat>;
