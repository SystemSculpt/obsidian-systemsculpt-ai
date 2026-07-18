/** @jest-environment jsdom */

import { App, Platform, TFile } from "obsidian";
import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { RecorderService } from "../RecorderService";
import { setCurrentHostPreferredMicrophoneId } from "../recorder/RecorderPreferenceStore";
import {
  ManagedTranscriptionInterruptedError,
  TranscriptionResumeRequiredError,
} from "../transcription/ManagedTranscriptionAdapter";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const mockUiInstances: any[] = [];
const mockSessionInstances: any[] = [];
let mockSessionFactory: (options: any) => any;
const mockTranscriptionStart = jest.fn();
const mockTranscriptionUnload = jest.fn();
const mockTranscriptionAcknowledgeCompleted = jest.fn();

jest.mock("../recorder/RecorderUIManager", () => ({
  RecorderUIManager: jest.fn().mockImplementation(() => {
    const ui = {
      open: jest.fn((_actions, _initial) => ({
        host: document.body,
        hostDocument: document,
        hostWindow: window,
      })),
      render: jest.fn(),
      close: jest.fn(),
      closeAfter: jest.fn(),
      isVisible: jest.fn().mockReturnValue(true),
    };
    mockUiInstances.push(ui);
    return ui;
  }),
}));

jest.mock("../recorder/RecorderFormats", () => ({
  pickRecorderFormat: jest.fn().mockReturnValue({
    mimeType: "audio/webm;codecs=opus",
    extension: "webm",
  }),
}));

jest.mock("../recorder/RecordingSession", () => ({
  MAX_ENCODED_CAPTURE_BYTES: 64 * 1024 * 1024,
  MOBILE_MAX_ENCODED_CAPTURE_BYTES: 24 * 1024 * 1024,
  RecordingSession: jest.fn().mockImplementation((options) => {
    const session = mockSessionFactory(options);
    mockSessionInstances.push({ options, session });
    return session;
  }),
}));

jest.mock("../TranscriptionService", () => ({
  TranscriptionService: {
    getInstance: jest.fn(() => ({
      start: mockTranscriptionStart,
      acknowledgeCompleted: mockTranscriptionAcknowledgeCompleted,
      unload: mockTranscriptionUnload,
    })),
  },
}));

jest.mock("../../utils/errorHandling", () => ({
  logDebug: jest.fn(),
  logInfo: jest.fn(),
  logError: jest.fn(),
}));

interface SessionHarness {
  session: any;
  start: Deferred<{ filePath: string; startedAt: number; microphoneLabel: string }>;
  completion: Deferred<any>;
  setRecording(value: boolean): void;
  setPendingSave(value: any | null): void;
}

function createSessionHarness(): SessionHarness {
  const start = deferred<{ filePath: string; startedAt: number; microphoneLabel: string }>();
  const completion = deferred<any>();
  let recording = false;
  let pendingSave: any | null = null;
  const session = {
    completion: completion.promise,
    start: jest.fn(() => start.promise),
    stop: jest.fn((reason = "manual") => {
      recording = false;
      completion.resolve({
        filePath: "SystemSculpt/Recordings/session.webm",
        startedAt: 1_000,
        durationMs: 2_000,
        sizeBytes: 24_000,
        stopReason: reason,
      });
      return completion.promise;
    }),
    hasPendingSave: jest.fn(() => pendingSave !== null),
    getPendingSaveResult: jest.fn(() => pendingSave),
    retrySave: jest.fn(async () => {
      if (!pendingSave) throw new Error("There is no captured audio waiting to be saved.");
      const result = pendingSave;
      pendingSave = null;
      return result;
    }),
    dispose: jest.fn(() => {
      recording = false;
      const error = new Error("Recording was cancelled.");
      error.name = "AbortError";
      start.reject(error);
      completion.reject(error);
    }),
    isRecording: jest.fn(() => recording),
  };
  return {
    session,
    start,
    completion,
    setRecording: (value) => { recording = value; },
    setPendingSave: (value) => { pendingSave = value; },
  };
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
};

describe("RecorderService", () => {
  let app: App;
  let plugin: any;
  let harness: SessionHarness;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTranscriptionStart.mockReset();
    mockTranscriptionAcknowledgeCompleted.mockReset().mockResolvedValue(undefined);
    mockUiInstances.length = 0;
    mockSessionInstances.length = 0;
    (RecorderService as any).instance = null;

    app = new App();
    window.localStorage.clear();
    Object.assign(Platform, {
      isDesktopApp: true,
      isMobile: false,
      isMobileApp: false,
    });
    setCurrentHostPreferredMicrophoneId(window, app.vault.getName(), "desk-mic");
    plugin = {
      settings: {
        recordingsDirectory: "SystemSculpt/Recordings",
        autoTranscribeRecordings: false,
        autoPasteTranscription: true,
        autoSubmitAfterTranscription: false,
        pendingRecorderCaptures: [],
      },
      directoryManager: {
        ensureDirectoryByPath: jest.fn().mockResolvedValue(undefined),
      },
      openSettingsTab: jest.fn(),
    };
    plugin.getSettingsManager = jest.fn(() => ({
      updateSettings: jest.fn(async (update: Record<string, unknown>) => {
        Object.assign(plugin.settings, update);
      }),
    }));
    harness = createSessionHarness();
    mockSessionFactory = () => harness.session;
  });

  afterEach(() => {
    (RecorderService as any).instance?.unload();
    (RecorderService as any).instance = null;
  });

  it("creates one plugin-scoped service and supports listener disposal", () => {
    const service = RecorderService.getInstance(app, plugin);
    expect(RecorderService.getInstance()).toBe(service);

    const listener = jest.fn();
    const dispose = service.onToggle(listener);
    dispose();
    (service as any).notifyRecordingListeners();
    expect(listener).not.toHaveBeenCalled();
  });

  it("treats two synchronous toggles as start then cancel without requesting the microphone", async () => {
    const service = RecorderService.getInstance(app, plugin);

    await Promise.all([service.toggleRecording(), service.toggleRecording()]);

    expect(mockSessionInstances).toHaveLength(0);
    expect((service as any).state).toBe("idle");
    expect(service.isCurrentlyRecording()).toBe(false);
  });

  it("uses the initiating window realm and reports recording only after capture starts", async () => {
    const service = RecorderService.getInstance(app, plugin);
    const listener = jest.fn();
    service.onToggle(listener);

    const running = service.toggleRecording();
    await flush();
    expect(listener).toHaveBeenLastCalledWith(true);
    expect(mockSessionInstances[0].options.hostContext).toEqual({
      host: document.body,
      hostDocument: document,
      hostWindow: window,
    });
    expect(mockSessionInstances[0].options.preferredMicrophoneId).toBe("desk-mic");

    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 5_000,
      microphoneLabel: "Phone microphone",
    });
    await running;

    expect((service as any).state).toBe("recording");
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "recording",
      startedAt: 5_000,
      microphoneLabel: "Phone microphone",
    }));
  });

  it("uses the mobile host microphone preference without reading the desktop one", async () => {
    Object.assign(Platform, {
      isDesktopApp: false,
      isMobile: true,
      isMobileApp: true,
    });
    setCurrentHostPreferredMicrophoneId(window, app.vault.getName(), "phone-mic");
    const service = RecorderService.getInstance(app, plugin);

    const running = service.toggleRecording();
    await flush();

    expect(mockSessionInstances[0].options.preferredMicrophoneId).toBe("phone-mic");
    expect(mockSessionInstances[0].options.maxEncodedBytes).toBe(24 * 1024 * 1024);

    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.m4a",
      startedAt: 5_000,
      microphoneLabel: "Phone microphone",
    });
    await running;
  });

  it("normalizes the configured recordings directory before every host operation", async () => {
    plugin.settings.recordingsDirectory = "Voice Notes///";
    const service = RecorderService.getInstance(app, plugin);

    const running = service.toggleRecording();
    await flush();

    expect(mockSessionInstances[0].options.directoryPath).toBe("Voice Notes");
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "Voice Notes/session.webm",
      startedAt: 5_000,
      microphoneLabel: "Default microphone",
    });
    await running;
  });

  it("does not leave a phantom recording when microphone startup fails", async () => {
    const service = RecorderService.getInstance(app, plugin);
    const failure = new Error("Microphone access is blocked.");
    const running = service.toggleRecording();
    await flush();

    harness.start.reject(failure);
    harness.completion.reject(failure);
    await running;

    expect(service.isCurrentlyRecording()).toBe(false);
    expect((service as any).state).toBe("error");
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith({
      phase: "error",
      status: "Microphone access is blocked.",
    });
  });

  it("cancels immediately when tapped again while permission is pending", async () => {
    const service = RecorderService.getInstance(app, plugin);
    const starting = service.toggleRecording();
    await flush();
    const cancel = service.toggleRecording();

    expect(harness.session.stop).not.toHaveBeenCalled();
    await Promise.all([starting, cancel]);

    expect(harness.session.dispose).toHaveBeenCalledTimes(1);
    expect(harness.session.stop).not.toHaveBeenCalled();
    expect((service as any).state).toBe("idle");
    expect(mockUiInstances[0].close).toHaveBeenCalled();
  });

  it("keeps interrupted audio durable and explains why capture ended", async () => {
    const service = RecorderService.getInstance(app, plugin);
    const running = service.toggleRecording();
    await flush();
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      microphoneLabel: "Default microphone",
    });
    await running;

    harness.setRecording(false);
    harness.completion.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 32_000,
      stopReason: "background-hidden",
    });
    await flush();

    expect((service as any).completedCapture.result).not.toHaveProperty("blob");
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "saved",
      status: "Obsidian moved to the background, so recording stopped and the captured audio was saved.",
      sourcePath: "SystemSculpt/Recordings/session.webm",
    }));
  });

  it("explains when the encoded safety limit stops and saves a recording", async () => {
    const service = RecorderService.getInstance(app, plugin);
    const running = service.toggleRecording();
    await flush();
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      microphoneLabel: "Default microphone",
    });
    await running;

    harness.setRecording(false);
    harness.completion.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      durationMs: 5_583_000,
      sizeBytes: 64 * 1024 * 1024,
      stopReason: "size-limit",
    });
    await flush();

    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "saved",
      status: "Recording reached the 64 MiB safety limit. The captured audio is saved.",
    }));
  });

  it("retains failed-save audio, blocks a new recording, and retries the save", async () => {
    const service = RecorderService.getInstance(app, plugin);
    const running = service.toggleRecording();
    await flush();
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      microphoneLabel: "Default microphone",
    });
    await running;

    const pending = {
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 32_000,
      stopReason: "manual",
    };
    harness.setRecording(false);
    harness.setPendingSave(pending);
    harness.completion.reject(new Error(
      "Audio is still in memory, but it could not be saved: Storage is full",
    ));
    await flush();

    expect((service as any).session).toBe(harness.session);
    expect((service as any).state).toBe("warning");
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "warning",
      status: "Audio is still in memory because it could not be saved: Storage is full Retry save before closing Obsidian.",
      sourcePath: pending.filePath,
      canRetrySave: true,
    }));

    await service.toggleRecording();
    expect(mockSessionInstances).toHaveLength(1);

    const actions = mockUiInstances[0].open.mock.calls[0][0];
    actions.onRetrySave();
    await flush();

    expect(harness.session.retrySave).toHaveBeenCalledTimes(1);
    expect((service as any).session).toBeNull();
    expect((service as any).completedCapture.result).toEqual(pending);
    expect((service as any).state).toBe("saved");
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "saved",
      status: "Recording saved.",
    }));
  });

  it("pins transcription to the view and editor where recording began", async () => {
    const originEditor = {
      replaceSelection: jest.fn(),
      getCursor: jest.fn((which?: "from" | "to") => (which === "to"
        ? { line: 0, ch: 4 }
        : { line: 0, ch: 0 })),
      getSelection: jest.fn(() => "seed"),
    };
    const originFile = new TFile({ path: "Notes/origin.md" });
    const originView = {
      getViewType: () => "markdown",
      editor: originEditor,
      file: originFile,
    };
    const originLeaf = { view: originView } as any;
    const otherLeaf = { view: { getViewType: () => CHAT_VIEW_TYPE } } as any;
    (app.workspace as any).activeLeaf = originLeaf;
    (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(originView);
    plugin.settings.autoTranscribeRecordings = true;

    const transcription = deferred<any>();
    mockTranscriptionStart.mockImplementation((request) => {
      request.onProgress?.({ phase: "preparing", progress: 1, message: "Preparing audio…" });
      return { promise: transcription.promise, cancel: jest.fn() };
    });

    const service = RecorderService.getInstance(app, plugin);
    const running = service.toggleRecording();
    await flush();
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      microphoneLabel: "Default microphone",
    });
    await running;

    (app.workspace as any).activeLeaf = otherLeaf;
    harness.setRecording(false);
    harness.completion.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 32_000,
      stopReason: "manual",
    });
    await flush();

    expect(mockTranscriptionStart).toHaveBeenCalledWith(expect.objectContaining({
      destination: "note",
      targetEditor: originEditor,
      validateInsertionTarget: expect.any(Function),
      filePath: "SystemSculpt/Recordings/session.webm",
    }));
    const request = mockTranscriptionStart.mock.calls[0][0];
    expect(request.validateInsertionTarget()).toBe(true);

    transcription.resolve({
      text: "Transcript",
      outputPath: "SystemSculpt/Recordings/session - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: true,
    });
    await flush();
    expect((service as any).state).toBe("complete");
  });

  it("delivers chat dictation only to the chat leaf that started recording", async () => {
    const originLeaf = {
      view: {
        getViewType: () => CHAT_VIEW_TYPE,
        getConversationOriginToken: () => "conversation-origin-1",
      },
    } as any;
    (app.workspace as any).activeLeaf = originLeaf;
    plugin.settings.autoTranscribeRecordings = true;
    const transcription = deferred<any>();
    mockTranscriptionStart.mockReturnValue({ promise: transcription.promise, cancel: jest.fn() });

    const service = RecorderService.getInstance(app, plugin);
    const listener = jest.fn(() => true);
    service.onTranscription(listener);
    const running = service.toggleRecording();
    await flush();
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      microphoneLabel: "Default microphone",
    });
    await running;
    harness.setRecording(false);
    harness.completion.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 32_000,
      stopReason: "manual",
    });
    await flush();
    transcription.resolve({
      text: "Dictated message",
      outputPath: "SystemSculpt/Recordings/session - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();

    expect(listener).toHaveBeenCalledWith(
      "Dictated message",
      originLeaf,
      "conversation-origin-1",
      "SystemSculpt/Recordings/session - transcript.md",
    );
  });

  it("starts another recording while the previous saved audio keeps transcribing", async () => {
    plugin.settings.autoTranscribeRecordings = true;
    const firstTranscription = deferred<any>();
    const cancelFirst = jest.fn();
    mockTranscriptionStart.mockReturnValue({
      operationId: "first-transcription",
      promise: firstTranscription.promise,
      cancel: cancelFirst,
    });

    const service = RecorderService.getInstance(app, plugin);
    const firstStart = service.toggleRecording();
    await flush();
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/first.webm",
      startedAt: 1_000,
      microphoneLabel: "Default microphone",
    });
    await firstStart;
    harness.setRecording(false);
    harness.completion.resolve({
      filePath: "SystemSculpt/Recordings/first.webm",
      startedAt: 1_000,
      durationMs: 2_000,
      sizeBytes: 24_000,
      stopReason: "manual",
    });
    await flush();
    expect((service as any).state).toBe("transcribing");

    const second = createSessionHarness();
    mockSessionFactory = () => second.session;
    const secondStart = service.toggleRecording();
    await flush();
    second.setRecording(true);
    second.start.resolve({
      filePath: "SystemSculpt/Recordings/second.webm",
      startedAt: 4_000,
      microphoneLabel: "Default microphone",
    });
    await secondStart;

    expect(cancelFirst).not.toHaveBeenCalled();
    expect(mockSessionInstances).toHaveLength(2);
    expect((service as any).state).toBe("recording");

    firstTranscription.resolve({
      text: "First transcript",
      outputPath: "SystemSculpt/Recordings/first - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();

    expect((service as any).state).toBe("recording");
    expect((service as any).transcriptionTasks.size).toBe(0);
  });

  it("serializes recorder transcriptions while leaving capture free to continue", async () => {
    plugin.settings.autoTranscribeRecordings = true;
    const first = deferred<any>();
    const second = deferred<any>();
    mockTranscriptionStart
      .mockReturnValueOnce({
        operationId: "first-operation",
        promise: first.promise,
        cancel: jest.fn(),
      })
      .mockReturnValueOnce({
        operationId: "second-operation",
        promise: second.promise,
        cancel: jest.fn(),
      });

    const service = RecorderService.getInstance(app, plugin);
    const firstCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/first.webm",
        startedAt: 1_000,
        durationMs: 2_000,
        sizeBytes: 24_000,
        stopReason: "manual",
      },
      origin: { leaf: null, destination: "note", editor: null, conversationOriginToken: null, hostDocument: document },
      microphoneLabel: "Default microphone",
    };
    const secondCapture = {
      ...firstCapture,
      result: {
        ...firstCapture.result,
        filePath: "SystemSculpt/Recordings/second.webm",
        startedAt: 4_000,
      },
    };

    (service as any).completedCapture = firstCapture;
    void (service as any).transcribeSavedRecording();
    await flush();
    expect(mockTranscriptionStart).toHaveBeenCalledTimes(1);

    (service as any).detachDisplayedTranscription();
    (service as any).completedCapture = secondCapture;
    (service as any).state = "saved";
    void (service as any).transcribeSavedRecording();
    await flush();

    expect(mockTranscriptionStart).toHaveBeenCalledTimes(1);
    expect((service as any).queuedTranscriptions).toHaveLength(1);
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "saved",
      status: expect.stringContaining("Waiting for the previous transcription"),
    }));

    first.resolve({
      text: "First transcript",
      outputPath: "SystemSculpt/Recordings/first - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();
    await flush();

    expect(mockTranscriptionStart).toHaveBeenCalledTimes(2);
    expect(mockTranscriptionStart.mock.calls[1][0]).toEqual(expect.objectContaining({
      filePath: secondCapture.result.filePath,
    }));
    expect((service as any).queuedTranscriptions).toHaveLength(0);

    second.resolve({
      text: "Second transcript",
      outputPath: "SystemSculpt/Recordings/second - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();
  });

  it("restarts a queued automatic transcription when the setting is turned back on", async () => {
    plugin.settings.autoTranscribeRecordings = true;
    const first = deferred<any>();
    const second = deferred<any>();
    mockTranscriptionStart
      .mockReturnValueOnce({ operationId: "first-operation", promise: first.promise, cancel: jest.fn() })
      .mockReturnValueOnce({ operationId: "second-operation", promise: second.promise, cancel: jest.fn() });

    const service = RecorderService.getInstance(app, plugin);
    const capture = (filePath: string, startedAt: number) => ({
      result: {
        filePath,
        startedAt,
        durationMs: 2_000,
        sizeBytes: 24_000,
        stopReason: "manual",
      },
      origin: {
        leaf: null,
        destination: "note",
        editor: null,
        conversationOriginToken: null,
        hostDocument: document,
      },
      microphoneLabel: "Default microphone",
    });

    (service as any).completedCapture = capture("SystemSculpt/Recordings/first.webm", 1_000);
    void (service as any).transcribeSavedRecording();
    await flush();
    (service as any).detachDisplayedTranscription();
    (service as any).completedCapture = capture("SystemSculpt/Recordings/second.webm", 4_000);
    (service as any).state = "saved";
    void (service as any).transcribeSavedRecording();
    await flush();
    expect((service as any).queuedTranscriptions).toHaveLength(1);

    plugin.settings.autoTranscribeRecordings = false;
    first.resolve({
      text: "First transcript",
      outputPath: "SystemSculpt/Recordings/first - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();
    await flush();
    expect(mockTranscriptionStart).toHaveBeenCalledTimes(1);
    expect((service as any).queuedTranscriptions).toHaveLength(1);

    plugin.settings.autoTranscribeRecordings = true;
    service.recoverPendingCaptures();
    await flush();
    expect(mockTranscriptionStart).toHaveBeenCalledTimes(2);
    expect((service as any).queuedTranscriptions).toHaveLength(0);

    second.resolve({
      text: "Second transcript",
      outputPath: "SystemSculpt/Recordings/second - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();
  });

  it("persists manual transcription intent before dispatch when automatic transcription is off", async () => {
    const events: string[] = [];
    const work = deferred<any>();
    plugin.getSettingsManager = jest.fn(() => ({
      updateSettings: jest.fn(async (update: Record<string, unknown>) => {
        events.push("persist");
        Object.assign(plugin.settings, update);
      }),
    }));
    mockTranscriptionStart.mockImplementation((request) => {
      events.push("dispatch");
      return {
        operationId: "manual-operation",
        promise: Promise.resolve(
          request.onOperationIdChange?.("manual-operation"),
        ).then(() => work.promise),
        cancel: jest.fn(),
      };
    });
    const service = RecorderService.getInstance(app, plugin);
    (service as any).completedCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/manual.webm",
        startedAt: 1_000,
        durationMs: 2_000,
        sizeBytes: 24_000,
        stopReason: "manual",
      },
      origin: {
        leaf: null,
        destination: "note",
        editor: null,
        conversationOriginToken: null,
        hostDocument: document,
      },
      microphoneLabel: "Default microphone",
    };

    const running = (service as any).transcribeSavedRecording("manual");
    await flush();

    expect(events.slice(0, 2)).toEqual(["persist", "dispatch"]);
    expect(plugin.settings.pendingRecorderCaptures).toEqual([
      expect.objectContaining({
        filePath: "SystemSculpt/Recordings/manual.webm",
        transcriptionIntent: "manual",
        operationId: "manual-operation",
      }),
    ]);

    work.resolve({
      text: "Manual transcript",
      outputPath: "SystemSculpt/Recordings/manual - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await running;
  });

  it("does not dispatch manual transcription when restart-safe intent cannot be saved", async () => {
    plugin.getSettingsManager = jest.fn(() => ({
      updateSettings: jest.fn().mockRejectedValue(new Error("settings unavailable")),
    }));
    const service = RecorderService.getInstance(app, plugin);
    (service as any).completedCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/manual.webm",
        startedAt: 1_000,
        durationMs: 2_000,
        sizeBytes: 24_000,
        stopReason: "manual",
      },
      origin: {
        leaf: null,
        destination: "note",
        editor: null,
        conversationOriginToken: null,
        hostDocument: document,
      },
      microphoneLabel: "Default microphone",
    };

    await (service as any).transcribeSavedRecording("manual");

    expect(mockTranscriptionStart).not.toHaveBeenCalled();
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "warning",
      status: expect.stringContaining("restart-safe"),
      canRetry: true,
    }));
  });

  it("recovers a manually requested transcription while automatic transcription stays off", async () => {
    const source = new TFile({
      path: "SystemSculpt/Recordings/manual-recovery.webm",
      stat: { size: 24_000 },
    });
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
      (path: string) => path === source.path ? source : null,
    );
    plugin.settings.pendingRecorderCaptures = [{
      filePath: source.path,
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 24_000,
      stopReason: "manual",
      destination: "note",
      transcriptionIntent: "manual",
      operationId: "manual-recovery-operation",
    }];
    mockTranscriptionStart.mockReturnValue({
      operationId: "manual-recovery-operation",
      promise: Promise.resolve({
        text: "Recovered manual transcript",
        outputPath: "SystemSculpt/Recordings/manual-recovery - transcript.md",
        sourceDisposition: "kept",
        insertedIntoOrigin: false,
      }),
      cancel: jest.fn(),
    });

    const service = RecorderService.getInstance(app, plugin);
    service.recoverPendingCaptures();
    await flush();
    await flush();

    expect(mockTranscriptionStart).toHaveBeenCalledWith(expect.objectContaining({
      filePath: source.path,
      resumeOperationId: "manual-recovery-operation",
    }));
    expect(plugin.settings.pendingRecorderCaptures).toEqual([]);
  });

  it("drains a queued manual transcription even when automatic transcription is turned off", async () => {
    plugin.settings.autoTranscribeRecordings = true;
    const first = deferred<any>();
    const second = deferred<any>();
    mockTranscriptionStart
      .mockReturnValueOnce({ operationId: "first-operation", promise: first.promise, cancel: jest.fn() })
      .mockReturnValueOnce({ operationId: "manual-operation", promise: second.promise, cancel: jest.fn() });
    const service = RecorderService.getInstance(app, plugin);
    const capture = (filePath: string, startedAt: number) => ({
      result: {
        filePath,
        startedAt,
        durationMs: 2_000,
        sizeBytes: 24_000,
        stopReason: "manual",
      },
      origin: {
        leaf: null,
        destination: "note",
        editor: null,
        conversationOriginToken: null,
        hostDocument: document,
      },
      microphoneLabel: "Default microphone",
    });

    (service as any).completedCapture = capture("SystemSculpt/Recordings/first.webm", 1_000);
    void (service as any).transcribeSavedRecording("automatic");
    await flush();
    (service as any).detachDisplayedTranscription();
    plugin.settings.autoTranscribeRecordings = false;
    (service as any).completedCapture = capture("SystemSculpt/Recordings/manual.webm", 4_000);
    void (service as any).transcribeSavedRecording("manual");
    await flush();
    expect((service as any).queuedTranscriptions).toHaveLength(1);

    first.resolve({
      text: "First transcript",
      outputPath: "SystemSculpt/Recordings/first - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();
    await flush();

    expect(mockTranscriptionStart).toHaveBeenCalledTimes(2);
    expect(mockTranscriptionStart.mock.calls[1][0]).toEqual(expect.objectContaining({
      filePath: "SystemSculpt/Recordings/manual.webm",
    }));
    second.resolve({
      text: "Manual transcript",
      outputPath: "SystemSculpt/Recordings/manual - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();
  });

  it("reports saved-with-warning when the initiating chat no longer accepts dictation", async () => {
    const service = RecorderService.getInstance(app, plugin);
    service.onTranscription(() => false);
    (service as any).completedCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/session.webm",
        startedAt: 1_000,
        durationMs: 3_000,
        sizeBytes: 32_000,
        stopReason: "manual",
      },
      origin: {
        leaf: { view: { getViewType: () => CHAT_VIEW_TYPE } },
        destination: "chat",
        editor: null,
        conversationOriginToken: "conversation-origin-1",
      },
      microphoneLabel: "Default microphone",
    };
    mockTranscriptionStart.mockReturnValue({
      promise: Promise.resolve({
        text: "Dictated message",
        outputPath: "SystemSculpt/Recordings/session - transcript.md",
        sourceDisposition: "kept",
        insertedIntoOrigin: false,
      }),
      cancel: jest.fn(),
    });

    await (service as any).transcribeSavedRecording();

    expect((service as any).state).toBe("warning");
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "warning",
      status: expect.stringContaining("chat where recording started changed or closed"),
    }));
  });

  it("opens the completed transcript in a focused tab", async () => {
    const output = new TFile({ path: "SystemSculpt/Recordings/session - transcript.md" });
    const leaf = { openFile: jest.fn().mockResolvedValue(undefined) };
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(output);
    (app.workspace as any).getLeaf = jest.fn().mockReturnValue(leaf);
    (app.workspace as any).setActiveLeaf = jest.fn();

    const service = RecorderService.getInstance(app, plugin);
    const running = service.toggleRecording();
    await flush();
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      microphoneLabel: "Default microphone",
    });
    await running;
    harness.setRecording(false);
    harness.completion.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 32_000,
      stopReason: "manual",
    });
    await flush();
    (service as any).outputPath = output.path;

    const actions = mockUiInstances[0].open.mock.calls[0][0];
    actions.onOpenOutput();
    await flush();

    expect(leaf.openFile).toHaveBeenCalledWith(output);
    expect((app.workspace as any).setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
  });

  it("shows Stop waiting immediately and retries preserved processing with the same operation", async () => {
    const service = RecorderService.getInstance(app, plugin);
    (service as any).completedCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/session.webm",
        startedAt: 1_000,
        durationMs: 3_000,
        sizeBytes: 32_000,
        stopReason: "manual",
      },
      origin: {
        leaf: null,
        destination: "note",
        editor: null,
        conversationOriginToken: null,
        hostDocument: document,
      },
      microphoneLabel: "Default microphone",
    };
    const first = deferred<any>();
    const cancel = jest.fn();
    mockTranscriptionStart.mockReturnValueOnce({
      operationId: "preserved-op",
      promise: first.promise,
      cancel,
    });
    const running = (service as any).transcribeSavedRecording();
    await flush();

    (service as any).stopWaitingForTranscription();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "warning",
      canRetry: false,
      status: expect.stringContaining("Finishing safe cancellation"),
    }));
    await service.toggleRecording();
    expect(mockSessionInstances).toHaveLength(0);
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      canRetry: false,
      status: expect.stringContaining("Still finishing safe cancellation"),
    }));
    first.reject(new ManagedTranscriptionInterruptedError(
      "preserved-op",
      true,
      "processing",
      "resume",
    ));
    await running;

    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      canRetry: true,
      status: expect.stringContaining("Retry resumes the same operation"),
    }));
    mockTranscriptionStart.mockReturnValueOnce({
      operationId: "preserved-op",
      promise: Promise.resolve({
        text: "Transcript",
        outputPath: "SystemSculpt/Recordings/session - transcript.md",
        sourceDisposition: "kept",
        insertedIntoOrigin: false,
      }),
      cancel: jest.fn(),
    });
    await (service as any).transcribeSavedRecording();
    expect(mockTranscriptionStart.mock.calls[1][0]).toEqual(expect.objectContaining({
      resumeOperationId: "preserved-op",
    }));
  });

  it("disables retry for an ambiguous preserved dispatch instead of launching a duplicate", async () => {
    const service = RecorderService.getInstance(app, plugin);
    (service as any).completedCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/session.webm",
        startedAt: 1_000,
        durationMs: 3_000,
        sizeBytes: 32_000,
        stopReason: "manual",
      },
      origin: { leaf: null, destination: "note", editor: null, conversationOriginToken: null, hostDocument: document },
      microphoneLabel: "Default microphone",
    };
    mockTranscriptionStart.mockReturnValueOnce({
      operationId: "ambiguous-op",
      promise: Promise.reject(new ManagedTranscriptionInterruptedError(
        "ambiguous-op",
        false,
        "create_dispatching",
        "blocked",
      )),
      cancel: jest.fn(),
    });

    await (service as any).transcribeSavedRecording();

    expect((service as any).transcriptionResumeOperationId).toBeNull();
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      canRetry: false,
      status: expect.stringContaining("automatic retry is disabled"),
    }));
    expect(mockTranscriptionStart).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["hidden", "background-hidden", "visibilitychange"],
    ["visible", "background-pagehide", "pageshow"],
  ] as const)("handles %s background auto-transcription without losing the foreground race", async (visibility, stopReason, resumeEvent) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
    plugin.settings.autoTranscribeRecordings = true;
    mockTranscriptionStart.mockReturnValue({
      operationId: "visible-op",
      promise: Promise.resolve({
        text: "Transcript",
        outputPath: "SystemSculpt/Recordings/session - transcript.md",
        sourceDisposition: "kept",
        insertedIntoOrigin: false,
      }),
      cancel: jest.fn(),
    });
    const service = RecorderService.getInstance(app, plugin);
    const running = service.toggleRecording();
    await flush();
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      microphoneLabel: "Default microphone",
    });
    await running;
    harness.setRecording(false);
    harness.completion.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 32_000,
      stopReason,
    });
    await flush();

    expect(mockTranscriptionStart).not.toHaveBeenCalled();
    expect(mockUiInstances[0].render).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "saved",
      status: "Recording saved. Transcription will start when Obsidian returns.",
    }));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    if (resumeEvent === "pageshow") window.dispatchEvent(new Event("pageshow"));
    else document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(mockTranscriptionStart).toHaveBeenCalledTimes(1);
  });

  it("reoffers a durably saved automatic recording after a plugin/process restart", async () => {
    const source = new TFile({
      path: "SystemSculpt/Recordings/recovered.webm",
      stat: { size: 24_000 },
    });
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
      (path: string) => path === source.path ? source : null,
    );
    plugin.settings.autoTranscribeRecordings = true;
    plugin.settings.pendingRecorderCaptures = [{
      filePath: source.path,
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 24_000,
      stopReason: "background-hidden",
      destination: "note",
      operationId: "persisted-recorder-op",
    }];
    const acknowledgeCompletion = jest.fn().mockResolvedValue(undefined);
    mockTranscriptionStart.mockReturnValue({
      operationId: "persisted-recorder-op",
      promise: Promise.resolve({
        text: "Recovered transcript",
        outputPath: "SystemSculpt/Recordings/recovered - transcript.md",
        sourceDisposition: "kept",
        insertedIntoOrigin: false,
        acknowledgeCompletion,
      }),
      cancel: jest.fn(),
    });

    const service = RecorderService.getInstance(app, plugin);
    service.recoverPendingCaptures();
    await flush();
    await flush();

    expect(mockTranscriptionStart).toHaveBeenCalledWith(expect.objectContaining({
      filePath: source.path,
      destination: "note",
      callerScope: "recorder/note-dictation",
      sourceOwnership: "recorder-capture",
      resumeOperationId: "persisted-recorder-op",
    }));
    expect(plugin.settings.pendingRecorderCaptures).toEqual([]);
    expect(acknowledgeCompletion).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a completed recorder operation only after pending capture state is durably cleared", async () => {
    const events: string[] = [];
    plugin.settings.autoTranscribeRecordings = true;
    plugin.settings.pendingRecorderCaptures = [{
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 24_000,
      stopReason: "manual",
      destination: "note",
    }];
    plugin.getSettingsManager = jest.fn(() => ({
      updateSettings: jest.fn(async (update: Record<string, unknown>) => {
        const pending = update.pendingRecorderCaptures as unknown[] | undefined;
        if (pending?.length === 0) events.push("pending-cleared");
        Object.assign(plugin.settings, update);
      }),
    }));
    const acknowledgeCompletion = jest.fn(async () => { events.push("acknowledged"); });
    mockTranscriptionStart.mockReturnValue({
      operationId: "fresh-recorder-op",
      promise: Promise.resolve({
        operationId: "fresh-recorder-op",
        text: "Transcript",
        outputPath: "SystemSculpt/Recordings/session - transcript.md",
        sourceDisposition: "kept",
        insertedIntoOrigin: false,
        acknowledgeCompletion,
      }),
      cancel: jest.fn(),
    });
    const service = RecorderService.getInstance(app, plugin);
    (service as any).completedCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/session.webm",
        startedAt: 1_000,
        durationMs: 3_000,
        sizeBytes: 24_000,
        stopReason: "manual",
      },
      origin: { leaf: null, destination: "note", editor: null, conversationOriginToken: null, hostDocument: document },
      microphoneLabel: "Default microphone",
    };

    await (service as any).transcribeSavedRecording();

    expect(events).toEqual(["pending-cleared", "acknowledged"]);
  });

  it("keeps the completed recovery receipt when pending capture state cannot be cleared", async () => {
    plugin.settings.autoTranscribeRecordings = true;
    plugin.settings.pendingRecorderCaptures = [{
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 24_000,
      stopReason: "manual",
      destination: "note",
    }];
    plugin.getSettingsManager = jest.fn(() => ({
      updateSettings: jest.fn(async () => { throw new Error("settings unavailable"); }),
    }));
    const acknowledgeCompletion = jest.fn().mockResolvedValue(undefined);
    mockTranscriptionStart.mockReturnValue({
      operationId: "uncleared-recorder-op",
      promise: Promise.resolve({
        operationId: "uncleared-recorder-op",
        text: "Transcript",
        outputPath: "SystemSculpt/Recordings/session - transcript.md",
        sourceDisposition: "kept",
        insertedIntoOrigin: false,
        acknowledgeCompletion,
      }),
      cancel: jest.fn(),
    });
    const service = RecorderService.getInstance(app, plugin);
    (service as any).completedCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/session.webm",
        startedAt: 1_000,
        durationMs: 3_000,
        sizeBytes: 24_000,
        stopReason: "manual",
      },
      origin: { leaf: null, destination: "note", editor: null, conversationOriginToken: null, hostDocument: document },
      microphoneLabel: "Default microphone",
    };

    await (service as any).transcribeSavedRecording();

    expect(acknowledgeCompletion).not.toHaveBeenCalled();
  });

  it("uses a missing recorder source's operation ID to prune a completed receipt before forgetting it", async () => {
    const events: string[] = [];
    plugin.settings.autoTranscribeRecordings = true;
    plugin.settings.pendingRecorderCaptures = [{
      filePath: "SystemSculpt/Recordings/trashed.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 24_000,
      stopReason: "manual",
      destination: "note",
      operationId: "completed-before-crash",
    }];
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    mockTranscriptionAcknowledgeCompleted.mockImplementation(async () => {
      events.push("acknowledged");
    });
    plugin.getSettingsManager = jest.fn(() => ({
      updateSettings: jest.fn(async (update: Record<string, unknown>) => {
        const pending = update.pendingRecorderCaptures as unknown[] | undefined;
        if (pending?.length === 0) events.push("pending-forgotten");
        Object.assign(plugin.settings, update);
      }),
    }));

    RecorderService.getInstance(app, plugin).recoverPendingCaptures();
    await flush();

    expect(mockTranscriptionAcknowledgeCompleted).toHaveBeenCalledWith("completed-before-crash");
    expect(events).toEqual(["acknowledged", "pending-forgotten"]);
    expect(mockTranscriptionStart).not.toHaveBeenCalled();
  });

  it("keeps missing-source pending state when its completion acknowledgment fails", async () => {
    plugin.settings.autoTranscribeRecordings = true;
    plugin.settings.pendingRecorderCaptures = [{
      filePath: "SystemSculpt/Recordings/trashed.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 24_000,
      stopReason: "manual",
      destination: "note",
      operationId: "not-completed-yet",
    }];
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    mockTranscriptionAcknowledgeCompleted.mockRejectedValue(
      new Error("completion is not durable"),
    );
    const updateSettings = jest.fn(async (update: Record<string, unknown>) => {
      Object.assign(plugin.settings, update);
    });
    plugin.getSettingsManager = jest.fn(() => ({ updateSettings }));

    RecorderService.getInstance(app, plugin).recoverPendingCaptures();
    await flush();

    expect(mockTranscriptionAcknowledgeCompleted).toHaveBeenCalledWith("not-completed-yet");
    expect(updateSettings).not.toHaveBeenCalled();
    expect(plugin.settings.pendingRecorderCaptures).toHaveLength(1);
    expect(mockTranscriptionStart).not.toHaveBeenCalled();
  });

  it("drains a newly saved capture after startup recovery without overlapping uploads", async () => {
    const recoveredSource = new TFile({
      path: "SystemSculpt/Recordings/recovered.webm",
      stat: { size: 24_000 },
    });
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
      (path: string) => path === recoveredSource.path ? recoveredSource : null,
    );
    plugin.settings.autoTranscribeRecordings = true;
    plugin.settings.pendingRecorderCaptures = [{
      filePath: recoveredSource.path,
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 24_000,
      stopReason: "background-hidden",
      destination: "note",
    }];
    const recovery = deferred<any>();
    const live = deferred<any>();
    mockTranscriptionStart
      .mockReturnValueOnce({
        operationId: "recovery-op",
        promise: recovery.promise,
        cancel: jest.fn(),
      })
      .mockReturnValueOnce({
        operationId: "live-op",
        promise: live.promise,
        cancel: jest.fn(),
      });

    const service = RecorderService.getInstance(app, plugin);
    service.recoverPendingCaptures();
    await flush();
    expect(mockTranscriptionStart).toHaveBeenCalledTimes(1);

    (service as any).completedCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/live.webm",
        startedAt: 4_000,
        durationMs: 2_000,
        sizeBytes: 20_000,
        stopReason: "manual",
      },
      origin: { leaf: null, destination: "note", editor: null, conversationOriginToken: null, hostDocument: document },
      microphoneLabel: "Default microphone",
    };
    (service as any).state = "saved";
    void (service as any).transcribeSavedRecording();
    await flush();
    expect(mockTranscriptionStart).toHaveBeenCalledTimes(1);
    expect((service as any).queuedTranscriptions).toHaveLength(1);

    recovery.resolve({
      text: "Recovered transcript",
      outputPath: "SystemSculpt/Recordings/recovered - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();
    await flush();

    expect(mockTranscriptionStart).toHaveBeenCalledTimes(2);
    expect(mockTranscriptionStart.mock.calls[1][0]).toEqual(expect.objectContaining({
      filePath: "SystemSculpt/Recordings/live.webm",
    }));

    live.resolve({
      text: "Live transcript",
      outputPath: "SystemSculpt/Recordings/live - transcript.md",
      sourceDisposition: "kept",
      insertedIntoOrigin: false,
    });
    await flush();
  });

  it("keeps scanning pending recordings when starting one recovery throws synchronously", async () => {
    const first = new TFile({
      path: "SystemSculpt/Recordings/first.webm",
      stat: { size: 24_000 },
    });
    const second = new TFile({
      path: "SystemSculpt/Recordings/second.webm",
      stat: { size: 25_000 },
    });
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
      (path: string) => path === first.path ? first : path === second.path ? second : null,
    );
    plugin.settings.autoTranscribeRecordings = true;
    plugin.settings.pendingRecorderCaptures = [first, second].map((source) => ({
      filePath: source.path,
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: source.stat.size,
      stopReason: "background-hidden",
      destination: "note",
    }));
    mockTranscriptionStart
      .mockImplementationOnce(() => { throw new Error("service still loading"); })
      .mockReturnValueOnce({
        operationId: "second-op",
        promise: Promise.resolve({
          text: "Recovered transcript",
          outputPath: "SystemSculpt/Recordings/second - transcript.md",
          sourceDisposition: "kept",
          insertedIntoOrigin: false,
        }),
        cancel: jest.fn(),
      });

    RecorderService.getInstance(app, plugin).recoverPendingCaptures();
    await flush();
    await flush();

    expect(mockTranscriptionStart).toHaveBeenCalledTimes(2);
    expect(plugin.settings.pendingRecorderCaptures).toEqual([
      expect.objectContaining({ filePath: first.path }),
    ]);
  });

  it("fails closed instead of retranscribing conflicting synced recovery entries", async () => {
    plugin.settings.autoTranscribeRecordings = true;
    plugin.settings.pendingRecorderCaptures = [{
      filePath: "SystemSculpt/Recordings/conflict.webm",
      startedAt: 1_000,
      durationMs: 3_000,
      sizeBytes: 24_000,
      stopReason: "background-hidden",
      destination: "note",
      recoveryBlocked: "conflicting-operation-ids",
    }];

    RecorderService.getInstance(app, plugin).recoverPendingCaptures();
    await flush();

    expect(mockTranscriptionStart).not.toHaveBeenCalled();
    expect(plugin.settings.pendingRecorderCaptures).toHaveLength(1);
  });

  it("retries local transcript-finishing failures with the existing remote operation", async () => {
    const service = RecorderService.getInstance(app, plugin);
    mockUiInstances[0].isVisible.mockReturnValue(false);
    (service as any).completedCapture = {
      result: {
        filePath: "SystemSculpt/Recordings/session.webm",
        startedAt: 1_000,
        durationMs: 3_000,
        sizeBytes: 32_000,
        stopReason: "manual",
      },
      origin: { leaf: null, destination: "note", editor: null, conversationOriginToken: null, hostDocument: document },
      microphoneLabel: "Default microphone",
    };
    mockTranscriptionStart.mockReturnValueOnce({
      operationId: "local-failure-op",
      promise: Promise.reject(new TranscriptionResumeRequiredError(
        "local-failure-op",
        new Error("disk full"),
      )),
      cancel: jest.fn(),
    });

    await (service as any).transcribeSavedRecording();
    expect((service as any).transcriptionResumeOperationId).toBe("local-failure-op");
    expect(mockUiInstances[0].open).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        canRetry: true,
        status: expect.stringContaining("Retry resumes the same server operation"),
      }),
    );
    await service.toggleRecording();
    expect(mockSessionInstances).toHaveLength(0);
    expect((service as any).transcriptionResumeOperationId).toBe("local-failure-op");
  });

  it("stops active capture and scoped transcription during unload", async () => {
    const service = RecorderService.getInstance(app, plugin);
    const running = service.toggleRecording();
    await flush();
    harness.setRecording(true);
    harness.start.resolve({
      filePath: "SystemSculpt/Recordings/session.webm",
      startedAt: 1_000,
      microphoneLabel: "Default microphone",
    });
    await running;

    const cancel = jest.fn();
    const activeTask = { promise: new Promise(() => undefined), cancel };
    (service as any).transcriptionTask = activeTask;
    (service as any).transcriptionTasks.add(activeTask);
    service.unload();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(harness.session.stop).toHaveBeenCalledWith("interrupted");
    expect(mockUiInstances[0].close).toHaveBeenCalled();
  });
});
