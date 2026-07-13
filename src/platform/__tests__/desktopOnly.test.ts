/**
 * @jest-environment node
 */
import { hasNodeRuntime, loadDesktopOnly } from "../desktopOnly";

describe("desktopOnly boundary (#207)", () => {
  describe("hasNodeRuntime", () => {
    it("reports the managed desktop runtime", () => {
      expect(hasNodeRuntime()).toBe(true);
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
  });
});
