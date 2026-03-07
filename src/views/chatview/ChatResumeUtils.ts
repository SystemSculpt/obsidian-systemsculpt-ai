import type { WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { CHAT_VIEW_TYPE } from "./ChatView";
import type { ChatResumeDescriptor } from "./storage/ChatPersistenceTypes";

export function buildChatResumeState(descriptor: ChatResumeDescriptor): Record<string, unknown> {
  return {
    chatId: descriptor.chatId,
    chatTitle: descriptor.title,
    selectedModelId: descriptor.modelId,
    chatBackend: descriptor.chatBackend,
    piSessionFile: descriptor.pi?.sessionFile,
    piSessionId: descriptor.pi?.sessionId,
    piLastEntryId: descriptor.pi?.lastEntryId,
    piLastSyncedAt: descriptor.pi?.lastSyncedAt,
    file: descriptor.chatPath,
  };
}

export async function openChatResumeDescriptor(
  plugin: SystemSculptPlugin,
  descriptor: ChatResumeDescriptor,
  leaf?: WorkspaceLeaf,
): Promise<void> {
  const targetLeaf = leaf || plugin.app.workspace.getLeaf("tab");
  await targetLeaf.setViewState({
    type: CHAT_VIEW_TYPE,
    state: buildChatResumeState(descriptor),
  });
  plugin.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
}
