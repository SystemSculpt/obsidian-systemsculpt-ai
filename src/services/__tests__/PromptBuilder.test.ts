/**
 * @jest-environment jsdom
 */
import { PromptBuilder, BuildPromptOptions } from "../PromptBuilder";
import { App } from "obsidian";
import { GENERAL_USE_PRESET } from "../../constants/prompts";

// Mock SystemPromptService
const mockGetSystemPromptContent = jest.fn();

jest.mock("../SystemPromptService", () => ({
  SystemPromptService: {
    getInstance: jest.fn(() => ({
      getSystemPromptContent: mockGetSystemPromptContent,
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
    mockGetSettings = () => ({});

    mockGetSystemPromptContent.mockResolvedValue("Base prompt content");
  });

  describe("buildSystemPrompt", () => {
    it("builds system prompt with default options", async () => {
      const result = await PromptBuilder.buildSystemPrompt(
        mockApp,
        mockGetSettings,
        {}
      );

      expect(result).toBe("Base prompt content");
      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "general-use",
        undefined
      );
    });

    it("uses specified prompt type", async () => {
      const opts: BuildPromptOptions = { type: "concise" };

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, opts);

      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "concise",
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
        "/path/to/custom/prompt.md"
      );
    });

    it("still forwards legacy agent selections to the shared service", async () => {
      const opts: BuildPromptOptions = {
        type: "agent",
      };

      await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, opts);

      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "agent",
        undefined
      );
    });

    it("falls back to GENERAL_USE_PRESET on getSystemPromptContent error", async () => {
      mockGetSystemPromptContent.mockRejectedValue(new Error("File not found"));

      const result = await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, {});

      expect(result).toBe("Default general use system prompt");
    });

    it("returns the resolved prompt for custom prompts", async () => {
      const opts: BuildPromptOptions = {
        type: "custom",
        path: "/my/prompt.md",
      };

      mockGetSystemPromptContent.mockResolvedValue("Custom base prompt");

      const result = await PromptBuilder.buildSystemPrompt(
        mockApp,
        mockGetSettings,
        opts
      );

      expect(result).toBe("Custom base prompt");
      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "custom",
        "/my/prompt.md"
      );
    });

    it("uses general-use when no explicit prompt type is provided", async () => {
      const result = await PromptBuilder.buildSystemPrompt(mockApp, mockGetSettings, {});

      expect(result).toBe("Base prompt content");
      expect(mockGetSystemPromptContent).toHaveBeenCalledWith(
        "general-use",
        undefined
      );
    });
  });
});
