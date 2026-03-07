/**
 * @jest-environment jsdom
 */

import { MessageRenderer } from "../MessageRenderer";
import type { MessagePart } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { App } from "obsidian";

const createToolCall = (
  id: string,
  timestamp: number,
  functionName: string = "mcp-filesystem_search",
  functionArgs: Record<string, unknown> = { query: id }
): ToolCall => ({
  id,
  messageId: "message-1",
  request: {
    id,
    type: "function",
    function: {
      name: functionName,
      arguments: JSON.stringify(functionArgs),
    },
  },
  state: "completed",
  timestamp,
});

const createToolCallPart = (
  id: string,
  timestamp: number,
  functionName: string = "mcp-filesystem_search",
  functionArgs: Record<string, unknown> = { query: id }
): MessagePart => ({
  id: `part-${id}`,
  type: "tool_call",
  timestamp,
  data: createToolCall(id, timestamp, functionName, functionArgs),
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

    // Pi-first assistant UX collapses tool work into one activity block.
    const initialBlocks = Array.from(
      messageEl.querySelectorAll<HTMLElement>(".systemsculpt-inline-tool_call")
    );
    expect(initialBlocks.length).toBe(1);

    const initialSummaries = Array.from(
      messageEl.querySelectorAll<HTMLElement>(".systemsculpt-inline-tool-summary")
    ).map((el) => el.textContent?.trim());
    expect(initialSummaries).toEqual([
      "Searched 1",
      "Searched 2",
    ]);

    const third = createToolCallPart("3", 3);
    renderer.renderUnifiedMessageParts(messageEl, [first, second, third], false);

    const blocks = Array.from(
      messageEl.querySelectorAll<HTMLElement>(".systemsculpt-inline-tool_call")
    );
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.dataset.aggregateSection).toBe("activity");

    // Verify tool summaries contain search info
    const summaries = Array.from(
      messageEl.querySelectorAll<HTMLElement>(".systemsculpt-inline-tool-summary")
    ).map(
      (el) => el.textContent?.trim()
    );
    expect(summaries).toEqual([
      "Searched 1",
      "Searched 2",
      "Searched 3",
    ]);

    renderer.unload();
  });

  test("renders web_search with an explicit Web Search label", () => {
    const app = new App();
    class TestMessageRenderer extends MessageRenderer {
      register(_callback: () => void): void {}
    }

    const renderer = new TestMessageRenderer(app as any);
    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");
    messageEl.dataset.messageId = "message-web-search";

    const contentContainer = document.createElement("div");
    contentContainer.classList.add("systemsculpt-message-content");
    messageEl.appendChild(contentContainer);

    const webSearchPart = createToolCallPart(
      "web-1",
      1,
      "web_search",
      { query: "systemsculpt pricing" }
    );

    renderer.renderUnifiedMessageParts(messageEl, [webSearchPart], false);

    const title = messageEl.querySelector<HTMLElement>(".systemsculpt-inline-collapsible-title");
    expect(title?.textContent).toBe("Activity");

    const summary = messageEl.querySelector<HTMLElement>(".systemsculpt-inline-tool-summary");
    expect(summary?.textContent?.trim()).toBe("Searched systemsculpt pricing");

    renderer.unload();
  });
});
