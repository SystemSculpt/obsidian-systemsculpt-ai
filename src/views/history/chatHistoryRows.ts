import type { App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { CodexThreadLocator } from "../../services/codex/CodexThreadLocator";
import { LOCAL_AGENTS, type LocalAgentId, type TextExecutionBackend } from "../../services/codex/LocalAgents";
import { chatHistoryIndex } from "./chatHistoryIndex";

export type ChatHistoryRow = Readonly<{
  chatId: string;
  title: string;
  chatPath: string;
  timestampMs: number;
  backend: TextExecutionBackend;
  favorite: boolean;
}>;

type RowsHost = Pick<SystemSculptPlugin, "app" | "settings">
  & Partial<Pick<SystemSculptPlugin, "registerEvent">>;

/**
 * The conversations each on-machine agent ran in this vault, from the names of
 * its thread locators. Opening a chat routes it the same way.
 */
export async function localAgentConversations(app: App): Promise<ReadonlyMap<LocalAgentId, ReadonlySet<string>>> {
  const agents = Object.keys(LOCAL_AGENTS) as LocalAgentId[];
  const ids = await Promise.all(agents.map((agent) => new CodexThreadLocator(app, agent).conversationIds()));
  return new Map(agents.map((agent, index) => [agent, ids[index]]));
}

/** Saved chats newest first, with each chat's backend and favorite state. */
export async function listChatHistoryRows(plugin: RowsHost): Promise<ChatHistoryRow[]> {
  const conversations = await localAgentConversations(plugin.app);
  const favorites = new Set(plugin.settings.favoriteChats ?? []);
  return chatHistoryIndex(plugin).list()
    .map((record): ChatHistoryRow => {
      const conversationId = record.agentConversationId;
      const backend = conversationId
        ? [...conversations].find(([, ids]) => ids.has(conversationId))?.[0] ?? "systemsculpt"
        : "systemsculpt";
      return {
        chatId: record.chatId,
        title: record.title,
        chatPath: record.chatPath,
        timestampMs: Number.isFinite(record.lastModified) && record.lastModified > 0 ? record.lastModified : 0,
        backend,
        favorite: favorites.has(record.chatId),
      };
    })
    .sort((left, right) => right.timestampMs - left.timestampMs || left.title.localeCompare(right.title));
}
