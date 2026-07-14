import {
  ChatMessageAttachmentCollection,
  composeAttachmentMetadata,
  composeUserMessageContent,
  restoreChatMessageDraft,
  type ChatDocumentAttachmentProcessor,
} from "../ChatMessageAttachments";
import {
  DEFAULT_MANAGED_CHAT_INPUT_LIMITS,
  type ManagedChatInputLimits,
} from "../../../../services/managed/ManagedChatInputLimits";

function limits(overrides: Partial<ManagedChatInputLimits>): ManagedChatInputLimits {
  return Object.freeze({ ...DEFAULT_MANAGED_CHAT_INPUT_LIMITS, ...overrides });
}

function file(name: string, type: string, content: string): File {
  return { name, type, size: new TextEncoder().encode(content).byteLength } as File;
}

function reader(contents: Readonly<Record<string, string>>) {
  return async (input: File): Promise<ArrayBuffer> => {
    const bytes = new TextEncoder().encode(contents[input.name] ?? "");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };
}

describe("ChatMessageAttachmentCollection", () => {
  it("ingests multiple mixed text and image files into provider-neutral message parts", async () => {
    const collection = new ChatMessageAttachmentCollection(reader({
      "brief.md": "# Brief\n\nShip it.",
      "diagram.png": "image-bytes",
      "data.json": '{"ready":true}',
    }));

    const result = await collection.addFiles([
      file("brief.md", "text/markdown", "# Brief\n\nShip it."),
      file("diagram.png", "image/png", "image-bytes"),
      file("data.json", "application/json", '{"ready":true}'),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.accepted.map((item) => [item.name, item.kind])).toEqual([
      ["brief.md", "text"],
      ["diagram.png", "image"],
      ["data.json", "text"],
    ]);
    const content = composeUserMessageContent("Compare these", collection.snapshot());
    expect(content).toEqual([
      { type: "text", text: "Compare these" },
      expect.objectContaining({ type: "text", text: expect.stringContaining("BEGIN ATTACHED FILE: brief.md") }),
      expect.objectContaining({ type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } }),
      expect.objectContaining({ type: "text", text: expect.stringContaining("BEGIN ATTACHED FILE: data.json") }),
    ]);
  });

  it("supports an attachment-only message and restores or removes immutable snapshots", async () => {
    const collection = new ChatMessageAttachmentCollection(reader({ "note.txt": "hello" }));
    await collection.addFiles([file("note.txt", "text/plain", "hello")]);
    const snapshot = collection.snapshot();

    expect(composeUserMessageContent("", snapshot)).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("hello") }),
    ]);
    collection.clear();
    expect(collection.hasAny()).toBe(false);
    collection.replace(snapshot);
    expect(collection.remove(snapshot[0].id)).toBe(true);
    expect(collection.snapshot()).toEqual([]);
  });

  it("deduplicates by content and reports unsupported, empty, and unreadable files truthfully", async () => {
    const collection = new ChatMessageAttachmentCollection(async (input) => {
      if (input.name === "broken.txt") throw new Error("read failed");
      return new TextEncoder().encode(input.name === "copy.md" ? "same" : "same").buffer;
    });
    await collection.addFiles([file("original.md", "text/markdown", "same")]);

    const result = await collection.addFiles([
      file("copy.md", "text/markdown", "same"),
      { name: "empty.txt", type: "text/plain", size: 0 } as File,
      file("archive.zip", "application/zip", "zip"),
      file("broken.txt", "text/plain", "broken"),
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.issues.map((entry) => entry.code)).toEqual([
      "duplicate", "empty", "unsupported", "read_failed",
    ]);
    expect(result.issues[2].message).toContain("Attach PDF, image, Markdown, text, or source files");
  });

  it("enforces per-file, total, and count limits before reading bytes", async () => {
    const read = jest.fn(reader({}));
    const collection = new ChatMessageAttachmentCollection(read);
    const tooLarge = {
      name: "huge.md",
      type: "text/markdown",
      size: DEFAULT_MANAGED_CHAT_INPUT_LIMITS.maxTextBytesPerBlock + 1,
    } as File;
    const oversized = await collection.addFiles([tooLarge]);
    expect(oversized.issues[0].code).toBe("too_large");
    expect(read).not.toHaveBeenCalled();

    const files = Array.from({ length: DEFAULT_MANAGED_CHAT_INPUT_LIMITS.maxContentBlocksPerMessage + 1 }, (_, index) =>
      file(`file-${index}.txt`, "text/plain", String(index)),
    );
    const countCollection = new ChatMessageAttachmentCollection(async (input) =>
      new TextEncoder().encode(input.name).buffer
    );
    const counted = await countCollection.addFiles(files);
    expect(counted.accepted).toHaveLength(DEFAULT_MANAGED_CHAT_INPUT_LIMITS.maxContentBlocksPerMessage);
    expect(counted.issues.at(-1)?.code).toBe("file_limit");
  });

  it("settles a direct-byte PDF job as soon as its ready attachment is constructed", async () => {
    const processor: ChatDocumentAttachmentProcessor = {
      prepare: jest.fn(async ({ bytes }) => ({
        operationId: "document-op-1",
        markdown: `# Extracted\n\n${bytes.byteLength} bytes`,
      })),
      complete: jest.fn(async () => undefined),
      discard: jest.fn(async () => undefined),
    };
    const collection = new ChatMessageAttachmentCollection(reader({
      "brief.pdf": "%PDF",
      "diagram.png": "image",
      "notes.md": "notes",
    }), processor);

    const result = await collection.addFiles([
      file("brief.pdf", "application/pdf", "%PDF"),
      file("diagram.png", "image/png", "image"),
      file("notes.md", "text/markdown", "notes"),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.accepted.map((attachment) => attachment.kind)).toEqual(["document", "image", "text"]);
    expect(processor.prepare).toHaveBeenCalledWith(expect.objectContaining({
      name: "brief.pdf",
      mimeType: "application/pdf",
      bytes: expect.any(ArrayBuffer),
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }));
    expect(processor.complete).toHaveBeenCalledWith("document-op-1");
    expect(processor.discard).not.toHaveBeenCalled();
    expect(result.accepted[0]).not.toHaveProperty("documentOperationId");
    expect(result.accepted[0].contentPart).toEqual(expect.objectContaining({
      type: "text",
      text: expect.stringContaining("# Extracted"),
    }));
  });

  it("restores exact image, text, and PDF identities from a durable multipart message", async () => {
    const processor: ChatDocumentAttachmentProcessor = {
      prepare: jest.fn(async () => ({ operationId: "document-op", markdown: "Extracted PDF" })),
      complete: jest.fn(async () => undefined),
      discard: jest.fn(async () => undefined),
    };
    const collection = new ChatMessageAttachmentCollection(reader({
      "diagram.png": "image-bytes",
      "brief.md": "# Brief",
      "source.pdf": "%PDF-source-bytes",
    }), processor);
    await collection.addFiles([
      file("diagram.png", "image/png", "image-bytes"),
      file("brief.md", "text/markdown", "# Brief"),
      file("source.pdf", "application/pdf", "%PDF-source-bytes"),
    ]);
    const attachments = collection.snapshot();
    const content = composeUserMessageContent("Compare all three", attachments);
    const attachmentMetadata = composeAttachmentMetadata("Compare all three", attachments);

    const restored = restoreChatMessageDraft({
      role: "user",
      message_id: "user-1",
      content,
      attachmentMetadata,
    });

    expect(restored.text).toBe("Compare all three");
    expect(restored.attachments).toEqual(attachments);
    expect(restored.attachments.map(({ id, name, mimeType, byteLength, kind }) => ({
      id, name, mimeType, byteLength, kind,
    }))).toEqual(attachmentMetadata?.map(({ contentPartIndex: _partIndex, ...metadata }) => metadata));
  });

  it("keeps a mixed batch visible but blocks partial send until a failed PDF is retried", async () => {
    let attempt = 0;
    const processor: ChatDocumentAttachmentProcessor = {
      prepare: jest.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("conversion failed");
        return { operationId: "document-op-retry", markdown: "Recovered PDF" };
      }),
      complete: jest.fn(async () => undefined),
      discard: jest.fn(async () => undefined),
    };
    const collection = new ChatMessageAttachmentCollection(reader({
      "notes.md": "notes",
      "broken.pdf": "%PDF",
      "diagram.png": "image",
    }), processor);

    const result = await collection.addFiles([
      file("notes.md", "text/markdown", "notes"),
      file("broken.pdf", "application/pdf", "%PDF"),
      file("diagram.png", "image/png", "image"),
    ]);

    expect(result.accepted.map((attachment) => attachment.name)).toEqual(["notes.md", "diagram.png"]);
    expect(collection.displaySnapshot().map((attachment) => [attachment.name, attachment.status])).toEqual([
      ["notes.md", "ready"],
      ["broken.pdf", "failed"],
      ["diagram.png", "ready"],
    ]);
    expect(collection.hasBlockingFailures()).toBe(true);

    const failed = collection.displaySnapshot().find((attachment) => attachment.status === "failed")!;
    const retried = await collection.retry(failed.id);

    expect(retried.issues).toEqual([]);
    expect(collection.hasBlockingFailures()).toBe(false);
    expect(collection.snapshot().map((attachment) => attachment.name)).toEqual([
      "notes.md", "broken.pdf", "diagram.png",
    ]);
    expect(processor.complete).toHaveBeenCalledWith("document-op-retry");
  });

  it("abandons a prepared PDF when its extracted text cannot become a bounded attachment", async () => {
    const processor: ChatDocumentAttachmentProcessor = {
      prepare: jest.fn(async () => ({
        operationId: "document-op-too-large",
        markdown: "x".repeat(DEFAULT_MANAGED_CHAT_INPUT_LIMITS.maxTextBytesPerBlock + 1),
      })),
      complete: jest.fn(async () => undefined),
      discard: jest.fn(async () => undefined),
    };
    const collection = new ChatMessageAttachmentCollection(reader({ "huge.pdf": "%PDF" }), processor);

    const result = await collection.addFiles([file("huge.pdf", "application/pdf", "%PDF")]);

    expect(result.accepted).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "processing_failed" })]);
    expect(collection.hasBlockingFailures()).toBe(true);
    expect(processor.complete).not.toHaveBeenCalled();
    expect(processor.discard).toHaveBeenCalledWith("document-op-too-large");
  });

  it("enforces negotiated image, block, text, and exact mixed-wire limits", async () => {
    const tiny = limits({
      maxContentBlocksPerMessage: 3,
      maxImagesPerTurn: 1,
      maxImageBytes: 8,
      maxTotalImageBytes: 8,
      maxTextBytesPerBlock: 256,
      maxTotalTextBytes: 320,
      maxDeltaRequestBytes: 66_000,
    });
    const collection = new ChatMessageAttachmentCollection(reader({
      "one.png": "1234",
      "two.png": "5678",
      "note.txt": "short",
    }), undefined, tiny);

    const first = await collection.addFiles([
      file("one.png", "image/png", "1234"),
      file("note.txt", "text/plain", "short"),
    ], "hello");
    expect(first.issues).toEqual([]);

    const second = await collection.addFiles([
      file("two.png", "image/png", "5678"),
    ], "hello");
    expect(second.accepted).toEqual([]);
    expect(second.issues[0].code).toBe("file_limit");

    expect(collection.validateSubmission("x".repeat(257)).map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["text_limit"]),
    );
    collection.setLimits(limits({ ...tiny, maxDeltaRequestBytes: 65_600 }));
    expect(collection.validateSubmission("hello").map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["request_limit"]),
    );
  });
});
