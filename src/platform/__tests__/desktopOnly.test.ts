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
    it("reflects the platform capability seam", () => {
      supportsNodeApis.mockReturnValue(true);
      expect(hasNodeRuntime()).toBe(true);
    });
  });

  describe("loadDesktopOnly", () => {
    it("invokes the loader and returns its value when Node access is available", () => {
      supportsNodeApis.mockReturnValue(true);
      const loaded = { ok: true };
      const loader = jest.fn().mockReturnValue(loaded);

      const result = loadDesktopOnly(loader);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(result).toBe(loaded);
    });
  });
});
