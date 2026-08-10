import type { WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { buildChatLeafState, type ChatResumeDescriptor } from "./storage/ChatPersistenceTypes";

export async function openChatResumeDescriptor(
  plugin: SystemSculptPlugin,
  descriptor: ChatResumeDescriptor,
  leaf?: WorkspaceLeaf,
): Promise<void> {
  const targetLeaf = leaf || plugin.app.workspace.getLeaf("tab");
  await targetLeaf.setViewState({
    type: CHAT_VIEW_TYPE,
    active: true,
    state: buildChatLeafState(descriptor),
  });
  plugin.app.workspace.revealLeaf(targetLeaf);
}
