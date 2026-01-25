/**
 * @jest-environment jsdom
 */
import { PromptBuilder, BuildPromptOptions } from "../PromptBuilder";
import { App } from "obsidian";
import { GENERAL_USE_PRESET } from "../../constants/prompts";

// Mock SystemPromptService
const mockGetSystemPromptContent = jest.fn();
const mockCombineWithAgentPrefix = jest.fn();
const mockAppendToolsHint = jest.fn();

jest.mock("../SystemPromptService", () => ({
  SystemPromptService: {
    getInstance: jest.fn(() => ({
      getSystemPromptContent: mockGetSystemPromptContent,
      combineWithAgentPrefix: mockCombineWithAgentPrefix,
      appendToolsHint: mockAppendToolsHint,
    })),
  },
}));

jest.mock("../../constants/prompts", () => ({
  GENERAL_USE_PRESET: {
    systemPrompt: "Default general use system prompt",
  },
}));

describe("PromptBuilder", () => {
  let mockApp: App;
  let mockGetSettings: () => any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = new App();
    mockGetSettings = () => ({ agentMode: false });

    // Default mock implementations
    mockGetSystemPromptContent.mockResolvedValue("Base prompt content");
    mockCombineWithAgentPrefix.mockResolvedValue("Combined prompt content");
    mockAppendToolsHint.mockReturnValue("Final prompt content");
  });

  describe("buildSystemPrompt", () => {
    it("builds system prompt with default options", async () => {
      const result = await PromptBuilder.buildSystemPrompt(
        mockApp,
        mockGetSettings,
        {}
      );

      expect(result).toBe("Final prompt content");
      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "general-use",
        undefined,
        undefined
      );
    });

    it("uses specified prompt type", async () => {
      const opts: BuildPromptOptions = { type: "concise" };

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, opts);

      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "concise",
        undefined,
        undefined
      );
    });

    it("passes custom path for custom type", async () => {
      const opts: BuildPromptOptions = {
        type: "custom",
        path: "/path/to/custom/prompt.md",
      };

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, opts);

      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "custom",
        "/path/to/custom/prompt.md",
        undefined
      );
    });

    it("passes agent mode to getSystemPromptContent", async () => {
      const opts: BuildPromptOptions = {
        type: "agent",
        agentMode: true,
      };

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, opts);

      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "agent",
        undefined,
        true
      );
    });

    it("calls combineWithAgentPrefix with base prompt", async () => {
      const opts: BuildPromptOptions = {
        type: "general-use",
        agentMode: true,
      };

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, opts);

      expect(mockCombineWithAgentPrefix).toHaveBeenCalledWith(
        "Base prompt content",
        "general-use",
        true
      );
    });

    it("calls appendToolsHint when hasTools is true", async () => {
      const opts: BuildPromptOptions = {
        hasTools: true,
      };

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, opts);

      expect(mockAppendToolsHint).toHaveBeenCalledWith(
        "Combined prompt content",
        true
      );
    });

    it("calls appendToolsHint with false when hasTools is not set", async () => {
      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, {});

      expect(mockAppendToolsHint).toHaveBeenCalledWith(
        "Combined prompt content",
        false
      );
    });

    it("falls back to GENERAL_USE_PRESET on getSystemPromptContent error", async () => {
      mockGetSystemPromptContent.mockRejectedValue(new Error("File not found"));

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, {});

      // Note: opts.type is passed as-is (undefined when not provided)
      expect(mockCombineWithAgentPrefix).toHaveBeenCalledWith(
        "Default general use system prompt",
        undefined,
        undefined
      );
    });

    it("uses GENERAL_USE_PRESET fallback when combineWithAgentPrefix returns empty", async () => {
      mockCombineWithAgentPrefix.mockResolvedValue("");

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, {});

      expect(mockAppendToolsHint).toHaveBeenCalledWith(
        "Default general use system prompt",
        false
      );
    });

    it("uses GENERAL_USE_PRESET fallback when combineWithAgentPrefix returns null", async () => {
      mockCombineWithAgentPrefix.mockResolvedValue(null);

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, {});

      expect(mockAppendToolsHint).toHaveBeenCalledWith(
        "Default general use system prompt",
        false
      );
    });

    it("combines all options correctly", async () => {
      const opts: BuildPromptOptions = {
        type: "custom",
        path: "/my/prompt.md",
        agentMode: true,
        hasTools: true,
      };

      mockGetSystemPromptContent.mockResolvedValue("Custom base prompt");
      mockCombineWithAgentPrefix.mockResolvedValue("Agent + Custom prompt");
      mockAppendToolsHint.mockReturnValue("Full combined prompt with tools");

      const result = await PromptBuilder.buildSystemPrompt(
        mockApp,
        mockGetSettings,
        opts
      );

      expect(result).toBe("Full combined prompt with tools");
      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "custom",
        "/my/prompt.md",
        true
      );
      expect(mockCombineWithAgentPrefix).toHaveBeenCalledWith(
        "Custom base prompt",
        "custom",
        true
      );
      expect(mockAppendToolsHint).toHaveBeenCalledWith(
        "Agent + Custom prompt",
        true
      );
    });

    it("handles agentMode: false explicitly", async () => {
      const opts: BuildPromptOptions = {
        agentMode: false,
      };

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, opts);

      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "general-use",
        undefined,
        false
      );
      // Note: opts.type is passed as-is (undefined when not provided)
      expect(mockCombineWithAgentPrefix).toHaveBeenCalledWith(
        "Base prompt content",
        undefined,
        false
      );
    });

    it("handles hasTools: false explicitly", async () => {
      const opts: BuildPromptOptions = {
        hasTools: false,
      };

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, opts);

      expect(mockAppendToolsHint).toHaveBeenCalledWith(
        "Combined prompt content",
        false
      );
    });
  });
});
