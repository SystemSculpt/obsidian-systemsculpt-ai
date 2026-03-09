import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
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

function normalizeEntryIds(values: Array<string | undefined | null>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

export async function recoverPiSessionMirror(options: {
  plugin: SystemSculptPlugin;
  sessionFile: string;
  lastEntryId?: string;
  messageEntryIds?: string[];
}): Promise<PiSessionMirrorSnapshot | null> {
  const sessionFile = String(options.sessionFile || "").trim();
  if (!sessionFile) {
    return null;
  }

  const sessionDir = dirname(sessionFile);
  if (!sessionDir || !existsSync(sessionDir)) {
    return null;
  }

  const expectedEntryIds = normalizeEntryIds([
    options.lastEntryId,
    ...(options.messageEntryIds || []),
  ]);
  if (expectedEntryIds.length === 0) {
    return null;
  }

  const candidateFiles = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionDir, name))
    .filter((candidate) => candidate !== sessionFile)
    .sort((left, right) => right.localeCompare(left));

  for (const candidateFile of candidateFiles) {
    try {
      const snapshot = await loadPiSessionMirror({
        plugin: options.plugin,
        sessionFile: candidateFile,
      });
      const candidateEntryIds = normalizeEntryIds([
        snapshot.lastEntryId,
        ...snapshot.messages.map((message) => message.pi_entry_id),
      ]);
      const matches = expectedEntryIds.some((entryId) => candidateEntryIds.includes(entryId));
      if (matches) {
        return snapshot;
      }
    } catch {
      // Ignore unreadable/non-matching session files while searching for recovery candidates.
    }
  }

  return null;
}

export async function loadPiSessionMirrorWithRecovery(options: {
  plugin: SystemSculptPlugin;
  sessionFile: string;
  lastEntryId?: string;
  messageEntryIds?: string[];
}): Promise<PiSessionMirrorSnapshot> {
  const sessionFile = String(options.sessionFile || "").trim();
  const expectedEntryIds = normalizeEntryIds([
    options.lastEntryId,
    ...(options.messageEntryIds || []),
  ]);

  if (sessionFile && !existsSync(sessionFile)) {
    const recovered = await recoverPiSessionMirror({
      ...options,
      sessionFile,
    });
    if (recovered) {
      return recovered;
    }
  }

  try {
    const snapshot = await loadPiSessionMirror({
      plugin: options.plugin,
      sessionFile,
    });
    if (expectedEntryIds.length > 0) {
      const snapshotEntryIds = normalizeEntryIds([
        snapshot.lastEntryId,
        ...snapshot.messages.map((message) => message.pi_entry_id),
      ]);
      const matchesExpectedEntry = expectedEntryIds.some((entryId) => snapshotEntryIds.includes(entryId));
      if (!matchesExpectedEntry) {
        const recovered = await recoverPiSessionMirror({
          ...options,
          sessionFile,
        });
        if (recovered) {
          return recovered;
        }
      }
    }
    return snapshot;
  } catch (error) {
    const recovered = await recoverPiSessionMirror(options);
    if (recovered) {
      return recovered;
    }
    throw error;
  }
}
