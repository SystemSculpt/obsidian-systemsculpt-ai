/**
 * @jest-environment node
 */

jest.mock("../MacShellVideoSupport", () => ({
  hasMacWindowShellRecordingSupport: jest.fn(() => true),
}));

import { FileSystemAdapter } from "obsidian";
import { MacWindowShellRecorder, RecorderCanceledError } from "../MacWindowShellRecorder";

type FakeDataStream = {
  on: jest.Mock;
  emitData: (chunk: unknown) => void;
};

type FakeChildProcess = {
  stdin: {
    write: jest.Mock<boolean, [string]>;
  };
  stdout: FakeDataStream;
  stderr: FakeDataStream;
  kill: jest.Mock<boolean, [NodeJS.Signals?]>;
  once: jest.Mock<void, [string, (...args: any[]) => void]>;
  emitClose: (code: number | null) => void;
  emitError: (error: Error) => void;
};

const flushAsync = async (ticks: number = 4): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
};

const createFakeStream = (): FakeDataStream => {
  const listeners: Array<(chunk: unknown) => void> = [];
  return {
    on: jest.fn((_event: string, listener: (chunk: unknown) => void) => {
      listeners.push(listener);
    }),
    emitData: (chunk: unknown) => {
      listeners.forEach((listener) => listener(chunk));
    },
  };
};

const createFakeChildProcess = (): FakeChildProcess => {
  const closeListeners: Array<(code: number | null) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  return {
    stdin: {
      write: jest.fn(() => true),
    },
    stdout: createFakeStream(),
    stderr: createFakeStream(),
    kill: jest.fn(() => true),
    once: jest.fn((event: string, listener: (...args: any[]) => void) => {
      if (event === "close") {
        closeListeners.push(listener as (code: number | null) => void);
      } else if (event === "error") {
        errorListeners.push(listener as (error: Error) => void);
      }
    }),
    emitClose: (code: number | null) => {
      closeListeners.forEach((listener) => listener(code));
    },
    emitError: (error: Error) => {
      errorListeners.forEach((listener) => listener(error));
    },
  };
};

const createAppWithFilesystemAdapter = (): any => {
  const adapter = new FileSystemAdapter("/vault") as any;
  adapter.exists = jest.fn().mockResolvedValue(true);
  adapter.readBinary = jest.fn().mockResolvedValue(new ArrayBuffer(0));
  adapter.stat = jest.fn().mockResolvedValue({ size: 0 });
  return {
    vault: {
      adapter,
    },
  };
};

describe("MacWindowShellRecorder", () => {
  const originalRequire = (globalThis as any).require;

  afterEach(() => {
    (globalThis as any).require = originalRequire;
    jest.clearAllMocks();
  });

  it("starts with Obsidian window rectangle capture when bounds can be resolved", async () => {
    const child = createFakeChildProcess();
    const spawn = jest.fn(() => child);
    const execFileSync = jest.fn(() => "209, 37\n1471, 936\n");

    (globalThis as any).require = jest.fn((name: string) => {
      if (name === "child_process") return { spawn, execFileSync };
      throw new Error(`Unexpected module request: ${name}`);
    });

    const onStatus = jest.fn();
    const recorder = new MacWindowShellRecorder(createAppWithFilesystemAdapter(), {
      onError: jest.fn(),
      onStatus,
      onComplete: jest.fn(),
    });

    await recorder.start("SystemSculpt/Video Recordings/test.mov");

    expect(spawn).toHaveBeenCalledWith(
      "screencapture",
      ["-v", "-R209,37,1471,936", "-o", "/vault/SystemSculpt/Video Recordings/test.mov"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    expect(onStatus).toHaveBeenCalledWith("Recording Obsidian window...");
  });

  it("falls back to window picker capture when bounds cannot be resolved", async () => {
    const child = createFakeChildProcess();
    const spawn = jest.fn(() => child);
    const execFileSync = jest.fn(() => {
      throw new Error("Automation not authorized");
    });

    (globalThis as any).require = jest.fn((name: string) => {
      if (name === "child_process") return { spawn, execFileSync };
      throw new Error(`Unexpected module request: ${name}`);
    });

    const onStatus = jest.fn();
    const recorder = new MacWindowShellRecorder(createAppWithFilesystemAdapter(), {
      onError: jest.fn(),
      onStatus,
      onComplete: jest.fn(),
    });

    await recorder.start("SystemSculpt/Video Recordings/test.mov");

    expect(spawn).toHaveBeenCalledWith(
      "screencapture",
      ["-v", "-w", "-o", "/vault/SystemSculpt/Video Recordings/test.mov"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    expect(onStatus).toHaveBeenCalledWith(
      "Choose the Obsidian window to start recording..."
    );
  });

  it("adds shell audio capture flag when microphone input is enabled", async () => {
    const child = createFakeChildProcess();
    const spawn = jest.fn(() => child);
    const execFileSync = jest.fn(() => "209, 37\n1471, 936\n");

    (globalThis as any).require = jest.fn((name: string) => {
      if (name === "child_process") return { spawn, execFileSync };
      throw new Error(`Unexpected module request: ${name}`);
    });

    const recorder = new MacWindowShellRecorder(createAppWithFilesystemAdapter(), {
      onError: jest.fn(),
      onStatus: jest.fn(),
      onComplete: jest.fn(),
      captureAudio: {
        includeSystemAudio: false,
        includeMicrophoneAudio: true,
      },
    });

    await recorder.start("SystemSculpt/Video Recordings/test.mov");

    expect(spawn).toHaveBeenCalledWith(
      "screencapture",
      ["-v", "-g", "-R209,37,1471,936", "-o", "/vault/SystemSculpt/Video Recordings/test.mov"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
  });

  it("emits RecorderCanceledError when stopped before output is produced", async () => {
    const child = createFakeChildProcess();
    const spawn = jest.fn(() => child);
    const execFileSync = jest.fn(() => {
      throw new Error("bounds unavailable");
    });

    (globalThis as any).require = jest.fn((name: string) => {
      if (name === "child_process") return { spawn, execFileSync };
      throw new Error(`Unexpected module request: ${name}`);
    });

    const onError = jest.fn();
    const recorder = new MacWindowShellRecorder(createAppWithFilesystemAdapter(), {
      onError,
      onStatus: jest.fn(),
      onComplete: jest.fn(),
    });
    (recorder as any).readOutputBytesWithRetry = jest.fn().mockResolvedValue(null);
    (recorder as any).probeOutputSizeWithRetry = jest.fn().mockResolvedValue(0);

    await recorder.start("SystemSculpt/Video Recordings/test.mov");
    recorder.stop();
    child.emitClose(130);
    await flushAsync();

    expect(onError).toHaveBeenCalledWith(expect.any(RecorderCanceledError));
    const emitted = onError.mock.calls[0][0] as Error;
    expect(emitted.message).toBe("Recording canceled before start. Select the Obsidian window first.");
  });

  it("stops by writing newline to stdin before using signals", async () => {
    const child = createFakeChildProcess();
    const spawn = jest.fn(() => child);
    const execFileSync = jest.fn(() => "209, 37\n1471, 936\n");

    (globalThis as any).require = jest.fn((name: string) => {
      if (name === "child_process") return { spawn, execFileSync };
      throw new Error(`Unexpected module request: ${name}`);
    });

    const recorder = new MacWindowShellRecorder(createAppWithFilesystemAdapter(), {
      onError: jest.fn(),
      onStatus: jest.fn(),
      onComplete: jest.fn(),
    });
    (recorder as any).readOutputBytesWithRetry = jest.fn().mockResolvedValue(new ArrayBuffer(4));

    await recorder.start("SystemSculpt/Video Recordings/test.mov");
    recorder.stop();
    child.emitClose(0);
    await flushAsync();

    expect(child.stdin.write).toHaveBeenCalledWith("\n");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("reports missing video data when stop was requested after capture had started", async () => {
    const child = createFakeChildProcess();
    const spawn = jest.fn(() => child);
    const execFileSync = jest.fn(() => {
      throw new Error("bounds unavailable");
    });

    (globalThis as any).require = jest.fn((name: string) => {
      if (name === "child_process") return { spawn, execFileSync };
      throw new Error(`Unexpected module request: ${name}`);
    });

    const onError = jest.fn();
    const recorder = new MacWindowShellRecorder(createAppWithFilesystemAdapter(), {
      onError,
      onStatus: jest.fn(),
      onComplete: jest.fn(),
    });
    (recorder as any).readOutputBytesWithRetry = jest.fn().mockResolvedValue(null);
    (recorder as any).probeOutputSizeWithRetry = jest.fn().mockResolvedValue(0);

    await recorder.start("SystemSculpt/Video Recordings/test.mov");
    child.stderr.emitData("type any character (or ctrl-c) to stop screen recording");
    recorder.stop();
    child.emitClose(130);
    await flushAsync();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    const emitted = onError.mock.calls[0][0] as Error;
    expect(emitted.name).not.toBe("RecorderCanceledError");
    expect(emitted.message).toContain("no video data was saved");
  });

  it("completes when file size is available even if binary read-back fails", async () => {
    const child = createFakeChildProcess();
    const spawn = jest.fn(() => child);
    const execFileSync = jest.fn(() => "209, 37\n1471, 936\n");

    (globalThis as any).require = jest.fn((name: string) => {
      if (name === "child_process") return { spawn, execFileSync };
      throw new Error(`Unexpected module request: ${name}`);
    });

    const onError = jest.fn();
    const onComplete = jest.fn();
    const recorder = new MacWindowShellRecorder(createAppWithFilesystemAdapter(), {
      onError,
      onStatus: jest.fn(),
      onComplete,
    });
    (recorder as any).readOutputBytesWithRetry = jest.fn().mockResolvedValue(null);
    (recorder as any).probeOutputSizeWithRetry = jest.fn().mockResolvedValue(2048);

    await recorder.start("SystemSculpt/Video Recordings/test.mov");
    child.stderr.emitData("type any character (or ctrl-c) to stop screen recording");
    recorder.stop();
    child.emitClose(0);
    await flushAsync();

    expect(onComplete).toHaveBeenCalledWith(
      "SystemSculpt/Video Recordings/test.mov",
      expect.any(Blob),
      "manual"
    );
    expect(onError).not.toHaveBeenCalled();
  });
});
