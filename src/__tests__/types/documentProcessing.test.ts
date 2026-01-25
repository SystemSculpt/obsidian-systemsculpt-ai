/**
 * @jest-environment node
 */
import type {
  DocumentProcessingStage,
  DocumentProcessingFlow,
  DocumentProcessingProgressEvent,
  DocumentProcessingLogEntry,
} from "../../types/documentProcessing";

describe("DocumentProcessingStage type", () => {
  it("can be queued", () => {
    const stage: DocumentProcessingStage = "queued";
    expect(stage).toBe("queued");
  });

  it("can be validating", () => {
    const stage: DocumentProcessingStage = "validating";
    expect(stage).toBe("validating");
  });

  it("can be uploading", () => {
    const stage: DocumentProcessingStage = "uploading";
    expect(stage).toBe("uploading");
  });

  it("can be processing", () => {
    const stage: DocumentProcessingStage = "processing";
    expect(stage).toBe("processing");
  });

  it("can be downloading", () => {
    const stage: DocumentProcessingStage = "downloading";
    expect(stage).toBe("downloading");
  });

  it("can be contextualizing", () => {
    const stage: DocumentProcessingStage = "contextualizing";
    expect(stage).toBe("contextualizing");
  });

  it("can be ready", () => {
    const stage: DocumentProcessingStage = "ready";
    expect(stage).toBe("ready");
  });

  it("can be error", () => {
    const stage: DocumentProcessingStage = "error";
    expect(stage).toBe("error");
  });
});

describe("DocumentProcessingFlow type", () => {
  it("can be document", () => {
    const flow: DocumentProcessingFlow = "document";
    expect(flow).toBe("document");
  });

  it("can be audio", () => {
    const flow: DocumentProcessingFlow = "audio";
    expect(flow).toBe("audio");
  });

  it("can be generic", () => {
    const flow: DocumentProcessingFlow = "generic";
    expect(flow).toBe("generic");
  });
});

describe("DocumentProcessingProgressEvent type", () => {
  it("can create a minimal progress event", () => {
    const event: DocumentProcessingProgressEvent = {
      progress: 50,
      stage: "processing",
      label: "Processing document",
      icon: "📄",
    };

    expect(event.progress).toBe(50);
    expect(event.stage).toBe("processing");
    expect(event.label).toBe("Processing document");
    expect(event.icon).toBe("📄");
  });

  it("can create a full progress event", () => {
    const event: DocumentProcessingProgressEvent = {
      progress: 75,
      stage: "uploading",
      label: "Uploading file",
      icon: "⬆️",
      details: "Uploading report.pdf (2.5 MB)",
      flow: "document",
      documentId: "doc_123",
      status: "in_progress",
      error: undefined,
      cached: false,
      metadata: { originalSize: 2621440 },
    };

    expect(event.progress).toBe(75);
    expect(event.flow).toBe("document");
    expect(event.documentId).toBe("doc_123");
    expect(event.cached).toBe(false);
    expect(event.metadata?.originalSize).toBe(2621440);
  });

  it("can create an error event", () => {
    const event: DocumentProcessingProgressEvent = {
      progress: 0,
      stage: "error",
      label: "Processing failed",
      icon: "❌",
      error: "File too large",
      status: "failed",
    };

    expect(event.stage).toBe("error");
    expect(event.error).toBe("File too large");
    expect(event.status).toBe("failed");
  });

  it("can create a cached result event", () => {
    const event: DocumentProcessingProgressEvent = {
      progress: 100,
      stage: "ready",
      label: "Using cached result",
      icon: "✅",
      cached: true,
    };

    expect(event.cached).toBe(true);
    expect(event.progress).toBe(100);
  });

  it("can have audio flow", () => {
    const event: DocumentProcessingProgressEvent = {
      progress: 30,
      stage: "processing",
      label: "Transcribing audio",
      icon: "🎤",
      flow: "audio",
    };

    expect(event.flow).toBe("audio");
  });
});

describe("DocumentProcessingLogEntry type", () => {
  it("extends DocumentProcessingProgressEvent", () => {
    const entry: DocumentProcessingLogEntry = {
      progress: 100,
      stage: "ready",
      label: "Complete",
      icon: "✅",
      filePath: "/path/to/file.pdf",
      fileName: "file.pdf",
    };

    expect(entry.progress).toBe(100);
    expect(entry.filePath).toBe("/path/to/file.pdf");
    expect(entry.fileName).toBe("file.pdf");
  });

  it("can have all log entry fields", () => {
    const entry: DocumentProcessingLogEntry = {
      progress: 100,
      stage: "ready",
      label: "Processed",
      icon: "✅",
      filePath: "/docs/report.pdf",
      fileName: "report.pdf",
      attempt: 1,
      durationMs: 5000,
      source: "drag-drop",
    };

    expect(entry.attempt).toBe(1);
    expect(entry.durationMs).toBe(5000);
    expect(entry.source).toBe("drag-drop");
  });

  it("can have retry attempt", () => {
    const entry: DocumentProcessingLogEntry = {
      progress: 50,
      stage: "uploading",
      label: "Retrying upload",
      icon: "🔄",
      attempt: 3,
    };

    expect(entry.attempt).toBe(3);
  });

  it("can have custom metadata via index signature", () => {
    const entry: DocumentProcessingLogEntry = {
      progress: 100,
      stage: "ready",
      label: "Done",
      icon: "✅",
      customField: "customValue",
      numericField: 42,
    };

    expect(entry["customField"]).toBe("customValue");
    expect(entry["numericField"]).toBe(42);
  });

  it("can track error with duration", () => {
    const entry: DocumentProcessingLogEntry = {
      progress: 0,
      stage: "error",
      label: "Upload failed",
      icon: "❌",
      error: "Network timeout",
      attempt: 3,
      durationMs: 30000,
      filePath: "/uploads/large-file.pdf",
    };

    expect(entry.error).toBe("Network timeout");
    expect(entry.durationMs).toBe(30000);
    expect(entry.attempt).toBe(3);
  });
});
