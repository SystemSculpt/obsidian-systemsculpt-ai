import type { EventRef } from "obsidian";
import type { SystemSculptSettings } from "../types";
import type { FileContextStateChangedEvent } from "../views/chatview/FileContextManager";
import type { ChatTranscriptCommittedEvent } from "../views/chatview/ChatTranscriptEvents";

interface SystemSculptWorkspaceEvents {
  "systemsculpt:settings-loaded": (settings: SystemSculptSettings) => void;
  "systemsculpt:settings-updated": (oldSettings: SystemSculptSettings, newSettings: SystemSculptSettings) => void;
  "systemsculpt:settings-file-touched": (settings: SystemSculptSettings) => void;
  "systemsculpt:license-validated": (isValid: boolean) => void;
  "systemsculpt:embeddings-progress": (progress: { current: number; total: number }) => void;
  "systemsculpt:chat-created": (chatId: string) => void;
  "systemsculpt:chat-closed": (chatId: string) => void;
  "systemsculpt:chat-loaded": (chatId: string) => void;
  "systemsculpt:content-rendered": () => void;
  "systemsculpt:settings-focus-tab": (tabId: string) => void;
  "systemsculpt:file-context-state-changed": (event: FileContextStateChangedEvent) => void;
  "systemsculpt:chat-transcript-committed": (event: ChatTranscriptCommittedEvent) => void;
}

declare module "obsidian" {
  interface Workspace {
    trigger<K extends keyof SystemSculptWorkspaceEvents>(
      name: K,
      ...args: Parameters<SystemSculptWorkspaceEvents[K]>
    ): void;

    on<K extends keyof SystemSculptWorkspaceEvents>(
      name: K,
      callback: SystemSculptWorkspaceEvents[K],
      ctx?: unknown,
    ): EventRef;
  }
}
