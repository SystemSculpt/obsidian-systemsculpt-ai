import type SystemSculptPlugin from "../../main";
import type { ChatMessage } from "../../types";
import { loadPiSdkModule } from "./PiSdk";
import { buildPiSessionTranscript } from "./PiSessionTranscriptBuilder";

export type PiSessionMirrorSnapshot = {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  actualModelId?: string;
  lastEntryId?: string;
  messages: ChatMessage[];
};

export async function loadPiSessionMirror(options: {
  plugin: SystemSculptPlugin;
  sessionFile: string;
}): Promise<PiSessionMirrorSnapshot> {
  void options.plugin;
  const sdk = await loadPiSdkModule();
  const sessionManager = sdk.SessionManager.open(options.sessionFile);
  const entries = sessionManager.getBranch();
  const messages = buildPiSessionTranscript(entries);
  const lastEntryId = String(entries[entries.length - 1]?.id || "").trim() || undefined;

  const model = sessionManager.buildSessionContext().model;
  const provider = String(model?.provider || "").trim();
  const modelId = String(model?.modelId || "").trim();

  return {
    sessionFile:
      typeof sessionManager.getSessionFile() === "string" && sessionManager.getSessionFile()?.trim()
        ? sessionManager.getSessionFile()?.trim()
        : options.sessionFile,
    sessionId: String(sessionManager.getSessionId() || "").trim(),
    sessionName: String(sessionManager.getSessionName() || "").trim() || undefined,
    actualModelId: provider && modelId ? `${provider}/${modelId}` : undefined,
    lastEntryId,
    messages,
  };
}
