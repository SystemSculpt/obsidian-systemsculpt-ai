import { ChatMessage } from "../types";

// Export all tool call types
export * from "./toolCalls";

/**
 * ChatState interface defines the structure of chat state stored in view state
 * and used for serialization/deserialization across the chat view system
 */
export interface ChatState {
  chatId: string;
  selectedModelId: string;
  chatTitle: string;
  messages?: ChatMessage[];
} 
