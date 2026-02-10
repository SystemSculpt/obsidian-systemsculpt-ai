/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { SystemPromptService } from "../SystemPromptService";

// Mock prompt constants
jest.mock("../../constants/prompts", () => ({
  LOCAL_SYSTEM_PROMPTS: [
    { id: "general-use", name: "General Use", systemPrompt: "General prompt" },
    { id: "concise", name: "Concise", systemPrompt: "Concise prompt" },
    { id: "agent", name: "Agent", systemPrompt: "Agent prompt" },
  ],
  GENERAL_USE_PRESET: { systemPrompt: "Default general use prompt" },
  CONCISE_PRESET: { systemPrompt: "Default concise prompt" },
  AGENT_PRESET: { systemPrompt: "Default agent prompt" },
}));

describe("SystemPromptService", () => {
  let service: SystemPromptService;
  let mockApp: App;
  let mockGetSettings: () => any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear singleton instance
    (SystemPromptService as any).instance = null;

    mockApp = new App();
    mockGetSettings = () => ({
      agentMode: false,
      systemPromptsDirectory: "SystemSculpt/System Prompts",
    });

    service = SystemPromptService.getInstance(mockApp, mockGetSettings);
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = SystemPromptService.getInstance(mockApp, mockGetSettings);
      const instance2 = SystemPromptService.getInstance(mockApp, mockGetSettings);

      expect(instance1).toBe(instance2);
    });

    it("updates settings getter on subsequent calls", () => {
      const settings1 = { agentMode: false };
      const settings2 = { agentMode: true };
      const getter1 = () => settings1;
      const getter2 = () => settings2;

      SystemPromptService.getInstance(mockApp, getter1);
      const instance = SystemPromptService.getInstance(mockApp, getter2);

      // The instance should use the new settings getter
      expect(instance).toBeDefined();
    });
  });

  describe("getSystemPromptContent", () => {
    it("returns general-use prompt", async () => {
      const content = await service.getSystemPromptContent("general-use");

      expect(content).toBe("Default general use prompt");
    });

    it("returns concise prompt", async () => {
      const content = await service.getSystemPromptContent("concise");

      expect(content).toBe("Default concise prompt");
    });

    it("returns agent prompt when agent mode is enabled", async () => {
      const content = await service.getSystemPromptContent("agent", undefined, true);

      expect(content).toBe("Default agent prompt");
    });

    it("falls back to general when agent mode is off but agent type selected", async () => {
      const content = await service.getSystemPromptContent("agent", undefined, false);

      expect(content).toBe("Default general use prompt");
    });

    it("uses settings agentMode when not explicitly provided", async () => {
      mockGetSettings = () => ({ agentMode: true });
      (SystemPromptService as any).instance = null;
      service = SystemPromptService.getInstance(mockApp, mockGetSettings);

      const content = await service.getSystemPromptContent("agent");

      expect(content).toBe("Default agent prompt");
    });

    it("reads custom prompt from file", async () => {
      const mockFile = new TFile({ path: "prompts/custom.md" });
      (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockFile);
      (mockApp.vault.read as jest.Mock).mockResolvedValue("Custom prompt content");

      const content = await service.getSystemPromptContent("custom", "prompts/custom.md");

      expect(content).toBe("Custom prompt content");
    });

    it("falls back to general when custom file not found", async () => {
      (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
      (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue([]);

      const content = await service.getSystemPromptContent("custom", "nonexistent.md");

      expect(content).toBe("Default general use prompt");
    });

    it("tries .md extension when file not found", async () => {
      const mockFile = new TFile({ path: "prompts/custom.md" });
      (mockApp.vault.getAbstractFileByPath as jest.Mock)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(mockFile);
      (mockApp.vault.read as jest.Mock).mockResolvedValue("Custom content");

      const content = await service.getSystemPromptContent("custom", "prompts/custom");

      expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalledWith("prompts/custom");
      expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalledWith("prompts/custom.md");
      expect(content).toBe("Custom content");
    });

    it("searches in system prompts directory", async () => {
      const mockFile = new TFile({ path: "SystemSculpt/System Prompts/custom.md" });
      (mockApp.vault.getAbstractFileByPath as jest.Mock)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(mockFile);
      (mockApp.vault.read as jest.Mock).mockResolvedValue("Found in prompts dir");

      const content = await service.getSystemPromptContent("custom", "custom");

      expect(content).toBe("Found in prompts dir");
    });

    it("searches recursively by basename", async () => {
      const mockFile = new TFile({
        path: "SystemSculpt/System Prompts/subfolder/custom.md",
        basename: "custom",
      });
      (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
      (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue([mockFile]);
      (mockApp.vault.read as jest.Mock).mockResolvedValue("Found recursively");

      const content = await service.getSystemPromptContent("custom", "custom");

      expect(content).toBe("Found recursively");
    });

    it("returns general fallback for unknown type", async () => {
      const content = await service.getSystemPromptContent("unknown" as any);

      expect(content).toBe("Default general use prompt");
    });
  });

  describe("combineWithAgentPrefix", () => {
    it("returns base prompt when agent mode is off", async () => {
      const result = await service.combineWithAgentPrefix("Base prompt", "general-use", false);

      expect(result).toBe("Base prompt");
    });

    it("returns base prompt when selected type is agent", async () => {
      const result = await service.combineWithAgentPrefix("Agent base", "agent", true);

      expect(result).toBe("Agent base");
    });

    it("prefixes agent prompt when agent mode is on", async () => {
      const result = await service.combineWithAgentPrefix("Base prompt", "general-use", true);

      expect(result).toBe("Default agent prompt\n\nBase prompt");
    });

    it("uses GENERAL_USE_PRESET when base is empty", async () => {
      const result = await service.combineWithAgentPrefix("", "general-use", false);

      expect(result).toBe("Default general use prompt");
    });

    it("uses GENERAL_USE_PRESET when base is undefined", async () => {
      const result = await service.combineWithAgentPrefix(undefined, "general-use", false);

      expect(result).toBe("Default general use prompt");
    });

    it("handles case-insensitive type matching", async () => {
      const result = await service.combineWithAgentPrefix("Base", "AGENT", true);

      expect(result).toBe("Base");
    });

    it("handles empty selectedType", async () => {
      const result = await service.combineWithAgentPrefix("Base", undefined, false);

      expect(result).toBe("Base");
    });
  });

  describe("appendToolsHint", () => {
    it("returns prompt unchanged when hasTools is false", () => {
      const result = service.appendToolsHint("Original prompt", false);

      expect(result).toBe("Original prompt");
    });

    it("appends tools hint when hasTools is true", () => {
      const result = service.appendToolsHint("Original prompt", true);

      expect(result).toContain("Original prompt");
      expect(result).toContain("web_search");
      expect(result).toContain("mcp-filesystem_read");
      expect(result).toContain("JSON");
    });

    it("handles empty prompt with tools hint", () => {
      const result = service.appendToolsHint("", true);

      expect(result).toContain("web_search");
      expect(result.startsWith("\n")).toBe(false);
    });
  });

  describe("getLocalPresets", () => {
    it("returns local system prompts", () => {
      const presets = service.getLocalPresets();

      expect(presets).toHaveLength(3);
      expect(presets[0].id).toBe("general-use");
    });
  });

  describe("getCustomPromptFiles", () => {
    it("returns custom prompt files from directory", async () => {
      const mockFiles = [
        new TFile({ path: "SystemSculpt/System Prompts/prompt1.md", basename: "prompt1" }),
        new TFile({ path: "SystemSculpt/System Prompts/prompt2.md", basename: "prompt2" }),
      ];
      (mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
      (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue(mockFiles);

      const files = await service.getCustomPromptFiles();

      expect(files).toHaveLength(2);
      expect(files[0].name).toBe("prompt1");
      expect(files[1].name).toBe("prompt2");
    });

    it("returns empty array when directory does not exist", async () => {
      (mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

      const files = await service.getCustomPromptFiles();

      expect(files).toEqual([]);
    });

    it("returns empty array on error", async () => {
      (mockApp.vault.adapter.exists as jest.Mock).mockRejectedValue(new Error("Access denied"));

      const files = await service.getCustomPromptFiles();

      expect(files).toEqual([]);
    });

    it("uses custom prompts directory from settings", async () => {
      mockGetSettings = () => ({ systemPromptsDirectory: "Custom/Prompts" });
      (SystemPromptService as any).instance = null;
      service = SystemPromptService.getInstance(mockApp, mockGetSettings);

      const mockFiles = [
        new TFile({ path: "Custom/Prompts/test.md", basename: "test" }),
      ];
      (mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
      (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue(mockFiles);

      const files = await service.getCustomPromptFiles();

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("Custom/Prompts/test.md");
    });

    it("filters files to only those in prompts directory", async () => {
      const mockFiles = [
        new TFile({ path: "SystemSculpt/System Prompts/valid.md", basename: "valid" }),
        new TFile({ path: "Other/folder/invalid.md", basename: "invalid" }),
      ];
      (mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
      (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue(mockFiles);

      const files = await service.getCustomPromptFiles();

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe("valid");
    });

    it("sorts files alphabetically by name", async () => {
      const mockFiles = [
        new TFile({ path: "SystemSculpt/System Prompts/zebra.md", basename: "zebra" }),
        new TFile({ path: "SystemSculpt/System Prompts/alpha.md", basename: "alpha" }),
      ];
      (mockApp.vault.adapter.exists as jest.Mock).mockResolvedValue(true);
      (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue(mockFiles);

      const files = await service.getCustomPromptFiles();

      expect(files[0].name).toBe("alpha");
      expect(files[1].name).toBe("zebra");
    });
  });
});
