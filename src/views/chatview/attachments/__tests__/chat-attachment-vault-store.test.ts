import type { ChatAttachmentMetadata } from "../../../../types";
import {
  ChatAttachmentVaultStore,
  chatAttachmentRefKey,
  type ChatAttachmentStoreAdapter,
} from "../ChatAttachmentVaultStore";

function harness() {
  const directories = new Set<string>();
  const files = new Map<string, Uint8Array>();
  const adapter: ChatAttachmentStoreAdapter = {
    exists: jest.fn(async (path) => directories.has(path) || files.has(path)),
    mkdir: jest.fn(async (path) => { directories.add(path); }),
    readBinary: jest.fn(async (path) => {
      const value = files.get(path);
      if (!value) throw new Error("missing");
      return value.slice().buffer;
    }),
    writeBinary: jest.fn(async (path, data) => { files.set(path, new Uint8Array(data)); }),
    list: jest.fn(async (path) => ({
      files: [...files.keys()].filter((candidate) => candidate.slice(0, candidate.lastIndexOf("/")) === path),
      folders: [...directories].filter((candidate) => {
        const separator = candidate.lastIndexOf("/");
        return separator > 0 && candidate.slice(0, separator) === path;
      }),
    })),
    remove: jest.fn(async (path) => { files.delete(path); }),
    stat: jest.fn(async () => ({
      mtime: Date.now() - 8 * 24 * 60 * 60 * 1000,
      ctime: Date.now() - 8 * 24 * 60 * 60 * 1000,
    })),
  };
  return { adapter, files };
}

const imageAttachment = {
  status: "ready" as const,
  id: "image-1",
  name: "diagram.png",
  mimeType: "image/png",
  byteLength: 3,
  kind: "image" as const,
  contentPart: { type: "image_url" as const, image_url: { url: "data:image/png;base64,AQID" } },
};

describe("ChatAttachmentVaultStore", () => {
  it("externalizes runtime attachments and hydrates them back losslessly", async () => {
    const { adapter, files } = harness();
    const store = new ChatAttachmentVaultStore(adapter);

    const [externalized] = await store.externalizeAttachments([imageAttachment]);
    expect(externalized.contentRef).toEqual(expect.objectContaining({
      schema: "systemsculpt-chat-attachment-v1",
      payload: "image-bytes",
      byteLength: 3,
    }));
    expect(files.size).toBe(1);

    const restored = await store.hydratePersistedAttachment(store.dehydrateAttachment(externalized));
    expect(restored).toEqual(externalized);
  });

  it("writes identical payloads once across repeated and concurrent externalization", async () => {
    const { adapter, files } = harness();
    const store = new ChatAttachmentVaultStore(adapter);
    const siblingStore = new ChatAttachmentVaultStore(adapter);

    const [[first], [second]] = await Promise.all([
      store.externalizeAttachments([imageAttachment]),
      siblingStore.externalizeAttachments([{ ...imageAttachment, id: "image-2", name: "copy.png" }]),
    ]);
    await store.externalizeAttachments([first]);

    expect(first.contentRef).toEqual(second.contentRef);
    expect(files.size).toBe(1);
    expect(adapter.writeBinary).toHaveBeenCalledTimes(1);
  });

  it("refuses to overwrite an existing corrupt payload at a content address", async () => {
    const { adapter, files } = harness();
    const store = new ChatAttachmentVaultStore(adapter);
    await store.externalizeAttachments([imageAttachment]);
    const [path] = files.keys();
    files.set(path, new Uint8Array([9, 9, 9]));

    await expect(store.externalizeAttachments([imageAttachment])).rejects.toThrow("corrupt");
    expect(adapter.writeBinary).toHaveBeenCalledTimes(1);
  });

  it("returns an explicit unavailable placeholder when a chat attachment is missing", async () => {
    const { adapter, files } = harness();
    const store = new ChatAttachmentVaultStore(adapter);
    const [externalized] = await store.externalizeAttachments([imageAttachment]);
    files.clear();

    const placeholder = await store.hydrateContentPart({
      name: externalized.name,
      mimeType: externalized.mimeType,
      contentRef: externalized.contentRef,
    }, { strict: false });

    expect(placeholder).toEqual({
      type: "text",
      text: [
        "--- BEGIN ATTACHED FILE: diagram.png (image/png) ---",
        "[[SYSTEMSCULPT_ATTACHMENT_UNAVAILABLE]]",
        "--- END ATTACHED FILE: diagram.png ---",
      ].join("\n"),
    });
  });

  it("throws when a strict hydration target is corrupt", async () => {
    const { adapter, files } = harness();
    const store = new ChatAttachmentVaultStore(adapter);
    const [externalized] = await store.externalizeAttachments([imageAttachment]);
    const [path] = files.keys();
    files.set(path, new Uint8Array([9, 9, 9]));

    const metadata: ChatAttachmentMetadata = {
      id: externalized.id,
      name: externalized.name,
      mimeType: externalized.mimeType,
      byteLength: externalized.byteLength,
      kind: externalized.kind,
      contentPartIndex: 0,
      contentRef: externalized.contentRef,
    };

    await expect(store.hydrateContentPart(metadata)).rejects.toThrow("corrupt");
  });

  it("prunes only unreachable well-formed CAS payloads", async () => {
    const { adapter, files } = harness();
    const store = new ChatAttachmentVaultStore(adapter);
    const [kept] = await store.externalizeAttachments([imageAttachment]);
    const orphanHash = `03${"f".repeat(62)}`;
    files.set(`.systemsculpt/chat-attachments/03/${orphanHash}.txt`, new Uint8Array([1]));
    files.set(`.systemsculpt/chat-attachments/03/${"e".repeat(64)}.txt`, new Uint8Array([2]));

    const removed = await store.pruneUnreferenced(new Set([
      chatAttachmentRefKey(kept.contentRef),
    ]));

    expect(removed).toBe(1);
    // The reachable payload and the malformed-layout file are both preserved.
    expect(files.size).toBe(2);
    expect(adapter.remove).toHaveBeenCalledTimes(1);
  });

  it("keeps fresh or externally imported CAS files inside the grace window", async () => {
    const { adapter, files } = harness();
    const store = new ChatAttachmentVaultStore(adapter);
    const hash = `aa${"1".repeat(62)}`;
    await adapter.mkdir(".systemsculpt");
    await adapter.mkdir(".systemsculpt/chat-attachments");
    await adapter.mkdir(".systemsculpt/chat-attachments/aa");
    files.set(`.systemsculpt/chat-attachments/aa/${hash}.bin`, new Uint8Array([1]));
    (adapter.stat as jest.Mock).mockResolvedValue({ mtime: Date.now(), ctime: Date.now() });

    await expect(store.pruneUnreferenced(new Set())).resolves.toBe(0);
    expect(files.size).toBe(1);
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("rechecks durable references after candidate discovery before deleting", async () => {
    const { adapter, files } = harness();
    const store = new ChatAttachmentVaultStore(adapter);
    const hash = `bb${"2".repeat(62)}`;
    const key = `utf8-content-part:${hash}`;
    await adapter.mkdir(".systemsculpt");
    await adapter.mkdir(".systemsculpt/chat-attachments");
    await adapter.mkdir(".systemsculpt/chat-attachments/bb");
    files.set(`.systemsculpt/chat-attachments/bb/${hash}.txt`, new Uint8Array([1]));

    await expect(store.pruneUnreferenced(new Set(), async () => new Set([key]))).resolves.toBe(0);
    expect(files.size).toBe(1);
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("runs automatic maintenance once per vault adapter, not once per chat view", async () => {
    const first = harness();
    const second = harness();
    const firstDiscovery = jest.fn(async () => new Set<string>());
    const secondDiscovery = jest.fn(async () => new Set<string>());
    const firstViewStore = new ChatAttachmentVaultStore(first.adapter);
    const siblingViewStore = new ChatAttachmentVaultStore(first.adapter);

    await firstViewStore.pruneOncePerSession(firstDiscovery);
    await siblingViewStore.pruneOncePerSession(firstDiscovery);
    await new ChatAttachmentVaultStore(second.adapter).pruneOncePerSession(secondDiscovery);

    expect(firstDiscovery).toHaveBeenCalledTimes(1);
    expect(secondDiscovery).toHaveBeenCalledTimes(1);
  });
});
