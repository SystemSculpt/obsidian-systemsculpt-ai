/**
 * @jest-environment node
 */

// Mock TFile before importing
jest.mock("obsidian", () => ({
  TFile: jest.fn().mockImplementation(() => ({})),
}));

import type { ChatState } from "../../types/index";
import type { ToolCallState } from "../../types/index";

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

    it("can have optional messages array", () => {
      const state: ChatState = {
        chatId: "chat_6",
        selectedModelId: "gpt-4",
        chatTitle: "Chat",
        messages: [],
      };

      expect(state.messages).toEqual([]);
    });

    it("omits legacy prompt selection fields from the public chat state contract", () => {
      const state: ChatState = {
        chatId: "chat_7",
        selectedModelId: "gpt-4",
        chatTitle: "Chat",
      };

      expect(state).not.toHaveProperty("systemPromptType");
      expect(state).not.toHaveProperty("systemPromptPath");
    });

    it("can have all supported fields populated", () => {
      const state: ChatState = {
        chatId: "full_chat",
        selectedModelId: "claude-3",
        chatTitle: "Complete Chat",
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
