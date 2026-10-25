/**
 * @jest-environment node
 */
import { Platform } from "obsidian";
import {
  DesktopHostUnavailableError,
  desktopHost,
  hasNodeRuntime,
} from "../desktopOnly";

describe("desktop host seam (#207)", () => {
  const platform = Platform as typeof Platform & { isDesktopApp: boolean };

  beforeEach(() => {
    platform.isDesktopApp = true;
  });

  describe("hasNodeRuntime", () => {
    it("reports a desktop Obsidian host with Node", () => {
      expect(hasNodeRuntime()).toBe(true);
    });

    it("does not infer Node availability in Obsidian Mobile", () => {
      platform.isDesktopApp = false;

      expect(hasNodeRuntime()).toBe(false);
    });
  });

  describe("desktopHost", () => {
    const host = globalThis as typeof globalThis & { window?: { require?: jest.Mock } };

    afterEach(() => {
      delete host.window;
    });

    it("loads Node modules through the desktop window's require on demand", async () => {
      const childProcess = { spawn: jest.fn() };
      host.window = { require: jest.fn().mockReturnValue(childProcess) };

      await expect(desktopHost.childProcess()).resolves.toBe(childProcess);
      expect(host.window.require).toHaveBeenCalledWith("node:child_process");
    });

    it("rejects desktop adapters without requiring their module on mobile", async () => {
      platform.isDesktopApp = false;
      host.window = { require: jest.fn() };

      await expect(desktopHost.childProcess()).rejects.toThrow(
        new DesktopHostUnavailableError("CLI execution"),
      );
      expect(host.window.require).not.toHaveBeenCalled();
    });
  });
});
