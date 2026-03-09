import type { WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { CHAT_VIEW_TYPE } from "./ChatView";
import { buildChatLeafState, type ChatResumeDescriptor } from "./storage/ChatPersistenceTypes";

export function buildChatResumeState(descriptor: ChatResumeDescriptor): Record<string, unknown> {
  return buildChatLeafState(descriptor);
}

export async function openChatResumeDescriptor(
  plugin: SystemSculptPlugin,
  descriptor: ChatResumeDescriptor,
  leaf?: WorkspaceLeaf,
): Promise<void> {
  const targetLeaf = leaf || plugin.app.workspace.getLeaf("tab");
  await targetLeaf.setViewState({
    type: CHAT_VIEW_TYPE,
    active: true,
    state: buildChatResumeState(descriptor),
  });
  plugin.app.workspace.revealLeaf(targetLeaf);
}
