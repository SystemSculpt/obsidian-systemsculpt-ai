/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import { JSDOM } from "jsdom";
import { MicrophoneRecorder } from "../MicrophoneRecorder";

type MockTrack = {
  label: string;
  stop: jest.Mock<void, []>;
  addEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject, (AddEventListenerOptions | boolean)?]>;
  removeEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject, (EventListenerOptions | boolean)?]>;
};

const flushPromises = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

class MockMediaRecorder {
  public static isTypeSupported = jest.fn(() => true);
  public static instances: MockMediaRecorder[] = [];

  public state: "inactive" | "recording" = "inactive";
  public ondataavailable: ((event: { data: Blob }) => void) | null = null;
  public onstop: (() => void) | null = null;
  public onerror: ((event: { error?: unknown }) => void) | null = null;
  public requestData = jest.fn(() => {
    if (this.state !== "recording") return;
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(["audio-data"], { type: "audio/webm" }) });
    }
  });
  public start = jest.fn(() => {
    this.state = "recording";
  });
  public stop = jest.fn(() => {
    if (this.state === "inactive") return;
    this.requestData();
    this.state = "inactive";
    this.onstop?.();
  });

  /**
   * Simulate the browser revoking the mic track mid-recording: a real MediaRecorder
   * fires "error" and transitions to "inactive" without a clean onstop.
   */
  public emitError = (error?: unknown): void => {
    this.state = "inactive";
    this.onerror?.({ error });
  };

  public options?: { mimeType?: string; audioBitsPerSecond?: number };

  public constructor(
    _stream: MediaStream,
    _options?: { mimeType?: string; audioBitsPerSecond?: number }
  ) {
    this.options = _options;
    MockMediaRecorder.instances.push(this);
  }
}

const createTrack = (): MockTrack => ({
  label: "External Microphone",
  stop: jest.fn(),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
});

const createStream = (track: MockTrack): MediaStream => {
  return {
    getAudioTracks: () => [track as unknown as MediaStreamTrack],
    getTracks: () => [track as unknown as MediaStreamTrack],
  } as unknown as MediaStream;
};

const createForeignCaptureHarness = () => {
  const popout = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://systemsculpt.local/recorder-capture-popout",
  });
  const track = createTrack();
  const stream = createStream(track);
  const mediaDevices = {
    getUserMedia: jest.fn().mockResolvedValue(stream),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  Object.defineProperty(popout.window.navigator, "mediaDevices", {
    configurable: true,
    value: mediaDevices,
  });

  const releaseWakeLock = jest.fn().mockResolvedValue(undefined);
  const wakeLockSentinel = {
    release: releaseWakeLock,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  const requestWakeLock = jest.fn().mockResolvedValue(wakeLockSentinel);
  Object.defineProperty(popout.window.navigator, "wakeLock", {
    configurable: true,
    value: { request: requestWakeLock },
  });
  Object.defineProperty(popout.window, "MediaRecorder", {
    configurable: true,
    value: MockMediaRecorder,
  });
  const ForeignBlob = jest.fn().mockImplementation(
    (parts?: BlobPart[], options?: BlobPropertyBag) => new Blob(parts ?? [], options)
  );
  Object.defineProperty(popout.window, "Blob", {
    configurable: true,
    value: ForeignBlob,
  });

  let hidden = false;
  Object.defineProperty(popout.window.document, "hidden", {
    configurable: true,
    get: () => hidden,
  });

  return {
    popout,
    track,
    mediaDevices,
    requestWakeLock,
    releaseWakeLock,
    ForeignBlob,
    setHidden: (nextHidden: boolean) => {
      hidden = nextHidden;
    },
    hostContext: {
      host: popout.window.document.body,
      hostDocument: popout.window.document,
      hostWindow: popout.window as unknown as Window,
    },
  };
};

describe("MicrophoneRecorder", () => {
  const originalMediaRecorder = (globalThis as any).MediaRecorder;
  const originalMediaDevices = (globalThis.navigator as any)?.mediaDevices;
  const originalWakeLock = (globalThis.navigator as any)?.wakeLock;
  let hiddenValue = false;

  beforeEach(() => {
    jest.clearAllMocks();
    hiddenValue = false;
    MockMediaRecorder.instances = [];
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hiddenValue,
    });
    (globalThis as any).MediaRecorder = MockMediaRecorder;
  });

  afterEach(() => {
    if (typeof originalMediaRecorder === "undefined") {
      delete (globalThis as any).MediaRecorder;
    } else {
      (globalThis as any).MediaRecorder = originalMediaRecorder;
    }

    if (typeof originalMediaDevices === "undefined") {
      delete (globalThis.navigator as any).mediaDevices;
    } else {
      Object.defineProperty(globalThis.navigator, "mediaDevices", {
        configurable: true,
        value: originalMediaDevices,
      });
    }

    if (typeof originalWakeLock === "undefined") {
      delete (globalThis.navigator as any).wakeLock;
    } else {
      (globalThis.navigator as any).wakeLock = originalWakeLock;
    }
  });

  it("stops and saves recording on visibility hidden with background stop reason", async () => {
    const track = createTrack();
    const stream = createStream(track);
    const getUserMedia = jest.fn().mockResolvedValue(stream);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });

    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);
    const onComplete = jest.fn();
    const onStatus = jest.fn();

    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      onError: jest.fn(),
      onStatus,
      onComplete,
    });

    await recorder.start("SystemSculpt/Recordings/visibility-hidden.webm");
    hiddenValue = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();

    expect((app.vault.adapter as any).writeBinary).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(
      "SystemSculpt/Recordings/visibility-hidden.webm",
      expect.any(Blob),
      "background-hidden"
    );
    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("background"));
  });

  it("stops and saves recording on pagehide with background stop reason", async () => {
    const track = createTrack();
    const stream = createStream(track);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: jest.fn().mockResolvedValue(stream),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });

    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);
    const onComplete = jest.fn();

    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      onError: jest.fn(),
      onStatus: jest.fn(),
      onComplete,
    });

    await recorder.start("SystemSculpt/Recordings/pagehide.webm");
    window.dispatchEvent(new Event("pagehide"));
    await flushPromises();

    expect(onComplete).toHaveBeenCalledWith(
      "SystemSculpt/Recordings/pagehide.webm",
      expect.any(Blob),
      "background-pagehide"
    );
  });

  it("flushes and saves captured audio when the recorder errors mid-recording (#162)", async () => {
    const track = createTrack();
    const stream = createStream(track);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: jest.fn().mockResolvedValue(stream),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });

    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);
    const onComplete = jest.fn();
    const onError = jest.fn();

    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      onError,
      onStatus: jest.fn(),
      onComplete,
    });

    await recorder.start("SystemSculpt/Recordings/interrupted.webm");

    const instance = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
    // A timeslice chunk lands before the interruption (start(800) on a device).
    instance.requestData();
    // The recorder errors and goes inactive without a clean
    // visibilitychange/onstop. The captured audio must still be saved.
    instance.emitError(new Error("The operation could not be performed"));
    await flushPromises();

    expect((app.vault.adapter as any).writeBinary).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(
      "SystemSculpt/Recordings/interrupted.webm",
      expect.any(Blob),
      "interrupted"
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("treats a mic loss while backgrounded as a background save, not a hard failure (#162)", async () => {
    const track = createTrack();
    const stream = createStream(track);
    const getUserMedia = jest
      .fn()
      .mockResolvedValueOnce(stream)
      .mockRejectedValue(new Error("NotAllowedError: getUserMedia blocked while hidden"));
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });

    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);
    const onComplete = jest.fn();
    const onError = jest.fn();

    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      onError,
      onStatus: jest.fn(),
      onComplete,
    });

    await recorder.start("SystemSculpt/Recordings/bg-miclost.webm");
    const instance = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
    instance.requestData(); // buffer a chunk before the track ends

    // Device locks: the track ends AND the page is hidden, so re-acquisition fails.
    hiddenValue = true;
    const endedCall = track.addEventListener.mock.calls.find(([event]) => event === "ended");
    const endedHandler = endedCall?.[1] as () => void;
    endedHandler();
    await flushPromises();
    await flushPromises();

    expect((app.vault.adapter as any).writeBinary).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(
      "SystemSculpt/Recordings/bg-miclost.webm",
      expect.any(Blob),
      "background-hidden"
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("requests the speech-optimized bitrate when one is provided (#169)", async () => {
    const track = createTrack();
    const stream = createStream(track);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: jest.fn().mockResolvedValue(stream),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });

    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);

    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 48000,
      onError: jest.fn(),
      onStatus: jest.fn(),
      onComplete: jest.fn(),
    });

    await recorder.start("SystemSculpt/Recordings/bitrate.webm");

    const instance = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
    expect(instance.options?.audioBitsPerSecond).toBe(48000);
    expect(instance.options?.mimeType).toBe("audio/webm;codecs=opus");
  });

  it("omits the bitrate when none is provided (platform default)", async () => {
    const track = createTrack();
    const stream = createStream(track);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: jest.fn().mockResolvedValue(stream),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });

    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);

    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      onError: jest.fn(),
      onStatus: jest.fn(),
      onComplete: jest.fn(),
    });

    await recorder.start("SystemSculpt/Recordings/default-bitrate.webm");

    const instance = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
    expect(instance.options?.audioBitsPerSecond).toBeUndefined();
  });

  it("acquires wake lock while recording and releases it on cleanup", async () => {
    const track = createTrack();
    const stream = createStream(track);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: jest.fn().mockResolvedValue(stream),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });

    const release = jest.fn().mockResolvedValue(undefined);
    const sentinel = {
      release,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    const request = jest.fn().mockResolvedValue(sentinel);
    (globalThis.navigator as any).wakeLock = { request };

    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);
    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      onError: jest.fn(),
      onStatus: jest.fn(),
      onComplete: jest.fn(),
    });

    await recorder.start("SystemSculpt/Recordings/wakelock.webm");
    expect(request).toHaveBeenCalledWith("screen");

    recorder.stop();
    await flushPromises();

    expect(release).toHaveBeenCalled();
  });

  it("shows a keep-screen-awake hint when wake lock is unavailable", async () => {
    const track = createTrack();
    const stream = createStream(track);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: jest.fn().mockResolvedValue(stream),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    delete (globalThis.navigator as any).wakeLock;

    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);
    const onStatus = jest.fn();

    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      onError: jest.fn(),
      onStatus,
      onComplete: jest.fn(),
    });

    await recorder.start("SystemSculpt/Recordings/no-wakelock.webm");

    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("screen awake"));
  });

  it("binds capture, device changes, pagehide, wake lock, and cleanup to the popout realm", async () => {
    const foreign = createForeignCaptureHarness();
    const popoutSetTimeout = jest.spyOn(foreign.popout.window, "setTimeout");
    const popoutClearTimeout = jest.spyOn(foreign.popout.window, "clearTimeout");
    const mainMediaDevices = {
      getUserMedia: jest.fn().mockRejectedValue(new Error("main window must not capture")),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: mainMediaDevices,
    });
    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);
    const onComplete = jest.fn();
    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      hostContext: foreign.hostContext,
      onError: jest.fn(),
      onStatus: jest.fn(),
      onComplete,
    });

    try {
      await recorder.start("SystemSculpt/Recordings/popout-pagehide.webm");
      await flushPromises();

      expect(foreign.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: expect.objectContaining({ echoCancellation: true }),
      });
      expect(mainMediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(foreign.mediaDevices.addEventListener).toHaveBeenCalledWith(
        "devicechange",
        expect.any(Function)
      );
      expect(mainMediaDevices.addEventListener).not.toHaveBeenCalled();
      expect(popoutSetTimeout).toHaveBeenCalledWith(expect.any(Function), 10000);
      expect(popoutClearTimeout).toHaveBeenCalled();
      expect(foreign.requestWakeLock).toHaveBeenCalledWith("screen");

      const deviceChangeListener = foreign.mediaDevices.addEventListener.mock.calls.find(
        ([event]) => event === "devicechange"
      )?.[1] as EventListener;
      deviceChangeListener(new foreign.popout.window.Event("devicechange"));
      await flushPromises();
      expect(foreign.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);

      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
      await flushPromises();
      expect(onComplete).not.toHaveBeenCalled();

      foreign.popout.window.dispatchEvent(new foreign.popout.window.Event("pagehide"));
      await flushPromises();
      await flushPromises();

      expect(onComplete).toHaveBeenCalledWith(
        "SystemSculpt/Recordings/popout-pagehide.webm",
        expect.any(Blob),
        "background-pagehide"
      );
      expect(foreign.ForeignBlob).toHaveBeenCalled();
      expect(foreign.mediaDevices.removeEventListener).toHaveBeenCalledWith(
        "devicechange",
        expect.any(Function)
      );
      expect(foreign.releaseWakeLock).toHaveBeenCalled();
    } finally {
      recorder.cleanup();
      foreign.popout.window.close();
    }
  });

  it("stops only when its initiating popout document becomes hidden", async () => {
    const foreign = createForeignCaptureHarness();
    const app = new App();
    (app.vault.adapter as any).writeBinary = jest.fn().mockResolvedValue(undefined);
    const onComplete = jest.fn();
    const recorder = new MicrophoneRecorder(app, {
      mimeType: "audio/webm;codecs=opus",
      hostContext: foreign.hostContext,
      onError: jest.fn(),
      onStatus: jest.fn(),
      onComplete,
    });

    try {
      await recorder.start("SystemSculpt/Recordings/popout-hidden.webm");

      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
      expect(onComplete).not.toHaveBeenCalled();

      foreign.setHidden(true);
      foreign.popout.window.document.dispatchEvent(
        new foreign.popout.window.Event("visibilitychange")
      );
      await flushPromises();
      await flushPromises();

      expect(onComplete).toHaveBeenCalledWith(
        "SystemSculpt/Recordings/popout-hidden.webm",
        expect.any(Blob),
        "background-hidden"
      );
    } finally {
      recorder.cleanup();
      foreign.popout.window.close();
    }
  });
});
