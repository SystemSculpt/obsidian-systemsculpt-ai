import type { ChatAttachmentMetadata } from "../../../../types";
import { ChatAttachmentVaultStore, type ChatAttachmentStoreAdapter } from "../ChatAttachmentVaultStore";

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

    const [[first], [second]] = await Promise.all([
      store.externalizeAttachments([imageAttachment]),
      store.externalizeAttachments([{ ...imageAttachment, id: "image-2", name: "copy.png" }]),
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
});
