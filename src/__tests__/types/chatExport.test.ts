/**
 * @jest-environment node
 */
import {
  createDefaultChatExportOptions,
  mergeChatExportOptions,
  normalizeChatExportOptions,
  ChatExportOptions,
} from "../../types/chatExport";

describe("chatExport", () => {
  describe("createDefaultChatExportOptions", () => {
    it("returns default options object", () => {
      const options = createDefaultChatExportOptions();

      expect(options).toBeDefined();
      expect(typeof options).toBe("object");
    });

    it("returns correct default values", () => {
      const options = createDefaultChatExportOptions();

      expect(options.includeMetadata).toBe(true);
      expect(options.includeSystemPrompt).toBe(true);
      expect(options.includeContextFiles).toBe(true);
      expect(options.includeContextFileContents).toBe(true);
      expect(options.includeConversation).toBe(true);
      expect(options.includeUserMessages).toBe(true);
      expect(options.includeAssistantMessages).toBe(true);
      expect(options.includeToolMessages).toBe(false);
      expect(options.includeReasoning).toBe(true);
      expect(options.includeToolCalls).toBe(true);
      expect(options.includeToolCallArguments).toBe(true);
      expect(options.includeToolCallResults).toBe(true);
      expect(options.includeImages).toBe(true);
    });

    it("returns a new object each time", () => {
      const options1 = createDefaultChatExportOptions();
      const options2 = createDefaultChatExportOptions();

      expect(options1).not.toBe(options2);
      expect(options1).toEqual(options2);
    });

    it("returned object can be modified without affecting future calls", () => {
      const options1 = createDefaultChatExportOptions();
      options1.includeMetadata = false;

      const options2 = createDefaultChatExportOptions();

      expect(options2.includeMetadata).toBe(true);
    });
  });

  describe("mergeChatExportOptions", () => {
    it("returns copy of base when no overrides", () => {
      const base = createDefaultChatExportOptions();

      const result = mergeChatExportOptions(base);

      expect(result).toEqual(base);
      expect(result).not.toBe(base);
    });

    it("returns copy of base when overrides is undefined", () => {
      const base = createDefaultChatExportOptions();

      const result = mergeChatExportOptions(base, undefined);

      expect(result).toEqual(base);
    });

    it("applies overrides to base options", () => {
      const base = createDefaultChatExportOptions();
      const overrides: Partial<ChatExportOptions> = {
        includeMetadata: false,
        includeImages: false,
      };

      const result = mergeChatExportOptions(base, overrides);

      expect(result.includeMetadata).toBe(false);
      expect(result.includeImages).toBe(false);
      // Other values should remain from base
      expect(result.includeSystemPrompt).toBe(true);
    });

    it("does not modify base object", () => {
      const base = createDefaultChatExportOptions();
      const originalMetadata = base.includeMetadata;

      mergeChatExportOptions(base, { includeMetadata: !originalMetadata });

      expect(base.includeMetadata).toBe(originalMetadata);
    });

    it("handles all options being overridden", () => {
      const base = createDefaultChatExportOptions();
      const overrides: ChatExportOptions = {
        includeMetadata: false,
        includeSystemPrompt: false,
        includeContextFiles: false,
        includeContextFileContents: false,
        includeConversation: false,
        includeUserMessages: false,
        includeAssistantMessages: false,
        includeToolMessages: true,
        includeReasoning: false,
        includeToolCalls: false,
        includeToolCallArguments: false,
        includeToolCallResults: false,
        includeImages: false,
      };

      const result = mergeChatExportOptions(base, overrides);

      expect(result).toEqual(overrides);
    });

    it("handles empty overrides object", () => {
      const base = createDefaultChatExportOptions();

      const result = mergeChatExportOptions(base, {});

      expect(result).toEqual(base);
    });
  });

  describe("normalizeChatExportOptions", () => {
    it("returns default options when no overrides", () => {
      const result = normalizeChatExportOptions();

      expect(result).toEqual(createDefaultChatExportOptions());
    });

    it("returns default options when overrides is undefined", () => {
      const result = normalizeChatExportOptions(undefined);

      expect(result).toEqual(createDefaultChatExportOptions());
    });

    it("applies partial overrides to defaults", () => {
      const result = normalizeChatExportOptions({
        includeMetadata: false,
      });

      expect(result.includeMetadata).toBe(false);
      expect(result.includeSystemPrompt).toBe(true);
      expect(result.includeConversation).toBe(true);
    });

    it("returns a new object each time", () => {
      const result1 = normalizeChatExportOptions();
      const result2 = normalizeChatExportOptions();

      expect(result1).not.toBe(result2);
    });

    it("applies multiple overrides correctly", () => {
      const result = normalizeChatExportOptions({
        includeToolMessages: true,
        includeImages: false,
        includeReasoning: false,
      });

      expect(result.includeToolMessages).toBe(true);
      expect(result.includeImages).toBe(false);
      expect(result.includeReasoning).toBe(false);
      // Remaining defaults
      expect(result.includeMetadata).toBe(true);
      expect(result.includeSystemPrompt).toBe(true);
    });
  });
});
