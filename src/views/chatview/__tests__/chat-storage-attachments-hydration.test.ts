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
  };
  const file = new TFile({ path: "SystemSculpt/Chats/test-chat.md" });
  const app = {
    vault: {
      adapter,
      getAbstractFileByPath: jest.fn(() => file),
      read: jest.fn(async () => markdown),
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
  it("rehydrates ref-backed attachments when loading a chat", async () => {
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

    const service = new ChatStorageService(app, "SystemSculpt/Chats");
    const loaded = await service.loadChat("test-chat");

    expect(loaded?.messages[0].content).toEqual(runtimeMessage.content);
  });

  it("keeps the chat loadable with an explicit unavailable placeholder when a blob is gone", async () => {
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
    const service = new ChatStorageService(app, "SystemSculpt/Chats");

    const loaded = await service.loadChat("test-chat");

    expect(loaded?.messages[0].content).toEqual([
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
});
