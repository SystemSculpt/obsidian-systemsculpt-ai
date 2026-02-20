/**
 * @jest-environment node
 */

import { hasMacWindowShellRecordingSupport } from "../MacShellVideoSupport";

describe("MacShellVideoSupport", () => {
  const originalPlatform = process.platform;
  const originalGlobalRequire = (globalThis as any).require;
  const originalWindow = (globalThis as any).window;

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    (globalThis as any).require = originalGlobalRequire;
    (globalThis as any).window = originalWindow;
  });

  it("returns false on non-mac platforms", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    expect(hasMacWindowShellRecordingSupport()).toBe(false);
  });

  it("returns true on mac when child_process.spawn is available", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    (globalThis as any).require = (mod: string) =>
      mod === "child_process" ? { spawn: jest.fn() } : null;

    expect(hasMacWindowShellRecordingSupport()).toBe(true);
  });

  it("returns false on mac when require is unavailable", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    (globalThis as any).require = undefined;
    (globalThis as any).window = {};

    expect(hasMacWindowShellRecordingSupport()).toBe(false);
  });
});

