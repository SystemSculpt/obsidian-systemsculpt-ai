import {
  SemanticWorkQueue,
  type SemanticWorkItem,
  type SemanticWorkStore,
} from "../SemanticWorkQueue";

function durableStore(state = new Map<string, unknown>()): SemanticWorkStore {
  return {
    readState: async <T>(key: string) => (state.get(key) as T | undefined) ?? null,
    writeState: async <T>(key: string, value: T) => { state.set(key, value); },
    deleteState: async (key: string) => { state.delete(key); },
  };
}

describe("SemanticWorkQueue", () => {
  it("coalesces repeated edits into one quiet-period item", async () => {
    const queue = new SemanticWorkQueue(durableStore(), 350);

    await queue.enqueue("Note.md", "modify", 10, 1_000);
    await queue.enqueue("Note.md", "modify", 11, 1_200);
    await queue.enqueue("Note.md", "modify", 12, 1_400);

    expect(queue.snapshot()).toEqual([
      expect.objectContaining({
        path: "Note.md",
        revision: 3,
        sourceMtime: 12,
        reason: "modify",
        requestedAt: 1_000,
        readyAt: 1_750,
        attempts: 0,
        failure: null,
      }),
    ]);
    expect(queue.due(1_749)).toEqual([]);
    expect(queue.due(1_750)).toHaveLength(1);
    expect(queue.get("Note.md")).toEqual(expect.objectContaining({ path: "Note.md" }));
    expect(queue.get("Missing.md")).toBeNull();
  });

  it("persists a burst of file events as one current-state write", async () => {
    const writes: unknown[] = [];
    const store = durableStore();
    store.writeState = async (_key, value) => { writes.push(value); };
    const queue = new SemanticWorkQueue(store, 0);

    await Promise.all([
      queue.enqueueImmediate("A.md", "modify", 1, 1),
      queue.enqueueImmediate("B.md", "modify", 1, 1),
      queue.enqueueImmediate("C.md", "modify", 1, 1),
    ]);

    expect(writes).toHaveLength(1);
    expect((writes[0] as { items: SemanticWorkItem[] }).items.map((item) => item.path)).toEqual([
      "A.md",
      "B.md",
      "C.md",
    ]);
  });

  it("restores pending and failed work across a new manager session", async () => {
    const state = new Map<string, unknown>();
    const first = new SemanticWorkQueue(durableStore(state), 0);
    await first.enqueueImmediate("Pending.md", "modify", 1_000, 1_000);
    const failedClaim = await first.enqueueImmediate("Failed.md", "modify", 1_100, 1_100);
    expect(failedClaim).not.toBeNull();
    await first.fail(failedClaim!, {
      code: "temporarily_unavailable",
      message: "Try again.",
      status: 503,
    }, 1_100);
    await first.settled();

    const restarted = new SemanticWorkQueue(durableStore(state), 0);
    await restarted.restore();

    expect(restarted.due(1_100).map((item) => item.path)).toEqual(["Pending.md"]);
    expect(restarted.failureCount).toBe(1);
    expect(restarted.snapshot()).toContainEqual(expect.objectContaining({
      path: "Failed.md",
      attempts: 1,
      failure: expect.objectContaining({ code: "temporarily_unavailable", failedAt: 1_100 }),
    }));

    await restarted.retryFailures(1_200);
    expect(restarted.failureCount).toBe(0);
    expect(restarted.due(1_200).map((item) => item.path).sort()).toEqual(["Failed.md", "Pending.md"]);
  });

  it("moves queued identity on rename and erases it on delete", async () => {
    const queue = new SemanticWorkQueue(durableStore(), 0);
    await queue.enqueueImmediate("Old.md", "modify", 100, 100);

    await queue.rename("Old.md", "Folder/New.md", 200);
    expect(queue.snapshot()).toEqual([
      expect.objectContaining({ path: "Folder/New.md", reason: "rename" }),
    ]);

    await queue.remove("Folder/New.md");
    expect(queue.snapshot()).toEqual([]);
  });

  it("moves and deletes an entire directory's durable work in one write", async () => {
    const queue = new SemanticWorkQueue(durableStore(), 0);
    await queue.enqueueImmediate("Old/A.md", "modify", 100, 100);
    await queue.enqueueImmediate("Old/Nested/B.md", "modify", 100, 100);
    await queue.enqueueImmediate("Other.md", "modify", 100, 100);

    await queue.renamePrefix("Old", "New", 200);
    expect(queue.snapshot().map((item) => item.path).sort()).toEqual([
      "New/A.md",
      "New/Nested/B.md",
      "Other.md",
    ]);

    await queue.removePrefix("New");
    expect(queue.snapshot().map((item) => item.path)).toEqual(["Other.md"]);
  });

  it("settles only the exact claimed revision when a newer edit arrives", async () => {
    const queue = new SemanticWorkQueue(durableStore(), 0);
    const first = await queue.enqueueImmediate("Race.md", "modify", 100, 1_000);
    expect(first).not.toBeNull();

    const second = await queue.enqueueImmediate("Race.md", "modify", 101, 1_001);
    expect(second?.revision).toBeGreaterThan(first!.revision);

    await queue.complete([first!]);
    expect(queue.get("Race.md")).toEqual(expect.objectContaining({
      revision: second!.revision,
      sourceMtime: 101,
      failure: null,
    }));

    await expect(queue.fail(first!, {
      code: "temporarily_unavailable",
      message: "Old work failed.",
    }, 1_002)).resolves.toBe(false);
    expect(queue.get("Race.md")?.failure).toBeNull();

    await queue.complete([second!]);
    expect(queue.get("Race.md")).toBeNull();
  });
});
