/**
 * Pi session mirror — reads a Pi session file and converts it to ChatMessage[].
 *
 * Uses the Pi SDK's SessionManager directly (npm dependency).
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type SystemSculptPlugin from "../../main";
import type { ChatMessage } from "../../types";
import { buildPiSessionTranscript } from "./PiSessionTranscriptBuilder";
import { SessionManager } from "./PiSdkCore";

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
  const sessionManager = SessionManager.open(options.sessionFile);
  const entries = sessionManager.getBranch();
  const messages = buildPiSessionTranscript(entries as any);
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
    new Set(values.map((v) => String(v || "").trim()).filter(Boolean)),
  );
}

export async function recoverPiSessionMirror(options: {
  plugin: SystemSculptPlugin;
  sessionFile: string;
  lastEntryId?: string;
  messageEntryIds?: string[];
}): Promise<PiSessionMirrorSnapshot | null> {
  const sessionFile = String(options.sessionFile || "").trim();
  if (!sessionFile) return null;

  const sessionDir = dirname(sessionFile);
  if (!sessionDir || !existsSync(sessionDir)) return null;

  const expectedIds = normalizeEntryIds([
    options.lastEntryId,
    ...(options.messageEntryIds || []),
  ]);
  if (expectedIds.length === 0) return null;

  const candidates = readdirSync(sessionDir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(sessionDir, n))
    .filter((c) => c !== sessionFile)
    .sort((a, b) => b.localeCompare(a));

  for (const candidate of candidates) {
    try {
      const snapshot = await loadPiSessionMirror({ plugin: options.plugin, sessionFile: candidate });
      const ids = normalizeEntryIds([
        snapshot.lastEntryId,
        ...snapshot.messages.map((m) => m.pi_entry_id),
      ]);
      if (expectedIds.some((id) => ids.includes(id))) return snapshot;
    } catch {
      // Skip unreadable session files.
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
  const expectedIds = normalizeEntryIds([
    options.lastEntryId,
    ...(options.messageEntryIds || []),
  ]);

  if (sessionFile && !existsSync(sessionFile)) {
    const recovered = await recoverPiSessionMirror(options);
    if (recovered) return recovered;
  }

  try {
    const snapshot = await loadPiSessionMirror({ plugin: options.plugin, sessionFile });
    if (expectedIds.length > 0) {
      const snapshotIds = normalizeEntryIds([
        snapshot.lastEntryId,
        ...snapshot.messages.map((m) => m.pi_entry_id),
      ]);
      if (!expectedIds.some((id) => snapshotIds.includes(id))) {
        const recovered = await recoverPiSessionMirror(options);
        if (recovered) return recovered;
      }
    }
    return snapshot;
  } catch (error) {
    const recovered = await recoverPiSessionMirror(options);
    if (recovered) return recovered;
    throw error;
  }
}
