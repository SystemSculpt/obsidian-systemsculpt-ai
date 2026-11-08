import type { AgentConversationRenderer } from "../../AgentConversationRenderer";
import type { ConversationHistoryHydration } from "../../ConversationHistoryHydration";

/** Access the durable renderer's public lifecycle seam, never its backing entries. */
export function historyHydrationFor(renderer: AgentConversationRenderer): ConversationHistoryHydration {
  return (renderer as unknown as { historyHydration: ConversationHistoryHydration }).historyHydration;
}
