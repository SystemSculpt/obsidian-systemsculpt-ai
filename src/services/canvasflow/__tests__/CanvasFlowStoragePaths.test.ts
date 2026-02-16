import {
  DEFAULT_CANVASFLOW_OUTPUT_DIR,
  resolveCanvasFlowOutputDirectory,
  resolveCanvasFlowSafeFileStem,
} from "../CanvasFlowStoragePaths";

describe("CanvasFlowStoragePaths", () => {
  describe("resolveCanvasFlowOutputDirectory", () => {
    it("falls back to default for empty values", () => {
      expect(resolveCanvasFlowOutputDirectory("")).toBe(DEFAULT_CANVASFLOW_OUTPUT_DIR);
      expect(resolveCanvasFlowOutputDirectory(undefined)).toBe(DEFAULT_CANVASFLOW_OUTPUT_DIR);
    });

    it("forces outputs under the plugin-owned root", () => {
      expect(resolveCanvasFlowOutputDirectory("E2E/Generations")).toBe(
        `${DEFAULT_CANVASFLOW_OUTPUT_DIR}/E2E/Generations`
      );
    });

    it("rejects traversal segments", () => {
      expect(resolveCanvasFlowOutputDirectory("../outside")).toBe(DEFAULT_CANVASFLOW_OUTPUT_DIR);
      expect(resolveCanvasFlowOutputDirectory("SystemSculpt/Attachments/Generations/../../evil")).toBe(
        DEFAULT_CANVASFLOW_OUTPUT_DIR
      );
    });

    it("preserves valid nested paths under default root", () => {
      expect(resolveCanvasFlowOutputDirectory("SystemSculpt/Attachments/Generations/Custom")).toBe(
        "SystemSculpt/Attachments/Generations/Custom"
      );
    });
  });

  describe("resolveCanvasFlowSafeFileStem", () => {
    it("strips unsafe path tokens", () => {
      expect(resolveCanvasFlowSafeFileStem("../secret")).toBe("secret");
      expect(resolveCanvasFlowSafeFileStem("././")).toBe("generation");
    });

    it("falls back for empty stems", () => {
      expect(resolveCanvasFlowSafeFileStem("")).toBe("generation");
      expect(resolveCanvasFlowSafeFileStem("..")).toBe("generation");
    });
  });
});
