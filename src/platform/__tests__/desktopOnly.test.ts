/**
 * @jest-environment node
 */
import { Platform } from "obsidian";
import {
  DesktopHostUnavailableError,
  hasNodeRuntime,
  loadDesktopOnly,
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

  describe("loadDesktopOnly", () => {
    it("invokes the loader and returns its value", () => {
      const loaded = { ok: true };
      const loader = jest.fn().mockReturnValue(loaded);

      const result = loadDesktopOnly(loader);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(result).toBe(loaded);
    });

    it("rejects desktop adapters without evaluating their loader on mobile", () => {
      platform.isDesktopApp = false;
      const loader = jest.fn();

      expect(() => loadDesktopOnly(loader, "CLI execution")).toThrow(
        new DesktopHostUnavailableError("CLI execution"),
      );
      expect(loader).not.toHaveBeenCalled();
    });
  });
});
