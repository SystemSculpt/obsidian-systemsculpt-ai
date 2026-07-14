/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import type { ChatMessage } from "../../../types";
import { ChatStorageService } from "../ChatStorageService";
import { ChatMarkdownSerializer } from "../storage/ChatMarkdownSerializer";
import { ChatAttachmentVaultStore, type ChatAttachmentStoreAdapter } from "../attachments/ChatAttachmentVaultStore";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    stringifyYaml: jest.fn((value: Record<string, unknown>) => Object.entries(value)
      .map(([key, item]) => `${key}: ${String(item)}`)
      .join("\n") + "\n"),
    parseYaml: jest.fn((content: string) => {
      const result: Record<string, any> = {};
      for (const line of content.split("\n")) {
        const match = line.match(/^(\w+):\s*(.*)$/);
        if (!match) continue;
        const [, key, value] = match;
        if (value === "true" || value === "false") result[key] = value === "true";
        else if (!Number.isNaN(Number(value)) && value.trim() !== "") result[key] = Number(value);
        else result[key] = value.replace(/^["']|["']$/g, "");
      }
      return result;
    }),
  };
});

function appHarness(markdown: string) {
  const binaryFiles = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const adapter: ChatAttachmentStoreAdapter & { read: jest.Mock; exists: jest.Mock; mkdir: jest.Mock } = {
    exists: jest.fn(async (path: string) => directories.has(path) || binaryFiles.has(path) || path === "SystemSculpt/Chats"),
    mkdir: jest.fn(async (path: string) => { directories.add(path); }),
    read: jest.fn(async () => markdown),
    readBinary: jest.fn(async (path: string) => {
      const bytes = binaryFiles.get(path);
      if (!bytes) throw new Error("missing");
      return bytes.slice().buffer;
    }),
    writeBinary: jest.fn(async (path: string, data: ArrayBuffer) => {
      binaryFiles.set(path, new Uint8Array(data));
    }),
    list: jest.fn(async (path: string) => ({
      files: path === "SystemSculpt/Chats" ? ["SystemSculpt/Chats/test-chat.md"] : [],
      folders: [],
    })),
  };
  const file = new TFile({ path: "SystemSculpt/Chats/test-chat.md" });
  const app = {
    vault: {
      adapter,
      getAbstractFileByPath: jest.fn(() => file),
      read: jest.fn(async () => markdown),
      modify: jest.fn(async () => undefined),
      create: jest.fn(async () => file),
      createFolder: jest.fn(async () => undefined),
    },
    plugins: { plugins: {} },
  } as unknown as App;
  return { app, adapter, binaryFiles };
}

function buildMarkdown(message: ChatMessage): string {
  return [
    "---",
    "id: test-chat",
    "created: 2026-07-13T00:00:00.000Z",
    "lastModified: 2026-07-13T00:00:00.000Z",
    "title: Test chat",
    "version: 1",
    "---",
    "",
    ChatMarkdownSerializer.serializeMessages([message]),
  ].join("\n");
}

function imageAttachment(id: string) {
  return {
    status: "ready" as const,
    id,
    name: "diagram.png",
    mimeType: "image/png",
    byteLength: 3,
    kind: "image" as const,
    contentPart: { type: "image_url" as const, image_url: { url: "data:image/png;base64,AQID" } },
  };
}

describe("ChatStorageService attachment hydration", () => {
  it("keeps ref-backed attachments lazy while loading and hydrates them on demand", async () => {
    const runtimeMessage: ChatMessage = {
      role: "user",
      message_id: "user-1",
      content: [
        { type: "text", text: "Compare this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    };
    const { app, adapter } = appHarness("");
    const store = new ChatAttachmentVaultStore(adapter);
    const [externalized] = await store.externalizeAttachments([{
      status: "ready",
      id: "image-1",
      name: "diagram.png",
      mimeType: "image/png",
      byteLength: 3,
      kind: "image",
      contentPart: runtimeMessage.content![1] as any,
    }]);
    const markdown = buildMarkdown({
      ...runtimeMessage,
      attachmentMetadata: [{
        id: "image-1",
        name: "diagram.png",
        mimeType: "image/png",
        byteLength: 3,
        kind: "image",
        contentPartIndex: 1,
        contentRef: externalized.contentRef,
      }],
    });
    (app.vault.read as jest.Mock).mockResolvedValue(markdown);
    adapter.read.mockResolvedValue(markdown);

    const service = new ChatStorageService(app, "SystemSculpt/Chats");
    const loaded = await service.loadChat("test-chat");

    expect(String(loaded?.messages[0].content).trim()).toBe("Compare this");
    expect(adapter.readBinary).not.toHaveBeenCalled();

    const hydrated = await store.hydrateMessage(loaded!.messages[0]);
    expect(hydrated.content).toEqual(runtimeMessage.content);
    expect(adapter.readBinary).toHaveBeenCalledTimes(1);
    await expect(service.collectAttachmentRefKeys()).resolves.toEqual(new Set([
      `${externalized.contentRef.payload}:${externalized.contentRef.sha256}`,
    ]));

    adapter.readBinary.mockClear();
    await service.saveChat("test-chat", loaded!.messages);
    expect(adapter.readBinary).not.toHaveBeenCalled();
    const savedMarkdown = (app.vault.modify as jest.Mock).mock.calls[0][1] as string;
    const saved = ChatMarkdownSerializer.parseMarkdown(savedMarkdown);
    expect(saved?.messages[0].attachmentMetadata?.[0].contentRef).toEqual(externalized.contentRef);
    expect(savedMarkdown).not.toContain("data:image/png;base64,AQID");
  });

  it("keeps a missing blob lazy until requested, then returns an unavailable placeholder", async () => {
    const { app, adapter, binaryFiles } = appHarness("");
    const store = new ChatAttachmentVaultStore(adapter);
    const [externalized] = await store.externalizeAttachments([imageAttachment("image-1")]);
    binaryFiles.clear();
    const markdown = buildMarkdown({
      role: "user",
      message_id: "user-1",
      content: [
        { type: "text", text: "Compare this" },
        externalized.contentPart,
      ],
      attachmentMetadata: [{
        id: "image-1",
        name: "diagram.png",
        mimeType: "image/png",
        byteLength: 3,
        kind: "image",
        contentPartIndex: 1,
        contentRef: externalized.contentRef,
      }],
    });
    (app.vault.read as jest.Mock).mockResolvedValue(markdown);
    adapter.read.mockResolvedValue(markdown);
    const service = new ChatStorageService(app, "SystemSculpt/Chats");

    const loaded = await service.loadChat("test-chat");

    expect(String(loaded?.messages[0].content).trim()).toBe("Compare this");
    expect(adapter.readBinary).not.toHaveBeenCalled();

    const hydrated = await store.hydrateMessage(loaded!.messages[0]);
    expect(hydrated.content).toEqual([
      { type: "text", text: "Compare this" },
      {
        type: "text",
        text: [
          "--- BEGIN ATTACHED FILE: diagram.png (image/png) ---",
          "[[SYSTEMSCULPT_ATTACHMENT_UNAVAILABLE]]",
          "--- END ATTACHED FILE: diagram.png ---",
        ].join("\n"),
      },
    ]);
  });

  it("fails attachment reachability closed when a raw metadata attribute is unreadable", async () => {
    const { app, adapter } = appHarness("");
    const markdown = buildMarkdown({
      role: "user",
      message_id: "user-1",
      content: "Hello",
    }).replace(
      'message-id="user-1"',
      'message-id="user-1" attachment-metadata="not/base64!"',
    );
    adapter.read.mockResolvedValue(markdown);
    const service = new ChatStorageService(app, "SystemSculpt/Chats");

    await expect(service.collectAttachmentRefKeys()).resolves.toBeNull();
  });
});
