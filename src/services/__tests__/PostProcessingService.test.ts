import { PostProcessingService } from "../PostProcessingService";
import { SystemSculptError } from "../../utils/errors";

const MANAGED_MODEL_ID = "systemsculpt@@systemsculpt/ai-agent";

const createMockSculptService = () => ({
  streamMessage: jest.fn(),
});

let mockSculptService = createMockSculptService();

jest.mock("../SystemSculptService", () => ({
  SystemSculptService: {
    getInstance: jest.fn(() => mockSculptService),
  },
}));

jest.mock("../../modals/PostProcessingModelPromptModal", () => ({
  PostProcessingModelPromptModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
  })),
}));

const createMockPlugin = () => ({
  settings: {
    postProcessingEnabled: true,
    postProcessingPrompt: "Process this text",
    postProcessingModelId: "openai@@gpt-4",
    postProcessingProviderId: "openai",
    selectedModelId: "anthropic@@claude-sonnet-4",
    useLatestModelEverywhere: false,
    settingsMode: "advanced",
    licenseKey: "valid-license",
    licenseValid: true,
    enableSystemSculptProvider: true,
  },
  modelService: {
    validateSpecificModel: jest.fn(async () => ({ isAvailable: true })),
  },
}) as any;

describe("PostProcessingService", () => {
  let mockPlugin: ReturnType<typeof createMockPlugin>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    (PostProcessingService as any).instance = null;
    (PostProcessingService as any).promptVisible = false;
    mockSculptService = createMockSculptService();
  });

  describe("getInstance", () => {
    it("returns a singleton instance", () => {
      const first = PostProcessingService.getInstance(mockPlugin);
      const second = PostProcessingService.getInstance(mockPlugin);

      expect(first).toBe(second);
    });
  });

  describe("getPostProcessingModelId (private)", () => {
    it("always returns the managed SystemSculpt model", () => {
      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toBe(MANAGED_MODEL_ID);
    });

    it("ignores legacy post-processing model settings", () => {
      mockPlugin.settings.postProcessingModelId = "custom-provider@@custom-model";
      mockPlugin.settings.postProcessingProviderId = "custom-provider";
      mockPlugin.settings.selectedModelId = "openai@@gpt-4.1";

      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toBe(MANAGED_MODEL_ID);
    });
  });

  describe("processTranscription", () => {
    beforeEach(() => {
      (PostProcessingService as any).instance = null;
    });

    it("returns the original text when post-processing is disabled", async () => {
      mockPlugin.settings.postProcessingEnabled = false;

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("original text")).resolves.toBe("original text");
      expect(mockSculptService.streamMessage).not.toHaveBeenCalled();
    });

    it("returns the original text and opens recovery guidance when managed access is missing", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");
      mockPlugin.settings.licenseKey = "";
      mockPlugin.settings.licenseValid = false;

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("original text")).resolves.toBe("original text");

      expect(mockSculptService.streamMessage).not.toHaveBeenCalled();
      expect(PostProcessingModelPromptModal).toHaveBeenCalledWith(
        mockPlugin,
        expect.objectContaining({
          missingModelId: MANAGED_MODEL_ID,
        })
      );
    });

    it("processes text through the managed SystemSculpt model", async () => {
      mockSculptService.streamMessage.mockReturnValue(
        (async function* () {
          yield { type: "content", text: "Processed " };
          yield { type: "content", text: "text" };
        })()
      );

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("original text")).resolves.toBe("Processed text");
      expect(mockSculptService.streamMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: MANAGED_MODEL_ID,
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "system",
              content: "Process this text",
            }),
            expect.objectContaining({
              role: "user",
              content: "original text",
            }),
          ]),
        })
      );
    });

    it("returns the original text when validation says the managed model is unavailable", async () => {
      mockPlugin.modelService.validateSpecificModel.mockResolvedValueOnce({
        isAvailable: false,
      });

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("original text")).resolves.toBe("original text");
      expect(mockSculptService.streamMessage).not.toHaveBeenCalled();
    });

    it("returns the original text on stream errors", async () => {
      mockSculptService.streamMessage.mockImplementation(() => {
        throw new Error("Stream failed");
      });

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("original text")).resolves.toBe("original text");
    });

    it("trims the processed text", async () => {
      mockSculptService.streamMessage.mockReturnValue(
        (async function* () {
          yield { type: "content", text: "  result with spaces  " };
        })()
      );

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("test")).resolves.toBe("result with spaces");
    });

    it("handles empty stream responses", async () => {
      mockSculptService.streamMessage.mockReturnValue(
        (async function* () {})()
      );

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("test")).resolves.toBe("");
    });

    it("ignores non-content stream events", async () => {
      mockSculptService.streamMessage.mockReturnValue(
        (async function* () {
          yield { type: "metadata", data: {} };
          yield { type: "content", text: "valid" };
          yield { type: "done" };
        })()
      );

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("test")).resolves.toBe("valid");
    });
  });

  describe("ensurePostProcessingModelAvailability (private)", () => {
    it("resolves when the managed model is available", async () => {
      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability(MANAGED_MODEL_ID)
      ).resolves.not.toThrow();
    });

    it("throws a SystemSculptError when the managed model is unavailable", async () => {
      mockPlugin.modelService.validateSpecificModel.mockResolvedValueOnce({
        isAvailable: false,
      });

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability(MANAGED_MODEL_ID)
      ).rejects.toThrow(SystemSculptError);
    });

    it("includes the managed model id in error metadata", async () => {
      mockPlugin.modelService.validateSpecificModel.mockResolvedValueOnce({
        isAvailable: false,
      });

      const service = PostProcessingService.getInstance(mockPlugin);

      try {
        await (service as any).ensurePostProcessingModelAvailability(MANAGED_MODEL_ID);
        fail("Expected error");
      } catch (error) {
        expect(error).toBeInstanceOf(SystemSculptError);
        expect((error as SystemSculptError).metadata?.model).toBe(MANAGED_MODEL_ID);
      }
    });

    it("re-throws existing SystemSculptError values", async () => {
      const originalError = new SystemSculptError("Custom error", "CUSTOM", 400);
      mockPlugin.modelService.validateSpecificModel.mockRejectedValueOnce(originalError);

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability(MANAGED_MODEL_ID)
      ).rejects.toBe(originalError);
    });

    it("wraps validation failures as managed-model unavailability", async () => {
      mockPlugin.modelService.validateSpecificModel.mockRejectedValueOnce(
        new Error("Validation failed")
      );

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability(MANAGED_MODEL_ID)
      ).rejects.toThrow(SystemSculptError);
    });
  });

  describe("buildModelUnavailableReason (private)", () => {
    it("explains when the license key is missing", () => {
      mockPlugin.settings.licenseKey = "";

      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(MANAGED_MODEL_ID);

      expect(reason).toContain("no license key");
      expect(reason).toContain("SystemSculpt");
    });

    it("explains when the license has not been validated", () => {
      mockPlugin.settings.licenseKey = "valid";
      mockPlugin.settings.licenseValid = false;

      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(MANAGED_MODEL_ID);

      expect(reason).toContain("not been validated");
      expect(reason).toContain("Setup");
    });

    it("returns a generic managed-service reason for runtime failures", () => {
      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(MANAGED_MODEL_ID);

      expect(reason).toContain("managed SystemSculpt post-processing model");
      expect(reason).toContain(MANAGED_MODEL_ID);
    });
  });

  describe("promptPostProcessingModelFix (private)", () => {
    it("opens the recovery modal when not already visible", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");
      const service = PostProcessingService.getInstance(mockPlugin);

      await (service as any).promptPostProcessingModelFix(MANAGED_MODEL_ID);

      expect(PostProcessingModelPromptModal).toHaveBeenCalledWith(
        mockPlugin,
        expect.objectContaining({
          missingModelId: MANAGED_MODEL_ID,
          reason: expect.any(String),
        })
      );
    });

    it("does not open the recovery modal when it is already visible", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");
      (PostProcessingService as any).promptVisible = true;

      const service = PostProcessingService.getInstance(mockPlugin);
      await (service as any).promptPostProcessingModelFix(MANAGED_MODEL_ID);

      expect(PostProcessingModelPromptModal).not.toHaveBeenCalled();
    });
  });
});
