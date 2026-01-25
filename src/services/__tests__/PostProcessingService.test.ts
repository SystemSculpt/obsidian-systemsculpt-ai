import { PostProcessingService } from "../PostProcessingService";
import { SystemSculptError, ERROR_CODES } from "../../utils/errors";

// Mock SystemSculptService - use a factory to create fresh mocks
const createMockSculptService = () => ({
  streamMessage: jest.fn(),
});

let mockSculptService = createMockSculptService();

jest.mock("../SystemSculptService", () => ({
  SystemSculptService: {
    getInstance: jest.fn(() => mockSculptService),
  },
}));

// Mock the modal
jest.mock("../../modals/PostProcessingModelPromptModal", () => ({
  PostProcessingModelPromptModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
  })),
}));

// Mock modelUtils
jest.mock("../../utils/modelUtils", () => ({
  ensureCanonicalId: jest.fn((id: string) => id || ""),
  parseCanonicalId: jest.fn((id: string) => {
    if (!id || !id.includes("@@")) return null;
    const [providerId, modelId] = id.split("@@");
    return { providerId, modelId };
  }),
  createCanonicalId: jest.fn((provider: string, model: string) => `${provider}@@${model}`),
}));

const createMockPlugin = () => {
  return {
    settings: {
      postProcessingEnabled: true,
      postProcessingPrompt: "Process this text",
      postProcessingModelId: "gpt-4",
      postProcessingProviderId: "openai",
      selectedModelId: "openai@@gpt-4",
      useLatestModelEverywhere: false,
      settingsMode: "advanced",
      licenseKey: "valid-license",
      licenseValid: true,
      enableSystemSculptProvider: true,
    },
    modelService: {
      validateSpecificModel: jest.fn(async () => ({ isAvailable: true })),
    },
  } as any;
};

describe("PostProcessingService", () => {
  let mockPlugin: ReturnType<typeof createMockPlugin>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    // Reset the singleton
    (PostProcessingService as any).instance = null;
    (PostProcessingService as any).promptVisible = false;
    // Reset the mock sculpt service
    mockSculptService = createMockSculptService();
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = PostProcessingService.getInstance(mockPlugin);
      const instance2 = PostProcessingService.getInstance(mockPlugin);

      expect(instance1).toBe(instance2);
    });

    it("creates instance if none exists", () => {
      const instance = PostProcessingService.getInstance(mockPlugin);

      expect(instance).toBeInstanceOf(PostProcessingService);
    });
  });

  describe("getPostProcessingModelId (private)", () => {
    it("uses post-processing model when available", () => {
      mockPlugin.settings.postProcessingModelId = "claude-3";
      mockPlugin.settings.postProcessingProviderId = "anthropic";

      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toBe("anthropic@@claude-3");
    });

    it("falls back to global model when post-processing model not set", () => {
      mockPlugin.settings.postProcessingModelId = "";
      mockPlugin.settings.postProcessingProviderId = "";

      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toBe("openai@@gpt-4");
    });

    it("uses global model in standard mode", () => {
      mockPlugin.settings.settingsMode = "standard";
      mockPlugin.settings.postProcessingModelId = "custom-model";

      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      // Should use global since standard mode ignores post-processing model
      expect(modelId).toBe("openai@@gpt-4");
    });

    it("uses global model when useLatestModelEverywhere is true", () => {
      mockPlugin.settings.useLatestModelEverywhere = true;
      mockPlugin.settings.postProcessingModelId = "custom-model";

      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toBe("openai@@gpt-4");
    });

    it("throws when no model can be determined", () => {
      mockPlugin.settings.postProcessingModelId = "";
      mockPlugin.settings.postProcessingProviderId = "";
      mockPlugin.settings.selectedModelId = "";

      const service = PostProcessingService.getInstance(mockPlugin);

      expect(() => (service as any).getPostProcessingModelId()).toThrow(
        "Failed to determine a valid model"
      );
    });

    it("handles model ID without @@ separator", () => {
      mockPlugin.settings.postProcessingModelId = "gpt-4";
      mockPlugin.settings.postProcessingProviderId = "openai";

      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toContain("gpt-4");
    });

    it("handles model ID with @@ separator", () => {
      mockPlugin.settings.postProcessingModelId = "openai@@gpt-4";
      mockPlugin.settings.postProcessingProviderId = "";

      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toBe("openai@@gpt-4");
    });
  });

  describe("processTranscription", () => {
    // Reset singleton before each test in this block to avoid stale mock state
    beforeEach(() => {
      (PostProcessingService as any).instance = null;
    });

    it("returns original text when post-processing is disabled", async () => {
      mockPlugin.settings.postProcessingEnabled = false;

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = await service.processTranscription("original text");

      expect(result).toBe("original text");
    });

    it("processes text when enabled", async () => {
      const mockStream = (async function* () {
        yield { type: "content", text: "Processed " };
        yield { type: "content", text: "text" };
      })();
      mockSculptService.streamMessage.mockReturnValue(mockStream);

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = await service.processTranscription("original text");

      expect(result).toBe("Processed text");
    });

    it("returns original text on error", async () => {
      mockSculptService.streamMessage.mockImplementation(() => {
        throw new Error("Stream failed");
      });

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = await service.processTranscription("original text");

      expect(result).toBe("original text");
    });

    it("returns original text when model is unavailable", async () => {
      mockPlugin.modelService.validateSpecificModel.mockResolvedValueOnce({
        isAvailable: false,
      });

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = await service.processTranscription("original text");

      expect(result).toBe("original text");
    });

    it("calls streamMessage with correct parameters", async () => {
      const mockStream = (async function* () {
        yield { type: "content", text: "result" };
      })();
      mockSculptService.streamMessage.mockReturnValue(mockStream);

      const service = PostProcessingService.getInstance(mockPlugin);
      await service.processTranscription("test text");

      expect(mockSculptService.streamMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "system",
              content: "Process this text",
            }),
            expect.objectContaining({
              role: "user",
              content: "test text",
            }),
          ]),
        })
      );
    });

    it("trims the processed text", async () => {
      const mockStream = (async function* () {
        yield { type: "content", text: "  result with spaces  " };
      })();
      mockSculptService.streamMessage.mockReturnValue(mockStream);

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = await service.processTranscription("test");

      expect(result).toBe("result with spaces");
    });

    it("handles empty stream response", async () => {
      const mockStream = (async function* () {
        // Empty stream
      })();
      mockSculptService.streamMessage.mockReturnValue(mockStream);

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = await service.processTranscription("test");

      expect(result).toBe("");
    });

    it("ignores non-content stream events", async () => {
      const mockStream = (async function* () {
        yield { type: "metadata", data: {} };
        yield { type: "content", text: "valid" };
        yield { type: "done" };
      })();
      mockSculptService.streamMessage.mockReturnValue(mockStream);

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = await service.processTranscription("test");

      expect(result).toBe("valid");
    });
  });

  describe("ensurePostProcessingModelAvailability (private)", () => {
    it("succeeds when model is available", async () => {
      mockPlugin.modelService.validateSpecificModel.mockResolvedValueOnce({
        isAvailable: true,
      });

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability("openai@@gpt-4")
      ).resolves.not.toThrow();
    });

    it("throws SystemSculptError when model is unavailable", async () => {
      mockPlugin.modelService.validateSpecificModel.mockResolvedValueOnce({
        isAvailable: false,
      });

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability("openai@@gpt-4")
      ).rejects.toThrow(SystemSculptError);
    });

    it("includes model in error metadata", async () => {
      mockPlugin.modelService.validateSpecificModel.mockResolvedValueOnce({
        isAvailable: false,
      });

      const service = PostProcessingService.getInstance(mockPlugin);

      try {
        await (service as any).ensurePostProcessingModelAvailability("openai@@gpt-4");
        fail("Expected error");
      } catch (error) {
        expect(error).toBeInstanceOf(SystemSculptError);
        expect((error as SystemSculptError).metadata?.model).toBe("openai@@gpt-4");
      }
    });

    it("handles validation errors", async () => {
      mockPlugin.modelService.validateSpecificModel.mockRejectedValueOnce(
        new Error("Validation failed")
      );

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability("openai@@gpt-4")
      ).rejects.toThrow(SystemSculptError);
    });

    it("re-throws existing SystemSculptError", async () => {
      const originalError = new SystemSculptError("Custom error", "CUSTOM", 400);
      mockPlugin.modelService.validateSpecificModel.mockRejectedValueOnce(
        originalError
      );

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability("openai@@gpt-4")
      ).rejects.toBe(originalError);
    });
  });

  describe("buildModelUnavailableReason (private)", () => {
    it("returns license key missing reason for systemsculpt provider", () => {
      mockPlugin.settings.licenseKey = "";

      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(
        "systemsculpt@@ai-agent"
      );

      expect(reason).toContain("no license key");
    });

    it("returns license not validated reason", () => {
      mockPlugin.settings.licenseKey = "valid";
      mockPlugin.settings.licenseValid = false;

      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(
        "systemsculpt@@ai-agent"
      );

      expect(reason).toContain("not been validated");
    });

    it("returns provider disabled reason", () => {
      mockPlugin.settings.licenseKey = "valid";
      mockPlugin.settings.licenseValid = true;
      mockPlugin.settings.enableSystemSculptProvider = false;

      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(
        "systemsculpt@@ai-agent"
      );

      expect(reason).toContain("turned off");
    });

    it("returns generic reason for other providers", () => {
      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(
        "openai@@gpt-4"
      );

      expect(reason).toContain("no longer available");
    });

    it("returns generic reason for non-canonical IDs", () => {
      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason("gpt-4");

      expect(reason).toContain("no longer available");
    });
  });

  describe("usesLockedPostProcessingModel (private)", () => {
    it("returns true in standard mode", () => {
      mockPlugin.settings.settingsMode = "standard";
      mockPlugin.settings.useLatestModelEverywhere = false;

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = (service as any).usesLockedPostProcessingModel();

      expect(result).toBe(true);
    });

    it("returns true when useLatestModelEverywhere is true", () => {
      mockPlugin.settings.settingsMode = "advanced";
      mockPlugin.settings.useLatestModelEverywhere = true;

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = (service as any).usesLockedPostProcessingModel();

      expect(result).toBe(true);
    });

    it("returns false in advanced mode with custom model", () => {
      mockPlugin.settings.settingsMode = "advanced";
      mockPlugin.settings.useLatestModelEverywhere = false;

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = (service as any).usesLockedPostProcessingModel();

      expect(result).toBe(false);
    });

    it("defaults useLatestModelEverywhere to true when undefined", () => {
      mockPlugin.settings.settingsMode = "advanced";
      mockPlugin.settings.useLatestModelEverywhere = undefined;

      const service = PostProcessingService.getInstance(mockPlugin);
      const result = (service as any).usesLockedPostProcessingModel();

      expect(result).toBe(true);
    });
  });

  describe("promptPostProcessingModelFix (private)", () => {
    it("opens modal when not already visible", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");

      const service = PostProcessingService.getInstance(mockPlugin);
      await (service as any).promptPostProcessingModelFix("openai@@gpt-4");

      expect(PostProcessingModelPromptModal).toHaveBeenCalled();
    });

    it("does not open modal when already visible", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");

      (PostProcessingService as any).promptVisible = true;

      const service = PostProcessingService.getInstance(mockPlugin);
      await (service as any).promptPostProcessingModelFix("openai@@gpt-4");

      expect(PostProcessingModelPromptModal).not.toHaveBeenCalled();
    });

    it("passes alternative model to modal", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");
      const alternativeModel = { id: "openai@@gpt-3.5-turbo", name: "GPT-3.5" };

      const service = PostProcessingService.getInstance(mockPlugin);
      await (service as any).promptPostProcessingModelFix(
        "openai@@gpt-4",
        alternativeModel
      );

      expect(PostProcessingModelPromptModal).toHaveBeenCalledWith(
        mockPlugin,
        expect.objectContaining({
          alternativeModel,
        })
      );
    });

    it("sets scope based on locked model state", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");
      mockPlugin.settings.settingsMode = "standard";

      const service = PostProcessingService.getInstance(mockPlugin);
      await (service as any).promptPostProcessingModelFix("openai@@gpt-4");

      expect(PostProcessingModelPromptModal).toHaveBeenCalledWith(
        mockPlugin,
        expect.objectContaining({
          scope: "global",
        })
      );
    });

    it("sets scope to post-processing in advanced mode", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");
      mockPlugin.settings.settingsMode = "advanced";
      mockPlugin.settings.useLatestModelEverywhere = false;

      // Reset singleton to pick up new settings
      (PostProcessingService as any).instance = null;

      const service = PostProcessingService.getInstance(mockPlugin);
      await (service as any).promptPostProcessingModelFix("openai@@gpt-4");

      expect(PostProcessingModelPromptModal).toHaveBeenCalledWith(
        mockPlugin,
        expect.objectContaining({
          scope: "post-processing",
        })
      );
    });
  });
});
