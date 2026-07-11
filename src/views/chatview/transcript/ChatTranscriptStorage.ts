import type { ChatMessage } from "../../../types";
import type { StoredChatTranscript } from "./ChatTranscriptTypes";

export interface ChatTranscriptStorage {
  load(chatId: string): Promise<StoredChatTranscript | null>;
  save(chatId: string, messages: readonly ChatMessage[]): Promise<{ version: number }>;
  createExclusive(chatId: string, messages: readonly ChatMessage[]): Promise<{ version: number } | null>;
}
