import { webcrypto } from "node:crypto";
import { AgentMutationJournal } from "../MutationJournal";

function adapterHarness(initial?: string) {
  let content = initial;
  const adapter = {
    exists: jest.fn(async (path: string) =>
      path === ".systemsculpt/mutations.json" ? content !== undefined : true),
    read: jest.fn(async () => content ?? ""),
    write: jest.fn(async (_path: string, value: string) => {
      content = value;
    }),
    mkdir: jest.fn(async () => {}),
  };
  return { adapter, read: () => content };
}

describe("AgentMutationJournal", () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, "crypto", { value: webcrypto });
    }
  });

  it("records started actions as outcome unknown and completed actions as replayable", async () => {
    const harness = adapterHarness();
    const journal = new AgentMutationJournal(
      harness.adapter as any,
      ".systemsculpt/mutations.json",
      () => 10,
    );
    const input = { path: "Projects/Plan.md", content: "done" };

    await expect(journal.claim("conversation_a".padEnd(45, "a"), "call-1", "write", input))
      .resolves.toEqual({ kind: "execute" });
    await expect(journal.claim("conversation_a".padEnd(45, "a"), "call-1", "write", input))
      .resolves.toEqual({ kind: "outcome-unknown" });

    await journal.complete(
      "conversation_a".padEnd(45, "a"),
      "call-1",
      "write",
      input,
      { success: true, data: { path: "Projects/Plan.md" } },
    );
    await expect(journal.claim("conversation_a".padEnd(45, "a"), "call-1", "write", input))
      .resolves.toEqual({
        kind: "replay",
        result: { success: true, data: { path: "Projects/Plan.md" } },
      });
    await expect(journal.claim(
      "conversation_a".padEnd(45, "a"),
      "call-1",
      "write",
      { ...input, content: "different" },
    )).resolves.toEqual({ kind: "conflict" });
  });

  it("fails closed for corrupt state and for any receipt write failure", async () => {
    const corrupt = adapterHarness("{not json");
    const corruptJournal = new AgentMutationJournal(
      corrupt.adapter as any,
      ".systemsculpt/mutations.json",
    );
    await expect(corruptJournal.claim("conversation-a", "call-1", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });

    const failed = adapterHarness();
    failed.adapter.write.mockRejectedValueOnce(new Error("disk full"));
    const failedJournal = new AgentMutationJournal(
      failed.adapter as any,
      ".systemsculpt/mutations.json",
    );
    await expect(failedJournal.claim("conversation-a", "call-1", "move", {}))
      .rejects.toThrow("disk full");
    await expect(failedJournal.claim("conversation-a", "call-2", "move", {}))
      .resolves.toEqual({ kind: "journal-unavailable" });
  });

  it("serializes receipts across concurrent journal instances", async () => {
    const harness = adapterHarness();
    const first = new AgentMutationJournal(
      harness.adapter as any,
      ".systemsculpt/mutations.json",
    );
    const second = new AgentMutationJournal(
      harness.adapter as any,
      ".systemsculpt/mutations.json",
    );
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
    const records = JSON.parse(harness.read() ?? "{}").records;
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationId: "conversation-a",
        toolCallId: "call-first",
      }),
      expect.objectContaining({
        conversationId: "conversation-b",
        toolCallId: "call-second",
      }),
    ]));
    expect(records).toHaveLength(3);
  });

  it("keeps unbounded conversation-scoped receipts until deliberate deletion", async () => {
    const harness = adapterHarness();
    const journal = new AgentMutationJournal(
      harness.adapter as any,
      ".systemsculpt/mutations.json",
    );
    for (let index = 0; index < 300; index += 1) {
      await journal.claim("conversation-a", `call-${index}`, "write", { index });
    }
    await journal.claim("conversation-b", "call-0", "write", { index: 0 });

    expect(JSON.parse(harness.read() ?? "{}").records).toHaveLength(301);
    await journal.deleteConversation("conversation-a");
    const remaining = JSON.parse(harness.read() ?? "{}").records;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      conversationId: "conversation-b",
      toolCallId: "call-0",
    });
  });
});
