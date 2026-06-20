/**
 * @jest-environment node
 */
import { PlatformContext } from "../../services/PlatformContext";
import { hasNodeRuntime, loadDesktopOnly } from "../desktopOnly";

describe("desktopOnly boundary (#207)", () => {
  let supportsNodeApis: jest.Mock;

  beforeEach(() => {
    supportsNodeApis = jest.fn().mockReturnValue(true);
    jest
      .spyOn(PlatformContext, "get")
      .mockReturnValue({ supportsNodeApis } as unknown as PlatformContext);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("hasNodeRuntime", () => {
    it("reflects the platform capability on desktop", () => {
      supportsNodeApis.mockReturnValue(true);
      expect(hasNodeRuntime()).toBe(true);
    });

    it("reflects the platform capability on mobile", () => {
      supportsNodeApis.mockReturnValue(false);
      expect(hasNodeRuntime()).toBe(false);
    });
  });

  describe("loadDesktopOnly", () => {
    it("invokes the loader and returns its value on desktop", () => {
      supportsNodeApis.mockReturnValue(true);
      const loaded = { ok: true };
      const loader = jest.fn().mockReturnValue(loaded);

      const result = loadDesktopOnly(loader);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(result).toBe(loaded);
    });

    it("returns null and NEVER invokes the loader on mobile (no eager require)", () => {
      supportsNodeApis.mockReturnValue(false);
      const loader = jest.fn(() => {
        throw new Error("loader must not run on mobile — that would require Node");
      });

      const result = loadDesktopOnly(loader);

      expect(result).toBeNull();
      expect(loader).not.toHaveBeenCalled();
    });
  });
});
