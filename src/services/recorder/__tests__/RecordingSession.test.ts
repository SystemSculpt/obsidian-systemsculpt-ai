/**
 * @jest-environment node
 */

import type { App } from "obsidian";
import {
  MAX_ENCODED_CAPTURE_BYTES,
  RECORDER_STOP_WATCHDOG_MS,
  RecordingSession,
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

function createHarness(overrides: Partial<RecordingSessionOptions> = {}): SessionHarness {
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
      adapter: { exists },
      createBinary,
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
