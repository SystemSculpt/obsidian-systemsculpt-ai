/**
 * @jest-environment node
 */

import type { App } from "obsidian";
import {
  MAX_ENCODED_CAPTURE_BYTES,
  RECORDER_STOP_WATCHDOG_MS,
  RecordingSession,
  STREAMED_MAX_ENCODED_CAPTURE_BYTES,
  canStreamRecordingToDisk,
  type RecordingSessionOptions,
} from "../RecordingSession";

class FakeAudioTrack extends EventTarget {
  public readonly label = "Phone microphone";
  public readonly stop = jest.fn();
}

class FakeMediaStream {
  constructor(public readonly track = new FakeAudioTrack()) {}

  public getAudioTracks(): MediaStreamTrack[] {
    return [this.track as unknown as MediaStreamTrack];
  }

  public getTracks(): MediaStreamTrack[] {
    return this.getAudioTracks();
  }
}

class FakeMediaRecorder {
  public static instances: FakeMediaRecorder[] = [];
  public static attempts: Array<MediaRecorderOptions | undefined> = [];
  public static reportedMimeType = "audio/webm;codecs=opus";
  public static chunkMimeType = "audio/webm;codecs=opus";
  public static rejectConfiguredConstructors = false;
  public static emitAudioOnStop = true;
  public static emitStopEvent = true;

  public state: RecordingState = "inactive";
  public readonly mimeType: string;
  public ondataavailable: ((event: BlobEvent) => void) | null = null;
  public onstop: (() => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public readonly start = jest.fn((interval?: number) => {
    void interval;
    this.state = "recording";
  });
  public readonly requestData = jest.fn();
  public readonly stop = jest.fn(() => {
    if (this.state === "inactive") return;
    this.state = "inactive";
    if (FakeMediaRecorder.emitAudioOnStop) {
      this.emitChunk(4);
    }
    if (FakeMediaRecorder.emitStopEvent) this.onstop?.();
  });

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    FakeMediaRecorder.attempts.push(options);
    if (options && FakeMediaRecorder.rejectConfiguredConstructors) {
      throw new TypeError("Configured recording is not supported");
    }
    this.mimeType = FakeMediaRecorder.reportedMimeType;
    FakeMediaRecorder.instances.push(this);
  }

  public interrupt(): void {
    this.onerror?.(Object.assign(new Event("error"), { error: new Error("track lost") }));
  }

  public emitChunk(size: number): void {
    const data = new Blob([new Uint8Array(size)], {
      type: FakeMediaRecorder.chunkMimeType,
    });
    this.ondataavailable?.({ data } as BlobEvent);
  }

  public static reset(): void {
    this.instances = [];
    this.attempts = [];
    this.reportedMimeType = "audio/webm;codecs=opus";
    this.chunkMimeType = "audio/webm;codecs=opus";
    this.rejectConfiguredConstructors = false;
    this.emitAudioOnStop = true;
    this.emitStopEvent = true;
  }
}

class FakeHostDocument extends EventTarget {
  public hidden = false;
}

class TrackingBlob extends Blob {
  public static createdTypes: string[] = [];

  constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    TrackingBlob.createdTypes.push(options?.type ?? "");
  }
}

interface WakeLockHarness {
  sentinel: {
    released: boolean;
    release: jest.Mock<Promise<void>, []>;
    addEventListener: jest.Mock<void, [string, () => void, AddEventListenerOptions?]>;
  };
  request: jest.Mock<Promise<WakeLockHarness["sentinel"]>, ["screen"]>;
}

interface SessionHarness {
  app: App;
  createBinary: jest.Mock;
  exists: jest.Mock;
  document: FakeHostDocument;
  hostWindow: Window;
  stream: FakeMediaStream;
  getUserMedia: jest.Mock;
  ensureDirectory: jest.Mock;
  onStatus: jest.Mock;
  wakeLock: WakeLockHarness;
  session: RecordingSession;
}

function createWakeLockHarness(): WakeLockHarness {
  const releaseListeners = new Set<() => void>();
  const sentinel = {
    released: false,
    release: jest.fn(async () => {
      if (sentinel.released) return;
      sentinel.released = true;
      for (const listener of releaseListeners) listener();
    }),
    addEventListener: jest.fn((_type: string, listener: () => void) => {
      releaseListeners.add(listener);
    }),
  };
  return {
    sentinel,
    request: jest.fn().mockResolvedValue(sentinel),
  };
}

function createHarness(
  overrides: Partial<RecordingSessionOptions> = {},
  adapterExtras: Record<string, unknown> = {},
  vaultExtras: Record<string, unknown> = {},
): SessionHarness {
  const hostDocument = new FakeHostDocument();
  const stream = new FakeMediaStream();
  const getUserMedia = jest.fn().mockResolvedValue(stream as unknown as MediaStream);
  const wakeLock = createWakeLockHarness();
  const hostWindow = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(hostWindow, {
    navigator: {
      mediaDevices: { getUserMedia },
      wakeLock: { request: wakeLock.request },
    },
    MediaRecorder: FakeMediaRecorder,
    Blob: TrackingBlob,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });

  const createBinary = jest.fn().mockResolvedValue({ path: "created" });
  const exists = jest.fn(async (path: string) => path === "SystemSculpt/Recordings");
  const app = {
    vault: {
      adapter: { exists, ...adapterExtras },
      createBinary,
      ...vaultExtras,
    },
  } as unknown as App;
  const ensureDirectory = jest.fn().mockResolvedValue(undefined);
  const onStatus = jest.fn();
  const options: RecordingSessionOptions = {
    app,
    directoryPath: "SystemSculpt/Recordings",
    ensureDirectory,
    format: { mimeType: "audio/webm;codecs=opus", extension: "webm" },
    preferredMicrophoneId: null,
    hostContext: {
      host: {} as HTMLElement,
      hostDocument: hostDocument as unknown as Document,
      hostWindow: hostWindow as unknown as Window,
    },
    onStatus,
    ...overrides,
  };

  return {
    app,
    createBinary,
    exists,
    document: hostDocument,
    hostWindow: hostWindow as unknown as Window,
    stream,
    getUserMedia,
    ensureDirectory,
    onStatus,
    wakeLock,
    session: new RecordingSession(options),
  };
}

function recorder(): FakeMediaRecorder {
  const instance = FakeMediaRecorder.instances.at(-1);
  if (!instance) throw new Error("Expected a MediaRecorder instance");
  return instance;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RecordingSession mobile lifecycle", () => {
  beforeEach(() => {
    jest.useRealTimers();
    FakeMediaRecorder.reset();
    TrackingBlob.createdTypes = [];
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("uses the initiating window for capture, recorder construction, timers, Blob, and wake lock", async () => {
    const harness = createHarness();

    const started = await harness.session.start();
    await flushMicrotasks();

    expect(harness.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    expect(recorder().start).toHaveBeenCalledWith(1_000);
    expect(harness.wakeLock.request).toHaveBeenCalledWith("screen");
    expect(started.microphoneLabel).toBe("Phone microphone");

    const result = await harness.session.stop();
    expect(TrackingBlob.createdTypes).toEqual(["audio/webm;codecs=opus"]);
    expect(harness.createBinary).toHaveBeenCalledWith(
      result.filePath,
      expect.any(ArrayBuffer),
    );
  });

  it("keeps recording while the user navigates within foreground Obsidian", async () => {
    const harness = createHarness();
    await harness.session.start();
    await flushMicrotasks();

    harness.document.dispatchEvent(new Event("workspace-leaf-change"));
    harness.document.dispatchEvent(new Event("visibilitychange"));

    expect(harness.session.isRecording()).toBe(true);
    expect(recorder().stop).not.toHaveBeenCalled();
    expect(harness.wakeLock.request).toHaveBeenCalledTimes(1);

    await harness.session.stop();
  });

  it("stops immediately on app backgrounding and durably saves captured audio once", async () => {
    const harness = createHarness();
    await harness.session.start();
    await flushMicrotasks();

    harness.document.hidden = true;
    harness.document.dispatchEvent(new Event("visibilitychange"));
    const result = await harness.session.completion;

    expect(result.stopReason).toBe("background-hidden");
    expect(result.sizeBytes).toBe(4);
    expect(harness.createBinary).toHaveBeenCalledTimes(1);
    expect(recorder().requestData).toHaveBeenCalledTimes(1);
    expect(recorder().stop).toHaveBeenCalledTimes(1);
    expect(harness.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.wakeLock.sentinel.release).toHaveBeenCalledTimes(1);
    expect(harness.onStatus).toHaveBeenCalledWith(
      "App moved to the background. Saving captured audio…",
    );

    harness.hostWindow.dispatchEvent(new Event("pagehide"));
    expect(harness.createBinary).toHaveBeenCalledTimes(1);
    expect(recorder().stop).toHaveBeenCalledTimes(1);
  });

  it("uses pagehide as a second mobile teardown signal and saves the partial recording", async () => {
    const harness = createHarness();
    await harness.session.start();

    harness.hostWindow.dispatchEvent(new Event("pagehide"));
    const result = await harness.session.completion;

    expect(result.stopReason).toBe("background-pagehide");
    expect(harness.createBinary).toHaveBeenCalledTimes(1);
  });

  it("saves partial audio when the microphone track ends while Obsidian remains visible", async () => {
    const harness = createHarness();
    await harness.session.start();

    harness.stream.track.dispatchEvent(new Event("ended"));
    const result = await harness.session.completion;

    expect(result.stopReason).toBe("interrupted");
    expect(harness.onStatus).toHaveBeenCalledWith(
      "Microphone interrupted. Saving captured audio…",
    );
    expect(harness.createBinary).toHaveBeenCalledTimes(1);
  });

  it("does not start an invisible recording if permission resolves after Obsidian is backgrounded", async () => {
    const microphone = deferred<MediaStream>();
    const harness = createHarness();
    harness.getUserMedia.mockReturnValueOnce(microphone.promise);
    const completion = harness.session.completion.catch((error: unknown) => error);
    const start = harness.session.start();
    await flushMicrotasks();

    harness.document.hidden = true;
    microphone.resolve(harness.stream as unknown as MediaStream);

    await expect(start).rejects.toMatchObject({
      name: "AbortError",
      message: "Recording did not start because Obsidian moved to the background.",
    });
    await expect(completion).resolves.toMatchObject({ name: "AbortError" });
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(harness.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.createBinary).not.toHaveBeenCalled();
  });

  it("keeps startup cancelled after background then foreground and stops the late stream", async () => {
    const microphone = deferred<MediaStream>();
    const harness = createHarness();
    harness.getUserMedia.mockReturnValueOnce(microphone.promise);
    const completion = harness.session.completion.catch((error: unknown) => error);
    const start = harness.session.start().catch((error: unknown) => error);
    await flushMicrotasks();

    harness.document.hidden = true;
    harness.document.dispatchEvent(new Event("visibilitychange"));
    harness.document.hidden = false;
    harness.document.dispatchEvent(new Event("visibilitychange"));

    await expect(start).resolves.toMatchObject({
      name: "AbortError",
      message: "Recording did not start because Obsidian moved to the background.",
    });
    await expect(completion).resolves.toMatchObject({ name: "AbortError" });

    microphone.resolve(harness.stream as unknown as MediaStream);
    await flushMicrotasks();
    expect(harness.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it("cancels a pending microphone prompt immediately and stops any stream that resolves later", async () => {
    const microphone = deferred<MediaStream>();
    const harness = createHarness();
    harness.getUserMedia.mockReturnValueOnce(microphone.promise);
    const completion = harness.session.completion.catch((error: unknown) => error);
    const start = harness.session.start().catch((error: unknown) => error);
    await flushMicrotasks();

    harness.session.dispose();

    await expect(completion).resolves.toMatchObject({
      name: "AbortError",
      message: "Recording was cancelled.",
    });
    await expect(start).resolves.toMatchObject({
      name: "AbortError",
      message: "Recording was cancelled.",
    });
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    microphone.resolve(harness.stream as unknown as MediaStream);
    await flushMicrotasks();
    expect(harness.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.createBinary).not.toHaveBeenCalled();
  });

  it("lets the user take time to answer the native microphone permission prompt", async () => {
    jest.useFakeTimers();
    const harness = createHarness();
    harness.getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((resolve) => {
      globalThis.setTimeout(
        () => resolve(harness.stream as unknown as MediaStream),
        30_000,
      );
    }));

    const start = harness.session.start();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(30_000);

    await expect(start).resolves.toMatchObject({ microphoneLabel: "Phone microphone" });
    await harness.session.stop();
  });

  it("does not open a microphone prompt after cancellation during folder preparation", async () => {
    const folderPreparation = deferred<void>();
    const ensureDirectory = jest.fn(() => folderPreparation.promise);
    const harness = createHarness({ ensureDirectory });
    const completion = harness.session.completion.catch((error: unknown) => error);
    const start = harness.session.start().catch((error: unknown) => error);
    await flushMicrotasks();

    harness.session.dispose();
    await expect(completion).resolves.toMatchObject({ name: "AbortError" });
    folderPreparation.resolve(undefined);
    await expect(start).resolves.toMatchObject({ name: "AbortError" });

    expect(ensureDirectory).toHaveBeenCalledTimes(1);
    expect(harness.getUserMedia).not.toHaveBeenCalled();
  });

  it("settles both start and completion when microphone permission fails", async () => {
    const harness = createHarness();
    const permissionError = Object.assign(new Error("Permission denied"), {
      name: "NotAllowedError",
    });
    harness.getUserMedia.mockRejectedValueOnce(permissionError);
    const completion = harness.session.completion.catch((error: unknown) => error);

    await expect(harness.session.start()).rejects.toThrow(
      "Microphone access is blocked. Allow it in Obsidian or system settings, then try again.",
    );
    await expect(completion).resolves.toMatchObject({
      message: "Microphone access is blocked. Allow it in Obsidian or system settings, then try again.",
    });
    expect(harness.stream.track.stop).not.toHaveBeenCalled();
  });

  it("falls back from a missing saved microphone to the default device", async () => {
    const harness = createHarness({ preferredMicrophoneId: "removed-device" });
    const missingDevice = Object.assign(new Error("Device not found"), {
      name: "NotFoundError",
    });
    harness.getUserMedia
      .mockRejectedValueOnce(missingDevice)
      .mockResolvedValueOnce(harness.stream as unknown as MediaStream);

    await harness.session.start();

    expect(harness.getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: expect.objectContaining({ deviceId: { exact: "removed-device" } }),
    });
    expect(harness.getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: expect.not.objectContaining({ deviceId: expect.anything() }),
    });
    expect(harness.onStatus).toHaveBeenCalledWith(
      "Saved microphone unavailable. Trying the default microphone…",
    );
    await harness.session.stop();
  });

  it("falls back when a mobile WebView rejects the saved device constraint", async () => {
    const harness = createHarness({ preferredMicrophoneId: "desktop-device-id" });
    harness.getUserMedia
      .mockRejectedValueOnce(new TypeError("Exact device constraints are unsupported"))
      .mockResolvedValueOnce(harness.stream as unknown as MediaStream);

    await harness.session.start();

    expect(harness.getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: expect.objectContaining({ deviceId: { exact: "desktop-device-id" } }),
    });
    expect(harness.getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: expect.not.objectContaining({ deviceId: expect.anything() }),
    });
    expect(harness.onStatus).toHaveBeenCalledWith(
      "Saved microphone unavailable. Trying the default microphone…",
    );
    await harness.session.stop();
  });

  it("uses the recorder-reported MP4 container and writes an indexed .m4a vault file", async () => {
    FakeMediaRecorder.rejectConfiguredConstructors = true;
    FakeMediaRecorder.reportedMimeType = "audio/mp4;codecs=mp4a.40.2";
    FakeMediaRecorder.chunkMimeType = "audio/mp4;codecs=mp4a.40.2";
    const harness = createHarness();

    const started = await harness.session.start();
    const result = await harness.session.stop();

    expect(FakeMediaRecorder.attempts).toEqual([
      { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 96_000 },
      { mimeType: "audio/webm;codecs=opus" },
      undefined,
    ]);
    expect(started.filePath).toMatch(/\.m4a$/);
    expect(result.filePath).toBe(started.filePath);
    expect(TrackingBlob.createdTypes).toEqual(["audio/mp4;codecs=mp4a.40.2"]);
    expect(harness.createBinary).toHaveBeenCalledWith(
      expect.stringMatching(/\.m4a$/),
      expect.any(ArrayBuffer),
    );
  });

  it("releases a wake lock that arrives after recording already stopped", async () => {
    const wakeRequest = deferred<WakeLockHarness["sentinel"]>();
    const harness = createHarness();
    harness.wakeLock.request.mockReturnValueOnce(wakeRequest.promise);
    await harness.session.start();

    const completion = harness.session.stop();
    harness.document.dispatchEvent(new Event("visibilitychange"));
    expect(harness.wakeLock.request).toHaveBeenCalledTimes(1);
    wakeRequest.resolve(harness.wakeLock.sentinel);
    await completion;
    await flushMicrotasks();

    expect(harness.wakeLock.sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("keeps recording when screen wake lock is unavailable", async () => {
    const harness = createHarness();
    harness.wakeLock.request.mockRejectedValueOnce(new Error("Wake lock unavailable"));

    await harness.session.start();
    await flushMicrotasks();

    expect(harness.session.isRecording()).toBe(true);
    await expect(harness.session.stop()).resolves.toMatchObject({ stopReason: "manual" });
  });

  it("finalizes through an owner-window watchdog when MediaRecorder never emits stop", async () => {
    jest.useFakeTimers();
    FakeMediaRecorder.emitStopEvent = false;
    const harness = createHarness();
    const setTimeout = jest.spyOn(harness.hostWindow, "setTimeout");
    await harness.session.start();

    const completion = harness.session.stop();
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), RECORDER_STOP_WATCHDOG_MS);
    expect(harness.createBinary).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(RECORDER_STOP_WATCHDOG_MS);
    await expect(completion).resolves.toMatchObject({
      stopReason: "manual",
      sizeBytes: 4,
    });
    expect(harness.createBinary).toHaveBeenCalledTimes(1);
    expect(harness.stream.track.stop).toHaveBeenCalledTimes(1);
  });

  it("ignores late recorder data after watchdog finalization starts", async () => {
    jest.useFakeTimers();
    FakeMediaRecorder.emitStopEvent = false;
    const write = deferred<{ path: string }>();
    const harness = createHarness();
    harness.createBinary.mockReturnValueOnce(write.promise);
    await harness.session.start();
    const mediaRecorder = recorder();
    const lateDataHandler = mediaRecorder.ondataavailable;
    if (!lateDataHandler) throw new Error("Expected a recorder data handler");

    const completion = harness.session.stop();
    await jest.advanceTimersByTimeAsync(RECORDER_STOP_WATCHDOG_MS);
    lateDataHandler({
      data: new Blob([new Uint8Array(12)], { type: FakeMediaRecorder.chunkMimeType }),
    } as BlobEvent);
    write.resolve({ path: "created" });

    await expect(completion).resolves.toMatchObject({ sizeBytes: 4 });
    expect(harness.createBinary).toHaveBeenCalledTimes(1);
    expect(mediaRecorder.ondataavailable).toBeNull();
    expect(mediaRecorder.onstop).toBeNull();
    expect(mediaRecorder.onerror).toBeNull();
  });

  it("does not let dispose discard a background recording that is already stopping", async () => {
    jest.useFakeTimers();
    FakeMediaRecorder.emitStopEvent = false;
    const harness = createHarness();
    await harness.session.start();

    harness.document.hidden = true;
    harness.document.dispatchEvent(new Event("visibilitychange"));
    harness.session.dispose();
    expect(harness.createBinary).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(RECORDER_STOP_WATCHDOG_MS);
    await expect(harness.session.completion).resolves.toMatchObject({
      stopReason: "background-hidden",
      sizeBytes: 4,
    });
    expect(harness.createBinary).toHaveBeenCalledTimes(1);
  });

  it("does not let dispose interrupt an in-flight vault write", async () => {
    const write = deferred<{ path: string }>();
    const harness = createHarness();
    harness.createBinary.mockReturnValueOnce(write.promise);
    await harness.session.start();

    const completion = harness.session.stop();
    await flushMicrotasks();
    harness.session.dispose();
    expect(harness.stream.track.stop).not.toHaveBeenCalled();

    write.resolve({ path: "created" });
    await expect(completion).resolves.toMatchObject({ sizeBytes: 4 });
    expect(harness.stream.track.stop).toHaveBeenCalledTimes(1);
  });

  it("measures duration at capture stop instead of after slow storage", async () => {
    const write = deferred<{ path: string }>();
    const harness = createHarness();
    harness.createBinary.mockReturnValueOnce(write.promise);
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000);
    await harness.session.start();

    now.mockReturnValue(4_000);
    const completion = harness.session.stop();
    now.mockReturnValue(94_000);
    write.resolve({ path: "created" });

    await expect(completion).resolves.toMatchObject({ durationMs: 3_000 });
  });

  it("retains prepared audio after createBinary fails and clears it after Retry save", async () => {
    const harness = createHarness();
    harness.createBinary
      .mockRejectedValueOnce(new Error("Storage is full"))
      .mockResolvedValueOnce({ path: "created" });
    await harness.session.start();

    await expect(harness.session.stop()).rejects.toThrow(
      "Audio is still in memory, but it could not be saved: Storage is full",
    );
    expect(harness.session.hasPendingSave()).toBe(true);
    const pending = harness.session.getPendingSaveResult();
    expect(pending).toMatchObject({ sizeBytes: 4, stopReason: "manual" });

    await expect(harness.session.retrySave()).resolves.toEqual(pending);
    expect(harness.createBinary).toHaveBeenCalledTimes(2);
    expect(harness.session.hasPendingSave()).toBe(false);
    expect(harness.session.getPendingSaveResult()).toBeNull();
  });

  it("uses a collision-safe sibling with the actual extension when Retry save finds an occupied path", async () => {
    FakeMediaRecorder.rejectConfiguredConstructors = true;
    FakeMediaRecorder.reportedMimeType = "audio/mp4";
    FakeMediaRecorder.chunkMimeType = "audio/mp4";
    const harness = createHarness();
    harness.createBinary
      .mockRejectedValueOnce(new Error("File already exists"))
      .mockResolvedValueOnce({ path: "created" });
    const started = await harness.session.start();
    await expect(harness.session.stop()).rejects.toThrow("File already exists");
    harness.exists.mockImplementation(async (path: string) =>
      path === "SystemSculpt/Recordings" || path === started.filePath
    );

    const result = await harness.session.retrySave();

    expect(result.filePath).not.toBe(started.filePath);
    expect(result.filePath).toMatch(/-1\.m4a$/);
    expect(harness.createBinary).toHaveBeenLastCalledWith(
      result.filePath,
      expect.any(ArrayBuffer),
    );
  });

  it("clears retained bytes when a failed save session is disposed", async () => {
    const harness = createHarness();
    harness.createBinary.mockRejectedValueOnce(new Error("Storage is full"));
    await harness.session.start();
    await expect(harness.session.stop()).rejects.toThrow("still in memory");
    expect(harness.session.hasPendingSave()).toBe(true);

    harness.session.dispose();

    expect(harness.session.hasPendingSave()).toBe(false);
    await expect(harness.session.retrySave()).rejects.toThrow(
      "There is no captured audio waiting to be saved.",
    );
  });

  it("finishes an in-flight Retry save before honoring dispose", async () => {
    const retryWrite = deferred<{ path: string }>();
    const harness = createHarness();
    harness.createBinary
      .mockRejectedValueOnce(new Error("Storage is full"))
      .mockReturnValueOnce(retryWrite.promise);
    await harness.session.start();
    await expect(harness.session.stop()).rejects.toThrow("still in memory");

    const retry = harness.session.retrySave();
    harness.session.dispose();
    expect(harness.session.hasPendingSave()).toBe(false);
    retryWrite.resolve({ path: "created" });

    await expect(retry).resolves.toMatchObject({ sizeBytes: 4 });
    expect(harness.createBinary).toHaveBeenCalledTimes(2);
    expect(harness.session.hasPendingSave()).toBe(false);
  });

  it("auto-stops and saves at the bounded encoded capture limit", async () => {
    const harness = createHarness({ maxEncodedBytes: 6 });
    await harness.session.start();

    recorder().emitChunk(6);
    const result = await harness.session.completion;

    expect(result).toMatchObject({
      stopReason: "size-limit",
      sizeBytes: 6,
    });
    expect(harness.onStatus).toHaveBeenCalledWith(
      "Recording reached the 6 bytes safety limit. Saving captured audio…",
    );
    expect(recorder().stop).toHaveBeenCalledTimes(1);
    expect(MAX_ENCODED_CAPTURE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("reports a save failure instead of creating an empty audio file", async () => {
    FakeMediaRecorder.emitAudioOnStop = false;
    const harness = createHarness();
    await harness.session.start();

    await expect(harness.session.stop()).rejects.toThrow("No audio was captured.");
    expect(harness.createBinary).not.toHaveBeenCalled();
  });
});

describe("RecordingSession streaming to disk", () => {
  const HIDDEN = ".systemsculpt/recordings-in-progress";
  const bytesOf = (buffer: ArrayBuffer): number[] => [...new Uint8Array(buffer)];
  const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

  function emitBytes(values: number[], type = FakeMediaRecorder.chunkMimeType): void {
    recorder().ondataavailable?.({
      data: new Blob([new Uint8Array(values)], { type }),
    } as BlobEvent);
  }

  async function settleWrites(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) await flushMicrotasks();
  }

  /** An adapter that keeps files in memory and supports binary appends. */
  function streamingHarness(overrides: Partial<RecordingSessionOptions> = {}, vaultExtras: Record<string, unknown> = {}) {
    const files = new Map<string, number[]>();
    const folders = new Set<string>(["SystemSculpt", "SystemSculpt/Recordings"]);
    const adapter = {
      mkdir: jest.fn(async (path: string) => { folders.add(path); }),
      writeBinary: jest.fn(async (path: string, data: ArrayBuffer) => { files.set(path, bytesOf(data)); }),
      appendBinary: jest.fn(async (path: string, data: ArrayBuffer) => {
        const current = files.get(path);
        if (!current) throw new Error("missing");
        files.set(path, [...current, ...bytesOf(data)]);
      }),
      rename: jest.fn(async (from: string, to: string) => {
        const current = files.get(from);
        if (!current) throw new Error("missing");
        files.delete(from);
        files.set(to, current);
      }),
      copy: jest.fn(async (from: string, to: string) => { files.set(to, [...(files.get(from) ?? [])]); }),
      remove: jest.fn(async (path: string) => { files.delete(path); }),
    };
    const onCaptureFileCreated = jest.fn();
    const harness = createHarness({ onCaptureFileCreated, ...overrides }, adapter, vaultExtras);
    harness.exists.mockImplementation(async (path: string) => folders.has(path) || files.has(path));
    harness.createBinary.mockImplementation(async (path: string, data: ArrayBuffer) => {
      files.set(path, bytesOf(data));
      return { path };
    });
    return { ...harness, adapter, files, folders, onCaptureFileCreated };
  }

  let now: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.useRealTimers();
    FakeMediaRecorder.reset();
    FakeMediaRecorder.emitAudioOnStop = false;
    TrackingBlob.createdTypes = [];
    now = jest.spyOn(Date, "now").mockReturnValue(10_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("detects binary append support on the vault adapter", () => {
    expect(canStreamRecordingToDisk({ vault: { adapter: {} } } as unknown as App)).toBe(false);
    expect(canStreamRecordingToDisk({ vault: { adapter: { appendBinary: jest.fn() } } } as unknown as App)).toBe(true);
  });

  it("streams into a hidden in-progress file and moves it into the recordings folder at Stop", async () => {
    const harness = streamingHarness();
    const started = await harness.session.start();
    const hidden = `${HIDDEN}/${nameOf(started.filePath)}`;

    emitBytes([1, 2]);
    await settleWrites();
    expect(harness.folders.has(HIDDEN)).toBe(true);
    expect(harness.adapter.writeBinary).toHaveBeenCalledWith(hidden, expect.any(ArrayBuffer));
    expect(harness.onCaptureFileCreated).toHaveBeenCalledWith({
      filePath: hidden,
      startedAt: started.startedAt,
      sizeBytes: 2,
    });

    // Within the flush interval, later audio waits in a small buffer.
    emitBytes([3]);
    emitBytes([4]);
    await settleWrites();
    expect(harness.adapter.appendBinary).not.toHaveBeenCalled();

    now.mockReturnValue(16_000);
    emitBytes([5]);
    await settleWrites();
    expect(harness.adapter.appendBinary).toHaveBeenCalledWith(hidden, expect.any(ArrayBuffer));
    expect(harness.files.get(hidden)).toEqual([1, 2, 3, 4, 5]);

    // Nothing visible to the vault or Obsidian Sync changes while recording.
    expect(harness.createBinary).not.toHaveBeenCalled();
    expect(harness.files.has(started.filePath)).toBe(false);
    for (const [path] of [...harness.adapter.writeBinary.mock.calls, ...harness.adapter.appendBinary.mock.calls]) {
      expect(path.startsWith(`${HIDDEN}/`)).toBe(true);
    }

    emitBytes([6]);
    const result = await harness.session.stop();

    expect(harness.adapter.rename).toHaveBeenCalledWith(hidden, started.filePath);
    expect(result).toMatchObject({ filePath: started.filePath, sizeBytes: 6, stopReason: "manual" });
    expect(harness.files.get(started.filePath)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(harness.files.has(hidden)).toBe(false);
    expect(harness.createBinary).not.toHaveBeenCalled();
    expect(harness.onCaptureFileCreated).toHaveBeenCalledTimes(1);
    expect(harness.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(harness.wakeLock.sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("gives the moved recording a numbered name when the final name is taken", async () => {
    const harness = streamingHarness();
    const started = await harness.session.start();
    harness.files.set(started.filePath, [9]);
    emitBytes([1]);

    const result = await harness.session.stop();

    expect(result.filePath).toBe(started.filePath.replace(/\.webm$/, "-1.webm"));
    expect(harness.files.get(result.filePath)).toEqual([1]);
    expect(harness.files.get(started.filePath)).toEqual([9]);
  });

  it("copies then removes the hidden file when the rename fails", async () => {
    const harness = streamingHarness();
    harness.adapter.rename.mockRejectedValueOnce(new Error("Cross-device link"));
    const started = await harness.session.start();
    emitBytes([1, 2]);

    const result = await harness.session.stop();

    expect(result.filePath).toBe(started.filePath);
    expect(harness.adapter.copy).toHaveBeenCalledWith(`${HIDDEN}/${nameOf(started.filePath)}`, started.filePath);
    expect(harness.files.get(started.filePath)).toEqual([1, 2]);
    expect(harness.files.has(`${HIDDEN}/${nameOf(started.filePath)}`)).toBe(false);
  });

  it("keeps a recording it cannot move in the hidden folder and moves it on Retry save", async () => {
    const harness = streamingHarness();
    harness.adapter.rename.mockRejectedValueOnce(new Error("Locked"));
    harness.adapter.copy.mockRejectedValueOnce(new Error("Locked"));
    const started = await harness.session.start();
    const hidden = `${HIDDEN}/${nameOf(started.filePath)}`;
    emitBytes([1]);

    await expect(harness.session.stop()).rejects.toThrow(
      "The recording is saved in .systemsculpt/recordings-in-progress, but it could not be moved to your recordings folder: Locked",
    );
    expect(harness.files.get(hidden)).toEqual([1]);
    expect(harness.session.hasPendingSave()).toBe(true);

    await expect(harness.session.retrySave()).resolves.toMatchObject({ filePath: started.filePath, sizeBytes: 1 });
    expect(harness.files.get(started.filePath)).toEqual([1]);
    expect(harness.files.has(hidden)).toBe(false);
  });

  it("waits for the vault to index the moved recording before finishing", async () => {
    let created: ((file: { path: string }) => void) | null = null;
    const offref = jest.fn();
    const harness = streamingHarness({}, {
      getAbstractFileByPath: jest.fn(() => null),
      on: jest.fn((_name: string, callback: (file: { path: string }) => void) => { created = callback; return { id: 1 }; }),
      offref,
    });
    const started = await harness.session.start();
    emitBytes([1]);
    let finished = false;
    const stopping = harness.session.stop().then((result) => { finished = true; return result; });
    await settleWrites();
    expect(finished).toBe(false);

    created!({ path: started.filePath });
    await expect(stopping).resolves.toMatchObject({ filePath: started.filePath });
    expect(offref).toHaveBeenCalledWith({ id: 1 });
  });

  it("keeps capturing in memory and saves once at Stop when the adapter cannot append", async () => {
    const onCaptureFileCreated = jest.fn();
    const harness = createHarness({ onCaptureFileCreated });
    await harness.session.start();

    emitBytes([1, 2]);
    emitBytes([3]);
    await settleWrites();
    expect(harness.createBinary).not.toHaveBeenCalled();

    const result = await harness.session.stop();
    expect(harness.createBinary).toHaveBeenCalledTimes(1);
    expect(bytesOf(harness.createBinary.mock.calls[0][1])).toEqual([1, 2, 3]);
    expect(result.sizeBytes).toBe(3);
    expect(onCaptureFileCreated).not.toHaveBeenCalled();
    expect(harness.session.captureLimitBytes).toBe(MAX_ENCODED_CAPTURE_BYTES);
  });

  it("replaces the in-memory bound with a much larger disk bound", async () => {
    const harness = streamingHarness({ maxEncodedBytes: 4, maxStreamedBytes: 12 });
    await harness.session.start();
    expect(harness.session.captureLimitBytes).toBe(12);
    expect(STREAMED_MAX_ENCODED_CAPTURE_BYTES).toBe(512 * 1024 * 1024);

    for (let second = 0; second < 3; second += 1) {
      now.mockReturnValue(10_000 + second * 6_000);
      emitBytes([1, 2, 3]);
      await settleWrites();
    }
    expect(harness.session.isRecording()).toBe(true);

    emitBytes([4, 5, 6]);
    const result = await harness.session.completion;
    expect(result).toMatchObject({ stopReason: "size-limit", sizeBytes: 12 });
    expect(harness.onStatus).toHaveBeenCalledWith(
      "Recording reached the 12 bytes safety limit. Saving captured audio…",
    );
  });

  it("keeps later audio in order in memory after an append fails, then appends it before the move", async () => {
    const logged = jest.spyOn(console, "debug").mockImplementation(() => undefined);
    const harness = streamingHarness();
    const started = await harness.session.start();
    emitBytes([1]);
    await settleWrites();

    harness.adapter.appendBinary.mockRejectedValueOnce(new Error("Sync lock"));
    now.mockReturnValue(20_000);
    emitBytes([2]);
    await settleWrites();
    emitBytes([3]);
    await settleWrites();
    expect(harness.adapter.appendBinary).toHaveBeenCalledTimes(1);
    expect(harness.session.captureLimitBytes).toBe(MAX_ENCODED_CAPTURE_BYTES);
    expect(logged).toHaveBeenCalled();

    const result = await harness.session.stop();
    expect(harness.adapter.appendBinary).toHaveBeenCalledTimes(2);
    expect(harness.files.get(started.filePath)).toEqual([1, 2, 3]);
    expect(result.sizeBytes).toBe(3);
  });

  it("retries a failed final append without creating a second file or appending twice", async () => {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    const harness = streamingHarness();
    const started = await harness.session.start();
    emitBytes([1]);
    await settleWrites();

    harness.adapter.appendBinary
      .mockRejectedValueOnce(new Error("Storage is full"))
      .mockRejectedValueOnce(new Error("Storage is full"));
    harness.adapter.rename.mockRejectedValueOnce(new Error("Locked"));
    harness.adapter.copy.mockRejectedValueOnce(new Error("Locked"));
    now.mockReturnValue(20_000);
    emitBytes([2]);
    await settleWrites();

    await expect(harness.session.stop()).rejects.toThrow("Audio is still in memory, but it could not be saved: Storage is full");
    expect(harness.session.getPendingSaveResult()).toMatchObject({ sizeBytes: 2 });

    // The tail lands, then the move fails: the next retry only moves.
    await expect(harness.session.retrySave()).rejects.toThrow("could not be moved");
    await expect(harness.session.retrySave()).resolves.toMatchObject({ sizeBytes: 2 });
    expect(harness.createBinary).not.toHaveBeenCalled();
    expect(harness.files.get(started.filePath)).toEqual([1, 2]);
  });

  it("falls back to the in-memory capture when the in-progress file cannot be created", async () => {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    const harness = streamingHarness();
    harness.adapter.writeBinary.mockRejectedValueOnce(new Error("Folder is read-only"));
    const started = await harness.session.start();
    emitBytes([1]);
    await settleWrites();
    emitBytes([2]);

    const result = await harness.session.stop();
    expect(harness.createBinary).toHaveBeenCalledTimes(1);
    expect(harness.files.get(started.filePath)).toEqual([1, 2]);
    expect(harness.adapter.appendBinary).not.toHaveBeenCalled();
    expect(harness.adapter.rename).not.toHaveBeenCalled();
    expect(harness.onCaptureFileCreated).not.toHaveBeenCalled();
    expect(result.sizeBytes).toBe(2);
  });

  it("keeps the name it already chose when a later chunk reports another container", async () => {
    const harness = streamingHarness();
    const started = await harness.session.start();
    emitBytes([1]);
    await settleWrites();

    now.mockReturnValue(20_000);
    emitBytes([2], "audio/mp4");
    const result = await harness.session.stop();

    expect(result.filePath).toBe(started.filePath);
    expect(result.filePath).toMatch(/\.webm$/);
    expect(harness.files.get(started.filePath)).toEqual([1, 2]);
  });
});
