/**
 * @jest-environment node
 */

import { getVideoCapturePermissionStatus } from "../VideoCapturePermissionStatus";

describe("VideoCapturePermissionStatus", () => {
  const originalRequire = (globalThis as any).require;

  afterEach(() => {
    (globalThis as any).require = originalRequire;
    jest.clearAllMocks();
  });

  it("marks both checks done when permissions and direct window access are available", async () => {
    (globalThis as any).require = jest.fn((name: string) => {
      if (name === "electron") {
        return {
          systemPreferences: {
            getMediaAccessStatus: jest.fn(() => "granted"),
          },
        };
      }
      if (name === "child_process") {
        return {
          execFileSync: jest.fn(() => "209, 37, 1471, 936"),
        };
      }
      throw new Error("Unexpected module");
    });

    const status = await getVideoCapturePermissionStatus();
    expect(status.screenAndSystemAudio.state).toBe("done");
    expect(status.directWindowAccess.state).toBe("done");
  });

  it("marks action needed when permission is denied and automation access is blocked", async () => {
    (globalThis as any).require = jest.fn((name: string) => {
      if (name === "electron") {
        return {
          systemPreferences: {
            getMediaAccessStatus: jest.fn(() => "denied"),
          },
        };
      }
      if (name === "child_process") {
        return {
          execFileSync: jest.fn(() => {
            throw new Error("Not authorized to send Apple events to System Events.");
          }),
        };
      }
      throw new Error("Unexpected module");
    });

    const status = await getVideoCapturePermissionStatus();
    expect(status.screenAndSystemAudio.state).toBe("needs-action");
    expect(status.directWindowAccess.state).toBe("needs-action");
  });

  it("returns unknown states when Electron APIs are unavailable", async () => {
    (globalThis as any).require = jest.fn(() => {
      throw new Error("No electron");
    });

    const status = await getVideoCapturePermissionStatus();
    expect(status.screenAndSystemAudio.state).toBe("unknown");
    expect(status.directWindowAccess.state).toBe("unknown");
  });
});
