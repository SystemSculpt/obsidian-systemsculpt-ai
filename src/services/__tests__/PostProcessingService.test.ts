import { PostProcessingService } from "../PostProcessingService";
import { SystemSculptError } from "../../utils/errors";
import { DEFAULT_SETTINGS } from "../../types";

// The canonical managed SystemSculpt model id. getPostProcessingModelId() only
// resolves to this as a last-resort fallback now (#97) — it is no longer the
// hardcoded post-processing model.
const MANAGED_MODEL_ID = "systemsculpt@@systemsculpt/ai-agent";
// A BYOK model the user explicitly chose for post-processing.
const CONFIGURED_MODEL_ID = "openai@@gpt-4";
// The active chat model (selectedModelId) — the fallback when no dedicated
// post-processing model is set.
const CHAT_MODEL_ID = "anthropic@@claude-sonnet-4";

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
    // By default the user has chosen a dedicated BYOK post-processing model.
    postProcessingModelId: CONFIGURED_MODEL_ID,
    postProcessingProviderId: "openai",
    selectedModelId: CHAT_MODEL_ID,
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
    it("uses the dedicated post-processing model when one is configured (#97)", () => {
      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toBe(CONFIGURED_MODEL_ID);
    });

    it("falls back to the active chat model when no post-processing model is set", () => {
      mockPlugin.settings.postProcessingModelId = "";

      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toBe(CHAT_MODEL_ID);
    });

    it("treats a blank/whitespace post-processing model as unset", () => {
      mockPlugin.settings.postProcessingModelId = "   ";

      const service = PostProcessingService.getInstance(mockPlugin);
      const modelId = (service as any).getPostProcessingModelId();

      expect(modelId).toBe(CHAT_MODEL_ID);
    });

    it("falls back to the managed model only when neither a post-processing nor chat model exists", () => {
      mockPlugin.settings.postProcessingModelId = "";
      mockPlugin.settings.selectedModelId = "";

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

    it("post-processes through a BYOK model without a SystemSculpt license (#97)", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");
      // BYOK user: no managed access at all.
      mockPlugin.settings.licenseKey = "";
      mockPlugin.settings.licenseValid = false;
      mockSculptService.streamMessage.mockReturnValue(
        (async function* () {
          yield { type: "content", text: "clean text" };
        })()
      );

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("raw text")).resolves.toBe("clean text");

      // The dedicated BYOK model routes through the same provider runtime the
      // chat uses — it must not be blocked behind a managed license.
      expect(mockSculptService.streamMessage).toHaveBeenCalledWith(
        expect.objectContaining({ model: CONFIGURED_MODEL_ID })
      );
      expect(PostProcessingModelPromptModal).not.toHaveBeenCalled();
    });

    it("returns the original text and opens recovery guidance only when the managed model is selected without access", async () => {
      const { PostProcessingModelPromptModal } = require("../../modals/PostProcessingModelPromptModal");
      // The managed model is selected, but there is no valid license.
      mockPlugin.settings.postProcessingModelId = MANAGED_MODEL_ID;
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

    it("processes text through the configured post-processing model (#97)", async () => {
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
          model: CONFIGURED_MODEL_ID,
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

    it("falls back to the chat model when no post-processing model is set", async () => {
      mockPlugin.settings.postProcessingModelId = "";
      mockSculptService.streamMessage.mockReturnValue(
        (async function* () {
          yield { type: "content", text: "done" };
        })()
      );

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("text")).resolves.toBe("done");
      expect(mockSculptService.streamMessage).toHaveBeenCalledWith(
        expect.objectContaining({ model: CHAT_MODEL_ID })
      );
    });

    it("falls back to the default clean-up prompt when the configured prompt is blank", async () => {
      mockPlugin.settings.postProcessingPrompt = "   ";
      mockSculptService.streamMessage.mockReturnValue(
        (async function* () {
          yield { type: "content", text: "Processed text" };
        })()
      );

      const service = PostProcessingService.getInstance(mockPlugin);
      await expect(service.processTranscription("original text")).resolves.toBe("Processed text");
      expect(mockSculptService.streamMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "system",
              content: DEFAULT_SETTINGS.postProcessingPrompt,
            }),
          ]),
        })
      );
    });

    it("returns the original text when validation says the model is unavailable", async () => {
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

    it("falls back to the default cleanup prompt when the stored prompt is blank", async () => {
      mockPlugin.settings.postProcessingPrompt = "   ";
      mockSculptService.streamMessage.mockReturnValue(
        (async function* () {
          yield { type: "content", text: "Processed text" };
        })()
      );

      const service = PostProcessingService.getInstance(mockPlugin);
      await service.processTranscription("test");

      expect(mockSculptService.streamMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "system",
              content: expect.stringContaining("You are a transcription post-processor."),
            }),
          ]),
        })
      );
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
    it("resolves when the model is available", async () => {
      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability(CONFIGURED_MODEL_ID)
      ).resolves.not.toThrow();
    });

    it("throws a SystemSculptError when the model is unavailable", async () => {
      mockPlugin.modelService.validateSpecificModel.mockResolvedValueOnce({
        isAvailable: false,
      });

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability(CONFIGURED_MODEL_ID)
      ).rejects.toThrow(SystemSculptError);
    });

    it("includes the model id in error metadata", async () => {
      mockPlugin.modelService.validateSpecificModel.mockResolvedValueOnce({
        isAvailable: false,
      });

      const service = PostProcessingService.getInstance(mockPlugin);

      try {
        await (service as any).ensurePostProcessingModelAvailability(CONFIGURED_MODEL_ID);
        fail("Expected error");
      } catch (error) {
        expect(error).toBeInstanceOf(SystemSculptError);
        expect((error as SystemSculptError).metadata?.model).toBe(CONFIGURED_MODEL_ID);
      }
    });

    it("re-throws existing SystemSculptError values", async () => {
      const originalError = new SystemSculptError("Custom error", "CUSTOM", 400);
      mockPlugin.modelService.validateSpecificModel.mockRejectedValueOnce(originalError);

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability(CONFIGURED_MODEL_ID)
      ).rejects.toBe(originalError);
    });

    it("wraps validation failures as model unavailability", async () => {
      mockPlugin.modelService.validateSpecificModel.mockRejectedValueOnce(
        new Error("Validation failed")
      );

      const service = PostProcessingService.getInstance(mockPlugin);

      await expect(
        (service as any).ensurePostProcessingModelAvailability(CONFIGURED_MODEL_ID)
      ).rejects.toThrow(SystemSculptError);
    });
  });

  describe("buildModelUnavailableReason (private)", () => {
    it("gives model-agnostic guidance for a non-managed (BYOK) model", () => {
      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(CONFIGURED_MODEL_ID);

      expect(reason).toContain(CONFIGURED_MODEL_ID);
      // The whole point of #97 is that post-processing is no longer SystemSculpt-only.
      expect(reason).not.toContain("only through SystemSculpt");
    });

    it("explains when the license key is missing for the managed model", () => {
      mockPlugin.settings.licenseKey = "";

      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(MANAGED_MODEL_ID);

      expect(reason).toContain("no license key");
      expect(reason).toContain("SystemSculpt");
    });

    it("explains when the managed license has not been validated", () => {
      mockPlugin.settings.licenseKey = "valid";
      mockPlugin.settings.licenseValid = false;

      const service = PostProcessingService.getInstance(mockPlugin);
      const reason = (service as any).buildModelUnavailableReason(MANAGED_MODEL_ID);

      expect(reason).toContain("not been validated");
      expect(reason).toContain("Setup");
    });

    it("returns a generic managed-service reason for managed runtime failures", () => {
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
