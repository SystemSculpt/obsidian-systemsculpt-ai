import { createHash, webcrypto } from "node:crypto";
import {
  AgentMutationJournal,
  MAX_LEGACY_JOURNAL_CHARACTERS,
  MAX_LEGACY_JOURNAL_RECORDS,
  canonicalAgentToolInput,
} from "../MutationJournal";

const JOURNAL_PATH = ".systemsculpt/mutations.json";
const RECORDS_PATH = `${JOURNAL_PATH}.records`;
const MIGRATION_MARKER_PATH = `${RECORDS_PATH}/_legacy-v2-migrated.json`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function keyedRecordPath(conversationId: string, toolCallId: string): string {
  return `${RECORDS_PATH}/${sha256(JSON.stringify([conversationId, toolCallId]))}.json`;
}

function inputFingerprint(name: string, canonicalInput: string): string {
  return sha256(`${name}\n${canonicalInput}`);
}

function adapterHarness(initial?: string | ReadonlyMap<string, string>) {
  const files = new Map<string, string>();
  const directories = new Set<string>(["", ".systemsculpt"]);
  if (typeof initial === "string") files.set(JOURNAL_PATH, initial);
  else if (initial) {
    for (const [path, content] of initial) files.set(path, content);
  }
  for (const path of files.keys()) {
    const parts = path.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }

  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || directories.has(path)),
    read: jest.fn(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`Missing ${path}.`);
      return content;
    }),
    stat: jest.fn(async (path: string) => {
      const content = files.get(path);
      if (content !== undefined) {
        return {
          type: "file" as const,
          ctime: 0,
          mtime: 0,
          size: new TextEncoder().encode(content).byteLength,
        };
      }
      if (directories.has(path)) {
        return { type: "folder" as const, ctime: 0, mtime: 0, size: 0 };
      }
      return null;
    }),
    write: jest.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
    mkdir: jest.fn(async (path: string) => {
      directories.add(path);
    }),
    list: jest.fn(async (path: string) => {
      const prefix = `${path}/`;
      return {
        files: [...files.keys()].filter((candidate) => {
          if (!candidate.startsWith(prefix)) return false;
          return !candidate.slice(prefix.length).includes("/");
        }),
        folders: [...directories].filter((candidate) => {
          if (!candidate.startsWith(prefix)) return false;
          return !candidate.slice(prefix.length).includes("/");
        }),
      };
    }),
    remove: jest.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  return {
    adapter,
    file: (path: string) => files.get(path),
    files: () => new Map(files),
    setFile: (path: string, content: string) => {
      files.set(path, content);
      const parts = path.split("/").slice(0, -1);
      for (let index = 1; index <= parts.length; index += 1) {
        directories.add(parts.slice(0, index).join("/"));
      }
    },
    recordFiles: () => [...files.entries()].filter(([path]) =>
      path.startsWith(`${RECORDS_PATH}/`) && /\/[a-f0-9]{64}\.json$/.test(path)),
  };
}

function recordsIn(harness: ReturnType<typeof adapterHarness>) {
  return harness.recordFiles().map(([, content]) =>
    (JSON.parse(content) as { record: unknown }).record);
}

describe("AgentMutationJournal", () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, "crypto", { value: webcrypto });
    }
  });

  it("canonicalizes nested tool input independently of object key order", () => {
    expect(canonicalAgentToolInput({ b: [undefined, 2], a: null }))
      .toBe('{"a":null,"b":[undefined,2]}');
  });

  it("records started actions as outcome unknown and completed actions as replayable", async () => {
    const harness = adapterHarness();
    const journal = new AgentMutationJournal(
      harness.adapter,
      JOURNAL_PATH,
      () => 10,
    );
    const conversationId = "conversation_a".padEnd(45, "a");
    const input = { path: "Projects/Plan.md", content: "done" };
    const storagePath = keyedRecordPath(conversationId, "call-1");

    await expect(journal.inspect(conversationId, "call-1", "write", input))
      .resolves.toEqual({ kind: "absent" });
    expect(harness.adapter.write).not.toHaveBeenCalled();
    await expect(journal.claim(conversationId, "call-1", "write", input))
      .resolves.toEqual({ kind: "execute" });
    expect(harness.adapter.write).toHaveBeenLastCalledWith(
      storagePath,
      expect.any(String),
    );
    await expect(journal.inspect(conversationId, "call-1", "write", input))
      .resolves.toEqual({ kind: "outcome-unknown" });
    await expect(journal.claim(conversationId, "call-1", "write", input))
      .resolves.toEqual({ kind: "outcome-unknown" });
    await expect(journal.claim(
      conversationId,
      "call-1",
      "write",
      { content: "done", path: "Projects/Plan.md" },
    )).resolves.toEqual({ kind: "outcome-unknown" });

    await journal.complete(
      conversationId,
      "call-1",
      "write",
      { content: "done", path: "Projects/Plan.md" },
      { success: true, data: { path: "Projects/Plan.md" } },
    );
    await expect(journal.inspect(conversationId, "call-1", "write", input))
      .resolves.toEqual({
        kind: "replay",
        result: { success: true, data: { path: "Projects/Plan.md" } },
      });
    await expect(journal.claim(conversationId, "call-1", "write", input))
      .resolves.toEqual({
        kind: "replay",
        result: { success: true, data: { path: "Projects/Plan.md" } },
      });
    await expect(journal.claim(
      conversationId,
      "call-1",
      "write",
      { ...input, content: "different" },
    )).resolves.toEqual({ kind: "conflict" });
    await expect(journal.claim(
      conversationId,
      "call-1",
      "edit",
      input,
    )).resolves.toEqual({ kind: "conflict" });
  });

  it("fails closed for corrupt state and for any receipt write failure", async () => {
    const corrupt = adapterHarness("{not json");
    const corruptJournal = new AgentMutationJournal(corrupt.adapter, JOURNAL_PATH);
    await expect(corruptJournal.inspect("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });
    await expect(corruptJournal.claim("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });

    const malformedRecord = adapterHarness();
    malformedRecord.setFile(
      keyedRecordPath("conversation-a", "call-1"),
      JSON.stringify({ version: 1, record: { state: "started" } }),
    );
    const malformedJournal = new AgentMutationJournal(malformedRecord.adapter, JOURNAL_PATH);
    await expect(malformedJournal.inspect("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });

    const wrongVersion = adapterHarness();
    wrongVersion.setFile(
      keyedRecordPath("conversation-a", "call-1"),
      JSON.stringify({ version: 2, record: {} }),
    );
    const wrongVersionJournal = new AgentMutationJournal(wrongVersion.adapter, JOURNAL_PATH);
    await expect(wrongVersionJournal.inspect("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });

    const malformedClaim = adapterHarness();
    malformedClaim.setFile(
      keyedRecordPath("conversation-a", "call-1"),
      "null",
    );
    const malformedClaimJournal = new AgentMutationJournal(malformedClaim.adapter, JOURNAL_PATH);
    await expect(malformedClaimJournal.claim("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });

    const failed = adapterHarness();
    failed.adapter.write.mockRejectedValueOnce(new Error("disk full"));
    const failedJournal = new AgentMutationJournal(failed.adapter, JOURNAL_PATH);
    await expect(failedJournal.claim("conversation-a", "call-1", "move", {}))
      .rejects.toThrow("disk full");
    await expect(failedJournal.claim("conversation-a", "call-2", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });
  });

  it("rejects malformed legacy data and migration markers", async () => {
    const duplicate = {
      conversationId: "conversation-a",
      toolCallId: "call-1",
      fingerprint: inputFingerprint("move", "{}"),
      state: "started",
      updatedAt: 1,
    };
    const invalidLegacyFiles = [
      "null",
      JSON.stringify({ version: 1, records: [] }),
      JSON.stringify({ version: 2, records: [duplicate, duplicate] }),
      JSON.stringify({ version: 2, records: [null] }),
    ];
    for (const content of invalidLegacyFiles) {
      const harness = adapterHarness(content);
      const journal = new AgentMutationJournal(harness.adapter, JOURNAL_PATH);
      await expect(journal.inspect("conversation-a", "call-1", "move", {}))
        .resolves.toEqual({ kind: "journal-unavailable" });
    }

    for (const marker of ["null", JSON.stringify({ version: 2, legacyVersion: 2 })]) {
      const files = new Map<string, string>([
        [JOURNAL_PATH, JSON.stringify({ version: 2, records: [] })],
        [MIGRATION_MARKER_PATH, marker],
      ]);
      const harness = adapterHarness(files);
      const journal = new AgentMutationJournal(harness.adapter, JOURNAL_PATH);
      await expect(journal.inspect("conversation-a", "call-1", "move", {}))
        .resolves.toEqual({ kind: "journal-unavailable" });
    }
  });

  it("fails closed before oversized legacy migrations fan out", async () => {
    const oversizedText = adapterHarness(JSON.stringify({
      version: 2,
      records: [],
      padding: "x".repeat(MAX_LEGACY_JOURNAL_CHARACTERS),
    }));
    const oversizedTextJournal = new AgentMutationJournal(
      oversizedText.adapter,
      JOURNAL_PATH,
    );
    await expect(oversizedTextJournal.inspect(
      "conversation-a",
      "call-1",
      "move",
      {},
    )).resolves.toEqual({ kind: "journal-unavailable" });
    expect(oversizedText.adapter.read).not.toHaveBeenCalled();
    expect(oversizedText.adapter.write).not.toHaveBeenCalled();

    const records = Array.from(
      { length: MAX_LEGACY_JOURNAL_RECORDS + 1 },
      (_, index) => ({
        conversationId: `conversation-${index}`,
        toolCallId: `call-${index}`,
        fingerprint: inputFingerprint("move", JSON.stringify({ index })),
        state: "started",
        updatedAt: index,
      }),
    );
    const oversizedRecords = adapterHarness(JSON.stringify({ version: 2, records }));
    const oversizedRecordsJournal = new AgentMutationJournal(
      oversizedRecords.adapter,
      JOURNAL_PATH,
    );
    await expect(oversizedRecordsJournal.inspect(
      "conversation-a",
      "call-1",
      "move",
      {},
    )).resolves.toEqual({ kind: "journal-unavailable" });
    expect(oversizedRecords.adapter.write).not.toHaveBeenCalled();
  });

  it("fails closed when completion identity or storage changes", async () => {
    const absent = adapterHarness();
    const absentJournal = new AgentMutationJournal(absent.adapter, JOURNAL_PATH);
    await expect(absentJournal.complete("conversation-a", "call-1", "move", {}, {}))
      .rejects.toThrow("identity changed");

    const corrupt = adapterHarness();
    const corruptJournal = new AgentMutationJournal(corrupt.adapter, JOURNAL_PATH);
    await corruptJournal.claim("conversation-a", "call-1", "move", {});
    corrupt.setFile(keyedRecordPath("conversation-a", "call-1"), "null");
    await expect(corruptJournal.complete("conversation-a", "call-1", "move", {}, {}))
      .rejects.toThrow("journal is unavailable");

    const failed = adapterHarness();
    const failedJournal = new AgentMutationJournal(failed.adapter, JOURNAL_PATH);
    await failedJournal.claim("conversation-a", "call-1", "move", {});
    failed.adapter.write.mockRejectedValueOnce(new Error("completion disk full"));
    await expect(failedJournal.complete("conversation-a", "call-1", "move", {}, {}))
      .rejects.toThrow("completion disk full");
    await expect(failedJournal.complete("conversation-a", "call-1", "move", {}, {}))
      .rejects.toThrow("journal is unavailable");
  });

  it("rejects a valid record stored at a colliding identity path", async () => {
    const source = adapterHarness();
    const sourceJournal = new AgentMutationJournal(source.adapter, JOURNAL_PATH, () => 10);
    await sourceJournal.claim("conversation-source", "call-source", "move", {});
    const sourceContent = source.file(keyedRecordPath("conversation-source", "call-source"));
    expect(sourceContent).toBeDefined();

    const collision = adapterHarness();
    collision.setFile(
      keyedRecordPath("conversation-target", "call-target"),
      sourceContent!,
    );
    const collisionJournal = new AgentMutationJournal(collision.adapter, JOURNAL_PATH);
    await expect(collisionJournal.inspect("conversation-target", "call-target", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });
  });

  it("serializes receipts across concurrent journal instances", async () => {
    const harness = adapterHarness();
    const first = new AgentMutationJournal(harness.adapter, JOURNAL_PATH);
    const second = new AgentMutationJournal(harness.adapter, JOURNAL_PATH);
    const sharedInput = { path: "Shared.md", content: "once" };

    const sameAction = await Promise.all([
      first.claim("conversation-a", "call-shared", "write", sharedInput),
      second.claim("conversation-a", "call-shared", "write", sharedInput),
    ]);
    expect(sameAction.map((claim) => claim.kind).sort())
      .toEqual(["execute", "outcome-unknown"]);

    await Promise.all([
      first.claim("conversation-a", "call-first", "write", { value: 1 }),
      second.claim("conversation-b", "call-second", "write", { value: 2 }),
    ]);
    expect(recordsIn(harness)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationId: "conversation-a",
        toolCallId: "call-first",
      }),
      expect.objectContaining({
        conversationId: "conversation-b",
        toolCallId: "call-second",
      }),
    ]));
    expect(recordsIn(harness)).toHaveLength(3);
    await expect(first.idle()).resolves.toBeUndefined();
  });

  it("migrates version-2 data before marking it complete and keeps the legacy file", async () => {
    const legacyContent = JSON.stringify({
      version: 2,
      records: [
        {
          conversationId: "conversation-a",
          toolCallId: "call-started",
          fingerprint: inputFingerprint("move", "{}"),
          state: "started",
          updatedAt: 10,
        },
        {
          conversationId: "conversation-a",
          toolCallId: "call-completed",
          fingerprint: inputFingerprint("move", "{}"),
          state: "completed",
          result: { success: true },
          updatedAt: 20,
        },
      ],
    });
    const harness = adapterHarness(legacyContent);
    const journal = new AgentMutationJournal(harness.adapter, JOURNAL_PATH);

    await expect(journal.inspect("conversation-a", "call-completed", "move", {}))
      .resolves.toEqual({ kind: "replay", result: { success: true } });
    expect(recordsIn(harness)).toHaveLength(2);
    expect(harness.file(MIGRATION_MARKER_PATH)).toBe(
      JSON.stringify({ version: 1, legacyVersion: 2 }),
    );
    expect(harness.file(JOURNAL_PATH)).toBe(legacyContent);

    const restarted = adapterHarness(harness.files());
    const restartedJournal = new AgentMutationJournal(restarted.adapter, JOURNAL_PATH);
    await expect(restartedJournal.inspect("conversation-a", "call-started", "move", {}))
      .resolves.toEqual({ kind: "outcome-unknown" });
    expect(restarted.adapter.read.mock.calls.map(([path]) => path)).toEqual([
      MIGRATION_MARKER_PATH,
      keyedRecordPath("conversation-a", "call-started"),
    ]);
    expect(restarted.adapter.read).not.toHaveBeenCalledWith(JOURNAL_PATH);
    expect(restarted.adapter.write).not.toHaveBeenCalled();
  });

  it("merges only compatible migration receipts without losing completed outcomes", async () => {
    const completedSource = adapterHarness();
    const completedSourceJournal = new AgentMutationJournal(
      completedSource.adapter,
      JOURNAL_PATH,
      () => 20,
    );
    await completedSourceJournal.claim("conversation-a", "call-1", "move", {});
    await completedSourceJournal.complete(
      "conversation-a",
      "call-1",
      "move",
      {},
      { success: true },
    );
    const completedFiles = completedSource.files();
    completedFiles.set(JOURNAL_PATH, JSON.stringify({
      version: 2,
      records: [{
        conversationId: "conversation-a",
        toolCallId: "call-1",
        fingerprint: inputFingerprint("move", "{}"),
        state: "started",
        updatedAt: 10,
      }],
    }));
    const completed = adapterHarness(completedFiles);
    const completedJournal = new AgentMutationJournal(completed.adapter, JOURNAL_PATH);
    await expect(completedJournal.inspect("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "replay", result: { success: true } });

    const startedSource = adapterHarness();
    const startedSourceJournal = new AgentMutationJournal(
      startedSource.adapter,
      JOURNAL_PATH,
      () => 10,
    );
    await startedSourceJournal.claim("conversation-a", "call-1", "move", {});
    const upgradedFiles = startedSource.files();
    upgradedFiles.set(JOURNAL_PATH, JSON.stringify({
      version: 2,
      records: [{
        conversationId: "conversation-a",
        toolCallId: "call-1",
        fingerprint: inputFingerprint("move", "{}"),
        state: "completed",
        result: { success: true },
        updatedAt: 20,
      }],
    }));
    const upgraded = adapterHarness(upgradedFiles);
    const upgradedJournal = new AgentMutationJournal(upgraded.adapter, JOURNAL_PATH);
    await expect(upgradedJournal.inspect("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "replay", result: { success: true } });

    const conflictingFiles = startedSource.files();
    conflictingFiles.set(JOURNAL_PATH, JSON.stringify({
      version: 2,
      records: [{
        conversationId: "conversation-a",
        toolCallId: "call-1",
        fingerprint: "f".repeat(64),
        state: "started",
        updatedAt: 20,
      }],
    }));
    const conflicting = adapterHarness(conflictingFiles);
    const conflictingJournal = new AgentMutationJournal(conflicting.adapter, JOURNAL_PATH);
    await expect(conflictingJournal.inspect("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });
  });

  it("retries an interrupted migration without deleting legacy data", async () => {
    const legacyContent = JSON.stringify({
      version: 2,
      records: ["call-1", "call-2", "call-3"].map((toolCallId, index) => ({
        conversationId: "conversation-a",
        toolCallId,
        fingerprint: inputFingerprint("move", "{}"),
        state: "started",
        updatedAt: index + 1,
      })),
    });
    const interrupted = adapterHarness(legacyContent);
    let writeCount = 0;
    interrupted.adapter.write.mockImplementation(async (path: string, value: string) => {
      writeCount += 1;
      if (writeCount === 2) throw new Error("interrupted migration");
      interrupted.setFile(path, value);
    });
    const interruptedJournal = new AgentMutationJournal(interrupted.adapter, JOURNAL_PATH);

    await expect(interruptedJournal.inspect("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });
    expect(interrupted.file(JOURNAL_PATH)).toBe(legacyContent);
    expect(interrupted.file(MIGRATION_MARKER_PATH)).toBeUndefined();
    expect(interrupted.recordFiles()).toHaveLength(1);

    const restarted = adapterHarness(interrupted.files());
    const restartedJournal = new AgentMutationJournal(restarted.adapter, JOURNAL_PATH);
    await expect(restartedJournal.inspect("conversation-a", "call-3", "move", {}))
      .resolves.toEqual({ kind: "outcome-unknown" });
    expect(restarted.recordFiles()).toHaveLength(3);
    expect(restarted.file(MIGRATION_MARKER_PATH)).toBeDefined();
    expect(restarted.file(JOURNAL_PATH)).toBe(legacyContent);
  });

  it("uses constant-size per-record writes and exact reads as the journal grows", async () => {
    const harness = adapterHarness();
    const journal = new AgentMutationJournal(harness.adapter, JOURNAL_PATH, () => 1_000);
    const conversationId = "conversation-scale";
    const recordCount = 200;

    for (let index = 0; index < recordCount; index += 1) {
      await journal.claim(
        conversationId,
        `call-${String(index).padStart(4, "0")}`,
        "write",
        { index },
      );
    }
    const claimWrites = harness.adapter.write.mock.calls.slice();
    expect(claimWrites).toHaveLength(recordCount);
    expect(new Set(claimWrites.map(([path]) => path)).size).toBe(recordCount);
    expect(new Set(claimWrites.map(([, content]) => content.length)).size).toBe(1);
    for (const [path, content] of claimWrites) {
      expect(path).toMatch(new RegExp(`^${RECORDS_PATH}\\/[a-f0-9]{64}\\.json$`));
      const parsed = JSON.parse(content);
      expect(parsed).toEqual({
        version: 1,
        record: expect.objectContaining({ state: "started" }),
      });
      expect(parsed).not.toHaveProperty("records");
    }

    harness.adapter.write.mockClear();
    for (let index = 0; index < recordCount; index += 1) {
      await journal.complete(
        conversationId,
        `call-${String(index).padStart(4, "0")}`,
        "write",
        { index },
        { success: true },
      );
    }
    expect(harness.adapter.write).toHaveBeenCalledTimes(recordCount);
    expect(new Set(harness.adapter.write.mock.calls.map(([, content]) => content.length)).size)
      .toBe(1);
    expect(harness.adapter.list).not.toHaveBeenCalled();

    const restarted = adapterHarness(harness.files());
    const restartedJournal = new AgentMutationJournal(restarted.adapter, JOURNAL_PATH);
    const targetCallId = "call-0199";
    await expect(restartedJournal.inspect(
      conversationId,
      targetCallId,
      "write",
      { index: 199 },
    )).resolves.toEqual({ kind: "replay", result: { success: true } });
    expect(restarted.adapter.list).not.toHaveBeenCalled();
    expect(restarted.adapter.read.mock.calls.map(([path]) => path)).toEqual([
      keyedRecordPath(conversationId, targetCallId),
    ]);
    expect(restarted.adapter.write).not.toHaveBeenCalled();
  });

  it("fails closed when conversation deletion finds a collision", async () => {
    const source = adapterHarness();
    const sourceJournal = new AgentMutationJournal(source.adapter, JOURNAL_PATH);
    await sourceJournal.claim("conversation-source", "call-source", "move", {});
    const collision = adapterHarness();
    collision.setFile(
      keyedRecordPath("conversation-target", "call-target"),
      source.file(keyedRecordPath("conversation-source", "call-source"))!,
    );
    const collisionJournal = new AgentMutationJournal(collision.adapter, JOURNAL_PATH);
    await expect(collisionJournal.deleteConversation("conversation-target"))
      .rejects.toThrow("colliding record");
    await expect(collisionJournal.inspect("conversation-target", "call-target", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });

    const harness = adapterHarness();
    const adapterWithoutDeletion = {
      exists: harness.adapter.exists,
      read: harness.adapter.read,
      write: harness.adapter.write,
      mkdir: harness.adapter.mkdir,
    };
    const journalWithoutDeletion = new AgentMutationJournal(adapterWithoutDeletion, JOURNAL_PATH);
    await expect(journalWithoutDeletion.deleteConversation("conversation-a"))
      .rejects.toThrow("cannot delete conversations");
  });

  it("keeps conversation-scoped receipts until deliberate deletion", async () => {
    const harness = adapterHarness();
    const journal = new AgentMutationJournal(harness.adapter, JOURNAL_PATH);
    for (let index = 0; index < 300; index += 1) {
      await journal.claim("conversation-a", `call-${index}`, "write", { index });
    }
    await journal.claim("conversation-b", "call-0", "write", { index: 0 });

    expect(recordsIn(harness)).toHaveLength(301);
    expect(harness.adapter.list).not.toHaveBeenCalled();
    await journal.deleteConversation("conversation-a");
    const remaining = recordsIn(harness);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      conversationId: "conversation-b",
      toolCallId: "call-0",
    });
    expect(harness.adapter.list).toHaveBeenCalledTimes(1);
  });
});
