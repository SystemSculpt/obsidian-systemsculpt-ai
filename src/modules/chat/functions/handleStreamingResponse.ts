import { ChatMessage } from "../ChatMessage";

export function handleStreamingResponse(
  chunk: string,
  appendToLastMessage: (content: string) => void,
  addMessage: (message: ChatMessage) => void
): string {
  try {
    appendToLastMessage(chunk);
    return chunk;
  } catch (error) {
    console.warn("Failed to handle streaming response:", error);
    return chunk;
  }
}
