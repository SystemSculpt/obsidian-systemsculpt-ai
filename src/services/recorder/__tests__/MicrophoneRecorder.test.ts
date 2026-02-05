/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
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

  public state: "inactive" | "recording" = "inactive";
  public ondataavailable: ((event: { data: Blob }) => void) | null = null;
  public onstop: (() => void) | null = null;
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

  public constructor(_stream: MediaStream, _options?: { mimeType?: string }) {}
}

const createTrack = (): MockTrack => ({
  label: "iPhone Microphone",
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

describe("MicrophoneRecorder", () => {
  const originalMediaRecorder = (globalThis as any).MediaRecorder;
  const originalMediaDevices = (globalThis.navigator as any)?.mediaDevices;
  const originalWakeLock = (globalThis.navigator as any)?.wakeLock;
  let hiddenValue = false;

  beforeEach(() => {
    jest.clearAllMocks();
    hiddenValue = false;
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
      extension: "webm",
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
      extension: "webm",
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
      extension: "webm",
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
      extension: "webm",
      onError: jest.fn(),
      onStatus,
      onComplete: jest.fn(),
    });

    await recorder.start("SystemSculpt/Recordings/no-wakelock.webm");

    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("Keep your screen awake"));
  });
});
