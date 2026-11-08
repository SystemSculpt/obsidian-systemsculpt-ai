import type { AgentConversationRenderer } from "../../AgentConversationRenderer";
import type { ConversationHistoryHydration } from "../../ConversationHistoryHydration";
import type { ActiveConversationRenderer } from "../../ActiveConversationRenderer";

/** Access the durable renderer's public lifecycle seam, never its backing entries. */
export function historyHydrationFor(renderer: AgentConversationRenderer): ConversationHistoryHydration {
  return (renderer as unknown as { historyHydration: ConversationHistoryHydration }).historyHydration;
}

export function activeRendererFor(renderer: AgentConversationRenderer): ActiveConversationRenderer {
  return (renderer as unknown as { active: ActiveConversationRenderer }).active;
}
