import { SessionManager } from "@mariozechner/pi-coding-agent";
import type SystemSculptPlugin from "../../main";
import { openPiAgentSession } from "./PiSdkRuntime";

export type PiSessionForkMessage = {
  entryId: string;
  text: string;
};

function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        return part.type === "text" && typeof part.text === "string"
          ? part.text
          : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

export async function listPiForkMessages(sessionFile: string): Promise<PiSessionForkMessage[]> {
  const manager = SessionManager.open(sessionFile);
  return manager
    .getBranch()
    .flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") {
        return [];
      }
      return [{
        entryId: entry.id,
        text: toText(entry.message.content),
      }];
    })
    .filter((entry) => entry.entryId.length > 0);
}

export async function forkPiSession(options: {
  plugin: SystemSculptPlugin;
  sessionFile: string;
  entryId: string;
}): Promise<{
  text: string;
  cancelled: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
}> {
  const session = await openPiAgentSession({
    plugin: options.plugin,
    sessionFile: options.sessionFile,
  });

  try {
    const result = await session.fork(options.entryId);
    return {
      text: String(result.selectedText || ""),
      cancelled: result.cancelled,
      sessionFile: String(session.sessionFile || "").trim() || undefined,
      sessionId: String(session.sessionId || "").trim(),
      sessionName: String(session.sessionManager.getSessionName() || "").trim() || undefined,
    };
  } finally {
    session.dispose();
  }
}

export async function setPiSessionName(options: {
  plugin: SystemSculptPlugin;
  sessionFile: string;
  name: string;
}): Promise<{
  sessionFile?: string;
  sessionId: string;
}> {
  const session = await openPiAgentSession({
    plugin: options.plugin,
    sessionFile: options.sessionFile,
  });

  try {
    session.setSessionName(options.name);
    return {
      sessionFile: String(session.sessionFile || "").trim() || undefined,
      sessionId: String(session.sessionId || "").trim(),
    };
  } finally {
    session.dispose();
  }
}
