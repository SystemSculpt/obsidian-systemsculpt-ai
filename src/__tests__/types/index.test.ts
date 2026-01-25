/**
 * @jest-environment node
 */

// Mock TFile before importing
jest.mock("obsidian", () => ({
  TFile: jest.fn().mockImplementation(() => ({})),
}));

import type { ChatState } from "../../types/index";
import type { ToolCallState, ToolCall } from "../../types/index";

describe("types/index exports", () => {
  describe("ChatState type", () => {
    it("can create a minimal chat state", () => {
      const state: ChatState = {
        chatId: "chat_123",
        selectedModelId: "gpt-4",
        chatTitle: "My Chat",
      };

      expect(state.chatId).toBe("chat_123");
      expect(state.selectedModelId).toBe("gpt-4");
      expect(state.chatTitle).toBe("My Chat");
    });

    it("can have optional systemPromptType as general-use", () => {
      const state: ChatState = {
        chatId: "chat_1",
        selectedModelId: "gpt-4",
        chatTitle: "Chat",
        systemPromptType: "general-use",
      };

      expect(state.systemPromptType).toBe("general-use");
    });

    it("can have optional systemPromptType as concise", () => {
      const state: ChatState = {
        chatId: "chat_2",
        selectedModelId: "gpt-4",
        chatTitle: "Chat",
        systemPromptType: "concise",
      };

      expect(state.systemPromptType).toBe("concise");
    });

    it("can have optional systemPromptType as agent", () => {
      const state: ChatState = {
        chatId: "chat_3",
        selectedModelId: "gpt-4",
        chatTitle: "Chat",
        systemPromptType: "agent",
      };

      expect(state.systemPromptType).toBe("agent");
    });

    it("can have optional systemPromptType as custom", () => {
      const state: ChatState = {
        chatId: "chat_4",
        selectedModelId: "gpt-4",
        chatTitle: "Chat",
        systemPromptType: "custom",
      };

      expect(state.systemPromptType).toBe("custom");
    });

    it("can have optional systemPromptPath", () => {
      const state: ChatState = {
        chatId: "chat_5",
        selectedModelId: "gpt-4",
        chatTitle: "Chat",
        systemPromptType: "custom",
        systemPromptPath: "/prompts/custom-prompt.md",
      };

      expect(state.systemPromptPath).toBe("/prompts/custom-prompt.md");
    });

    it("can have optional messages array", () => {
      const state: ChatState = {
        chatId: "chat_6",
        selectedModelId: "gpt-4",
        chatTitle: "Chat",
        messages: [],
      };

      expect(state.messages).toEqual([]);
    });

    it("all optional fields can be undefined", () => {
      const state: ChatState = {
        chatId: "chat_7",
        selectedModelId: "gpt-4",
        chatTitle: "Chat",
      };

      expect(state.systemPromptType).toBeUndefined();
      expect(state.systemPromptPath).toBeUndefined();
      expect(state.messages).toBeUndefined();
    });

    it("can have all fields populated", () => {
      const state: ChatState = {
        chatId: "full_chat",
        selectedModelId: "claude-3",
        chatTitle: "Complete Chat",
        systemPromptType: "custom",
        systemPromptPath: "/prompts/special.md",
        messages: [
          {
            role: "user",
            content: "Hello",
            message_id: "msg_1",
          },
        ],
      };

      expect(state.chatId).toBe("full_chat");
      expect(state.selectedModelId).toBe("claude-3");
      expect(state.chatTitle).toBe("Complete Chat");
      expect(state.systemPromptType).toBe("custom");
      expect(state.systemPromptPath).toBe("/prompts/special.md");
      expect(state.messages?.length).toBe(1);
    });
  });

  describe("re-exports from toolCalls", () => {
    it("exports ToolCallState type", () => {
      const state: ToolCallState = "pending";
      expect(state).toBe("pending");
    });

    it("ToolCallState can be all valid values", () => {
      const states: ToolCallState[] = [
        "pending",
        "approved",
        "denied",
        "executing",
        "completed",
        "failed",
      ];

      expect(states.length).toBe(6);
    });
  });
});
