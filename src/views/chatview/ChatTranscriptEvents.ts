import type { Workspace } from "obsidian";

export const CHAT_TRANSCRIPT_COMMITTED_EVENT = "systemsculpt:chat-transcript-committed" as const;

export type ChatTranscriptCommittedEvent = Readonly<{
  chatId: string;
  version: number;
  role: "user" | "assistant";
  messageId: string;
}>;

/** Emit only after the corresponding vault write has completed. */
export function emitChatTranscriptCommitted(
  workspace: Workspace,
  event: ChatTranscriptCommittedEvent,
): void {
  (workspace as Workspace & { trigger: (name: string, payload: ChatTranscriptCommittedEvent) => void })
    .trigger(CHAT_TRANSCRIPT_COMMITTED_EVENT, event);
}
