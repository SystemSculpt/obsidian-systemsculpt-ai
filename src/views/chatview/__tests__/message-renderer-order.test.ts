/**
 * @jest-environment jsdom
 */

import { MessageRenderer } from "../MessageRenderer";
import type { MessagePart } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { App } from "obsidian";

const createToolCall = (id: string, timestamp: number): ToolCall => ({
  id,
  messageId: "message-1",
  request: {
    id,
    type: "function",
    function: {
      name: "mcp-filesystem_search",
      arguments: JSON.stringify({ query: id }),
    },
  },
  state: "completed",
  timestamp,
});

const createToolCallPart = (id: string, timestamp: number): MessagePart => ({
  id: `part-${id}`,
  type: "tool_call",
  timestamp,
  data: createToolCall(id, timestamp),
});

describe("MessageRenderer tool call ordering", () => {
  test("maintains chronological order when new tool calls arrive after prior renders", () => {
    const app = new App();
    class TestMessageRenderer extends MessageRenderer {
      register(_callback: () => void): void {}
    }

    const renderer = new TestMessageRenderer(app as any);
    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");
    messageEl.dataset.messageId = "message-1";

    const contentContainer = document.createElement("div");
    contentContainer.classList.add("systemsculpt-message-content");
    messageEl.appendChild(contentContainer);

    const first = createToolCallPart("1", 1);
    const second = createToolCallPart("2", 2);

    renderer.renderUnifiedMessageParts(messageEl, [first, second], false);

    // With the new inline structure, each tool call is a separate inline collapsible block
    const initialBlocks = Array.from(
      messageEl.querySelectorAll<HTMLElement>(".systemsculpt-inline-tool_call")
    );
    expect(initialBlocks.length).toBe(2);

    // Check data-part-id ordering matches chronological order
    const initialPartIds = initialBlocks.map((el) => el.dataset.partId);
    expect(initialPartIds).toEqual(["part-1", "part-2"]);

    const third = createToolCallPart("3", 3);
    renderer.renderUnifiedMessageParts(messageEl, [first, second, third], false);

    const blocks = Array.from(
      messageEl.querySelectorAll<HTMLElement>(".systemsculpt-inline-tool_call")
    );
    expect(blocks.length).toBe(3);

    // Verify chronological order by part IDs
    const partIds = blocks.map((el) => el.dataset.partId);
    expect(partIds).toEqual(["part-1", "part-2", "part-3"]);

    // Verify tool summaries contain search info
    const summaries = blocks.map(
      (el) => el.querySelector(".systemsculpt-inline-tool-summary")?.textContent?.trim()
    );
    expect(summaries).toEqual([
      "Searched 1",
      "Searched 2",
      "Searched 3",
    ]);

    renderer.unload();
  });
});
