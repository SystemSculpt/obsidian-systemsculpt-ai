import { ChatMessage } from '../../types';

/**
 * Convert in-memory chat messages to a clean API-ready shape by removing
 * UI-only fields and volatile properties such as messageParts/streaming.
 */
export function toApiBaseMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const cleaned: ChatMessage = {
      role: m.role,
      content: m.content,
      message_id: m.message_id,
    } as any;

    if (m.tool_call_id) cleaned.tool_call_id = m.tool_call_id;
    if (m.name) cleaned.name = m.name;
    if (m.tool_calls) cleaned.tool_calls = m.tool_calls as any;
    if ((m as any).reasoning_details) cleaned.reasoning_details = (m as any).reasoning_details as any;
    if (m.documentContext) cleaned.documentContext = m.documentContext;
    if (m.systemPromptType) cleaned.systemPromptType = m.systemPromptType;
    if (m.systemPromptPath) cleaned.systemPromptPath = m.systemPromptPath;

    // Exclude: messageParts, streaming, annotations (UI/auxiliary)
    return cleaned;
  });
}
