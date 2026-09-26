import {
  ChatMessageAttachmentCollection,
  composeAttachmentMetadata,
  composeUserMessageContent,
  restoreChatMessageDraft,
  type ChatDocumentAttachmentProcessor,
} from "../ChatMessageAttachments";
import {
  DEFAULT_THIN_AGENT_INPUT_LIMITS,
  type ThinAgentInputLimits,
} from "../../../../services/managed/ThinAgentInputLimits";
import { parseAttachedTextContent } from "../../../../chat/ChatAttachmentContent";
import * as hashing from "../../../../utils/sha256";

jest.mock("../../../../utils/sha256", () => {
  const actual = jest.requireActual("../../../../utils/sha256");
  return { ...actual, sha256HexFromBytesPortable: jest.fn(actual.sha256HexFromBytesPortable) };
});

function limits(overrides: Partial<ThinAgentInputLimits>): ThinAgentInputLimits {
  return Object.freeze({ ...DEFAULT_THIN_AGENT_INPUT_LIMITS, ...overrides });
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

  it("accepts a Studio project as ordinary text context", async () => {
    const project = '{"schema":"studio.project.v1","graph":{"nodes":[]}}';
    const collection = new ChatMessageAttachmentCollection(reader({
      "architecture.systemsculpt": project,
    }));

    const result = await collection.addFiles([
      file("architecture.systemsculpt", "", project),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.accepted).toEqual([
      expect.objectContaining({
        name: "architecture.systemsculpt",
        kind: "text",
        contentPart: expect.objectContaining({
          type: "text",
          text: expect.stringContaining("studio.project.v1"),
        }),
      }),
    ]);
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
      size: DEFAULT_THIN_AGENT_INPUT_LIMITS.maxTextBytesPerBlock + 1,
    } as File;
    const oversized = await collection.addFiles([tooLarge]);
    expect(oversized.issues[0].code).toBe("too_large");
    expect(read).not.toHaveBeenCalled();

    const files = Array.from({ length: DEFAULT_THIN_AGENT_INPUT_LIMITS.maxContentBlocksPerMessage + 1 }, (_, index) =>
      file(`file-${index}.txt`, "text/plain", String(index)),
    );
    const countCollection = new ChatMessageAttachmentCollection(async (input) =>
      new TextEncoder().encode(input.name).buffer
    );
    const counted = await countCollection.addFiles(files);
    expect(counted.accepted).toHaveLength(DEFAULT_THIN_AGENT_INPUT_LIMITS.maxContentBlocksPerMessage);
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
    }), { signal: expect.objectContaining({ aborted: false }) });
    expect(processor.complete).toHaveBeenCalledWith("document-op-1");
    expect(processor.discard).not.toHaveBeenCalled();
    expect(result.accepted[0]).not.toHaveProperty("documentOperationId");
    expect(result.accepted[0].contentPart).toEqual(expect.objectContaining({
      type: "text",
      text: expect.stringContaining("# Extracted"),
    }));
    expect(result.accepted[0].mimeType).toBe("application/pdf");
    expect(result.accepted[0].contentPart.type === "text"
      ? parseAttachedTextContent(result.accepted[0].contentPart.text)?.mimeType
      : null).toBe("text/markdown");
  });

  /** A document job that only ends when its signal aborts, as a stalled download does. */
  function stalledProcessor() {
    const signals: AbortSignal[] = [];
    const processor: ChatDocumentAttachmentProcessor = {
      prepare: jest.fn((_input, { signal }) => new Promise<never>((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("The operation was aborted.")), { once: true });
      })),
      complete: jest.fn(async () => undefined),
      discard: jest.fn(async () => undefined),
    };
    return { processor, signals };
  }

  async function started(signals: AbortSignal[], count = 1): Promise<void> {
    for (let turn = 0; signals.length < count && turn < 100; turn++) await Promise.resolve();
    expect(signals).toHaveLength(count);
  }

  it("stops a document still processing when the user cancels, and keeps it for a retry (#420)", async () => {
    const { processor, signals } = stalledProcessor();
    const collection = new ChatMessageAttachmentCollection(reader({ "stalled.pdf": "%PDF" }), processor);

    const pending = collection.addFiles([file("stalled.pdf", "application/pdf", "%PDF")]);
    await started(signals);
    collection.cancelProcessing();
    const result = await pending;

    expect(signals[0].aborted).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({
      code: "processing_failed",
      message: "stalled.pdf could not be processed: processing was stopped. Retry to process it.",
    })]);
    const failed = collection.displaySnapshot();
    expect(failed).toEqual([expect.objectContaining({ status: "failed", name: "stalled.pdf" })]);

    // A retry starts with a fresh signal.
    (processor.prepare as jest.Mock).mockImplementationOnce(async (_input, { signal }) => {
      expect(signal.aborted).toBe(false);
      return { operationId: "document-op", markdown: "Extracted" };
    });
    const retried = await collection.retry(failed[0].id);
    expect(retried.accepted.map((attachment) => attachment.name)).toEqual(["stalled.pdf"]);
  });

  it("does not read or hash later files after cancelling a PDF batch", async () => {
    const { processor, signals } = stalledProcessor();
    const read = jest.fn(reader({ "stalled.pdf": "%PDF", "later.md": "Later" }));
    const hash = jest.mocked(hashing.sha256HexFromBytesPortable);
    hash.mockClear();
    try {
      const collection = new ChatMessageAttachmentCollection(read, processor);
      const pending = collection.addFiles([
        file("stalled.pdf", "application/pdf", "%PDF"), file("later.md", "text/markdown", "Later"),
      ]);
      await started(signals);
      const hashedBeforeCancel = hash.mock.calls.length;
      collection.cancelProcessing();
      await pending;
      expect(read).toHaveBeenCalledTimes(1);
      expect(hash).toHaveBeenCalledTimes(hashedBeforeCancel);
      expect(collection.displaySnapshot()).toEqual([expect.objectContaining({ status: "failed", name: "stalled.pdf" })]);
    } finally { hash.mockClear(); }
  });

  it.each(["clear", "dispose"] as const)("%s invalidates an in-flight read before hashing or restoring the old draft", async (action) => {
    let finishRead!: (bytes: ArrayBuffer) => void;
    const read = jest.fn(() => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }));
    const hash = jest.mocked(hashing.sha256HexFromBytesPortable);
    hash.mockClear();
    try {
      const collection = new ChatMessageAttachmentCollection(read);
      const pending = collection.addFiles([file("old.md", "text/markdown", "Old")]);
      collection[action]();
      finishRead(new TextEncoder().encode("Old").buffer);
      expect(await pending).toEqual({ accepted: [], issues: [] });
      expect(hash).not.toHaveBeenCalled();
      expect(collection.displaySnapshot()).toEqual([]);
    } finally { hash.mockClear(); }
  });

  it.each(["resolve", "reject"] as const)("Remove aborts Retry and ignores a late %s even if the processor ignores cancellation", async (outcome) => {
    let finish!: () => void;
    let retrySignal!: AbortSignal;
    const processor: ChatDocumentAttachmentProcessor = {
      prepare: jest.fn().mockRejectedValueOnce(new Error("Retry me")).mockImplementationOnce((_input, { signal }) => {
        retrySignal = signal;
        return new Promise((resolve, reject) => { finish = () => outcome === "resolve"
          ? resolve({ operationId: "late", markdown: "Late" }) : reject(new Error("Late failure")); });
      }),
      complete: jest.fn(async () => undefined), discard: jest.fn(async () => undefined),
    };
    const collection = new ChatMessageAttachmentCollection(reader({ "retry.pdf": "%PDF" }), processor);
    await collection.addFiles([file("retry.pdf", "application/pdf", "%PDF")]);
    const id = collection.displaySnapshot()[0].id;
    const pending = collection.retry(id);
    expect(collection.remove(id)).toBe(true);
    const abortedOnRemove = retrySignal.aborted;
    finish();
    const result = await pending;
    expect(abortedOnRemove).toBe(true);
    expect(result).toEqual({ accepted: [], issues: [] });
    expect(collection.displaySnapshot()).toEqual([]);
    expect(processor.complete).not.toHaveBeenCalled();
    if (outcome === "resolve") expect(processor.discard).toHaveBeenCalledWith("late");
  });

  it("stops document processing when its draft is discarded (#420)", async () => {
    const { processor, signals } = stalledProcessor();
    const collection = new ChatMessageAttachmentCollection(reader({ "stalled.pdf": "%PDF" }), processor);
    const pending = collection.addFiles([file("stalled.pdf", "application/pdf", "%PDF")]);
    await started(signals);
    collection.dispose();
    await pending;
    expect(signals[0].aborted).toBe(true);
    expect(collection.displaySnapshot()).toEqual([]);
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
        markdown: "x".repeat(DEFAULT_THIN_AGENT_INPUT_LIMITS.maxTextBytesPerBlock + 1),
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

  it("enforces server-delivered image, block, and text picker limits", async () => {
    const tiny = limits({
      maxContentBlocksPerMessage: 3,
      maxImagesPerTurn: 1,
      maxImageBytes: 8,
      maxTotalImageBytes: 8,
      maxTextBytesPerBlock: 256,
      maxTotalTextBytes: 320,
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
  });
});
