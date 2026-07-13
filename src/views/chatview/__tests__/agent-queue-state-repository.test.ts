import { AgentQueueStateRepository, type AgentQueueStorageAdapter } from "../AgentQueueStateRepository";
import { ChatAttachmentVaultStore, type ChatAttachmentStoreAdapter } from "../attachments/ChatAttachmentVaultStore";

function adapterHarness() {
  const textFiles = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const queueAdapter: AgentQueueStorageAdapter = {
    exists: jest.fn(async (path) => textFiles.has(path) || binaryFiles.has(path) || directories.has(path)),
    mkdir: jest.fn(async (path) => { directories.add(path); }),
    read: jest.fn(async (path) => {
      const value = textFiles.get(path);
      if (typeof value !== "string") throw new Error("missing");
      return value;
    }),
    write: jest.fn(async (path, contents) => { textFiles.set(path, contents); }),
    remove: jest.fn(async (path) => { textFiles.delete(path); }),
  };
  const attachmentAdapter: ChatAttachmentStoreAdapter = {
    exists: queueAdapter.exists,
    mkdir: queueAdapter.mkdir,
    readBinary: jest.fn(async (path) => {
      const value = binaryFiles.get(path);
      if (!value) throw new Error("missing");
      return value.slice().buffer;
    }),
    writeBinary: jest.fn(async (path, data) => { binaryFiles.set(path, new Uint8Array(data)); }),
  };
  return { queueAdapter, attachmentAdapter, textFiles, binaryFiles };
}

const attachment = {
  status: "ready" as const,
  id: "image-hash",
  name: "diagram.png",
  mimeType: "image/png",
  byteLength: 3,
  kind: "image" as const,
  contentPart: { type: "image_url" as const, image_url: { url: "data:image/png;base64,AQID" } },
};

describe("AgentQueueStateRepository", () => {
  it("round-trips mixed queued drafts while storing only compact attachment refs", async () => {
    const { queueAdapter, attachmentAdapter, textFiles, binaryFiles } = adapterHarness();
    const repository = new AgentQueueStateRepository(
      queueAdapter,
      new ChatAttachmentVaultStore(attachmentAdapter),
      () => new Date("2026-07-13T00:00:00.000Z"),
    );
    const items = [{
      id: "queued-1",
      text: "Compare this",
      webSearch: true,
      includeContextFiles: false,
      attachments: [attachment],
    }];

    await repository.save("chat-1", items);

    const [queuePath] = textFiles.keys();
    const persisted = textFiles.get(queuePath)!;
    expect(persisted).toContain("\"contentRef\"");
    expect(persisted).not.toContain("data:image/png;base64");
    expect(binaryFiles.size).toBe(1);

    await repository.save("chat-1", items);
    expect(attachmentAdapter.writeBinary).toHaveBeenCalledTimes(1);

    await expect(repository.load("chat-1")).resolves.toEqual([
      expect.objectContaining({
        text: "Compare this",
        attachments: [expect.objectContaining({
          id: attachment.id,
          contentPart: attachment.contentPart,
        })],
      }),
    ]);

    await repository.save("chat-1", []);
    expect(await repository.load("chat-1")).toEqual([]);
    expect(textFiles.size).toBe(0);
  });

  it("moves a pre-allocation draft queue onto the durable chat identity", async () => {
    const { queueAdapter, attachmentAdapter } = adapterHarness();
    const repository = new AgentQueueStateRepository(queueAdapter, new ChatAttachmentVaultStore(attachmentAdapter));
    const items = [{
      id: "queued-1",
      text: "Follow up",
      webSearch: false,
      includeContextFiles: true,
    }];
    await repository.save("draft-1", items);

    await repository.move("draft-1", "chat-1", items);

    expect(await repository.load("draft-1")).toEqual([]);
    expect(await repository.load("chat-1")).toEqual(items);
  });

  it("fails loudly instead of silently dropping a corrupt queue", async () => {
    const { queueAdapter, attachmentAdapter, textFiles } = adapterHarness();
    const repository = new AgentQueueStateRepository(queueAdapter, new ChatAttachmentVaultStore(attachmentAdapter));
    await repository.save("chat-1", [{
      id: "queued-1",
      text: "Follow up",
      webSearch: false,
      includeContextFiles: true,
    }]);
    const [path] = textFiles.keys();
    textFiles.set(path, "{bad json");

    await expect(repository.load("chat-1")).rejects.toThrow("corrupted");
  });

  it("fails loudly when a queued attachment payload is missing", async () => {
    const { queueAdapter, attachmentAdapter, binaryFiles } = adapterHarness();
    const repository = new AgentQueueStateRepository(queueAdapter, new ChatAttachmentVaultStore(attachmentAdapter));
    await repository.save("chat-1", [{
      id: "queued-1",
      text: "",
      webSearch: false,
      includeContextFiles: true,
      attachments: [attachment],
    }]);
    binaryFiles.clear();

    await expect(repository.load("chat-1")).rejects.toThrow("missing");
  });
});
