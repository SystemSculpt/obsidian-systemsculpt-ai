/**
 * @jest-environment jsdom
 */

import { App, MarkdownRenderer } from "obsidian";
import { MessageRenderer } from "../MessageRenderer";
import type { MessagePart } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";

class TestMessageRenderer extends MessageRenderer {
  register(_callback: () => void): void {}
}

describe("MessageRenderer reasoning layout", () => {
  test("merges consecutive reasoning parts into one reasoning chain", async () => {
    const app = new App();
    const renderer = new TestMessageRenderer(app as any);

    const markdownSpy = jest
      .spyOn(MarkdownRenderer, "render")
      .mockResolvedValue();

    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");
    messageEl.dataset.messageId = "message-reasoning-merge";

    const contentContainer = document.createElement("div");
    contentContainer.classList.add("systemsculpt-message-content");
    messageEl.appendChild(contentContainer);

    const parts: MessagePart[] = [
      {
        id: "reasoning-1",
        type: "reasoning",
        timestamp: 1,
        data: "First",
      } as MessagePart,
      {
        id: "reasoning-2",
        type: "reasoning",
        timestamp: 2,
        data: "Second",
      } as MessagePart,
      {
        id: "reasoning-3",
        type: "reasoning",
        timestamp: 3,
        data: "Third",
      } as MessagePart,
    ];

    renderer.renderUnifiedMessageParts(messageEl, parts, false);

    // Allow async markdown rendering to resolve
    await Promise.resolve();
    await Promise.resolve();

    // With the new inline collapsible structure, merged reasoning creates one block
    const wrappers = messageEl.querySelectorAll(".systemsculpt-inline-reasoning");
    expect(wrappers.length).toBe(1);

    expect(markdownSpy).toHaveBeenCalledTimes(1);
    expect(markdownSpy.mock.calls[0][1]).toBe("FirstSecondThird");

    markdownSpy.mockRestore();
    renderer.unload();
  });

  test("does not merge reasoning when separated by tool calls", async () => {
    const app = new App();
    const renderer = new TestMessageRenderer(app as any);

    const markdownSpy = jest
      .spyOn(MarkdownRenderer, "render")
      .mockResolvedValue();

    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");
    messageEl.dataset.messageId = "message-reasoning-no-merge";

    const contentContainer = document.createElement("div");
    contentContainer.classList.add("systemsculpt-message-content");
    messageEl.appendChild(contentContainer);

    const toolCall: ToolCall = {
      id: "call_1",
      messageId: "message-reasoning-no-merge",
      request: {
        id: "call_1",
        type: "function",
        function: {
          name: "mcp-filesystem_read",
          arguments: "{}",
        },
      },
      state: "completed",
      timestamp: 2,
    };

    const parts: MessagePart[] = [
      {
        id: "reasoning-1",
        type: "reasoning",
        timestamp: 1,
        data: "First",
      } as MessagePart,
      {
        id: "tool-1",
        type: "tool_call",
        timestamp: 2,
        data: toolCall,
      } as MessagePart,
      {
        id: "reasoning-2",
        type: "reasoning",
        timestamp: 3,
        data: "Second",
      } as MessagePart,
    ];

    renderer.renderUnifiedMessageParts(messageEl, parts, false);

    // Allow async markdown rendering to resolve
    await Promise.resolve();
    await Promise.resolve();

    // Use new inline reasoning class
    const wrappers = messageEl.querySelectorAll(".systemsculpt-inline-reasoning");
    expect(wrappers.length).toBe(2);
    expect(markdownSpy).toHaveBeenCalledTimes(2);

    markdownSpy.mockRestore();
    renderer.unload();
  });

  test("interleaves tool call groups between reasoning blocks in chronological order", async () => {
    const app = new App();
    const renderer = new TestMessageRenderer(app as any);

    const markdownSpy = jest
      .spyOn(MarkdownRenderer, "render")
      .mockResolvedValue();

    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");
    messageEl.dataset.messageId = "message-activity-ordering";

    const contentContainer = document.createElement("div");
    contentContainer.classList.add("systemsculpt-message-content");
    messageEl.appendChild(contentContainer);

    const moveCall: ToolCall = {
      id: "call_move",
      messageId: "message-activity-ordering",
      request: {
        id: "call_move",
        type: "function",
        function: {
          name: "mcp-filesystem_move",
          arguments: JSON.stringify({
            items: [{ source: "20 - projects/Main ToDo List.md", destination: "Main ToDo List.md" }],
          }),
        },
      },
      state: "completed",
      timestamp: 2,
    };

    const listCall: ToolCall = {
      id: "call_list",
      messageId: "message-activity-ordering",
      request: {
        id: "call_list",
        type: "function",
        function: {
          name: "mcp-filesystem_list_items",
          arguments: JSON.stringify({ path: "20 - projects" }),
        },
      },
      state: "completed",
      timestamp: 4,
    };

    const findCall: ToolCall = {
      id: "call_find",
      messageId: "message-activity-ordering",
      request: {
        id: "call_find",
        type: "function",
        function: {
          name: "mcp-filesystem_find",
          arguments: JSON.stringify({ query: "Main ToDo List" }),
        },
      },
      state: "completed",
      timestamp: 6,
    };

    const parts: MessagePart[] = [
      {
        id: "reasoning-1",
        type: "reasoning",
        timestamp: 1,
        data: "Step 1",
      } as MessagePart,
      {
        id: "tool_call_part-call_move",
        type: "tool_call",
        timestamp: 2,
        data: moveCall,
      } as MessagePart,
      {
        id: "reasoning-2",
        type: "reasoning",
        timestamp: 3,
        data: "Step 2",
      } as MessagePart,
      {
        id: "tool_call_part-call_list",
        type: "tool_call",
        timestamp: 4,
        data: listCall,
      } as MessagePart,
      {
        id: "reasoning-3",
        type: "reasoning",
        timestamp: 5,
        data: "Step 3",
      } as MessagePart,
      {
        id: "tool_call_part-call_find",
        type: "tool_call",
        timestamp: 6,
        data: findCall,
      } as MessagePart,
      {
        id: "reasoning-4",
        type: "reasoning",
        timestamp: 7,
        data: "Step 4",
      } as MessagePart,
      {
        id: "content-1",
        type: "content",
        timestamp: 8,
        data: "Done",
      } as MessagePart,
    ];

    renderer.renderUnifiedMessageParts(messageEl, parts, false);

    // Allow async markdown rendering to resolve
    await Promise.resolve();
    await Promise.resolve();

    // With the new inline structure, parts are rendered in chronological order directly in the message
    const unifiedParts = messageEl.querySelectorAll<HTMLElement>(".systemsculpt-unified-part");
    expect(unifiedParts.length).toBeGreaterThan(0);

    const sequence = Array.from(unifiedParts).map((el) => {
      if (el.classList.contains("systemsculpt-inline-reasoning")) {
        return `reasoning:${el.dataset.partId}`;
      }
      if (el.classList.contains("systemsculpt-inline-tool_call")) {
        return `tool:${el.dataset.partId}`;
      }
      if (el.classList.contains("systemsculpt-content-part")) {
        return `content:${el.dataset.partId}`;
      }
      return `other:${el.className}`;
    });

    // Verify chronological order: reasoning, tool, reasoning, tool, reasoning, tool, reasoning, content
    expect(sequence).toEqual([
      "reasoning:reasoning-1",
      "tool:tool_call_part-call_move",
      "reasoning:reasoning-2",
      "tool:tool_call_part-call_list",
      "reasoning:reasoning-3",
      "tool:tool_call_part-call_find",
      "reasoning:reasoning-4",
      "content:content-1",
    ]);

    markdownSpy.mockRestore();
    renderer.unload();
  });

  test("renders reasoning as inline collapsible block", async () => {
    const app = new App();
    const renderer = new TestMessageRenderer(app as any);

    const markdownSpy = jest
      .spyOn(MarkdownRenderer, "render")
      .mockResolvedValue();

    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");
    messageEl.dataset.messageId = "message-reasoning";

    const contentContainer = document.createElement("div");
    contentContainer.classList.add("systemsculpt-message-content");
    contentContainer.style.fontSize = "16px";
    messageEl.appendChild(contentContainer);

    const parts: MessagePart[] = [
      {
        id: "reasoning-1",
        type: "reasoning",
        timestamp: 1,
        data: "**Plan**\n- Step 1",
      } as MessagePart,
      {
        id: "content-1",
        type: "content",
        timestamp: 2,
        data: "Done",
      } as MessagePart,
    ];

    renderer.renderUnifiedMessageParts(messageEl, parts, false);

    // Allow async markdown rendering to resolve
    await Promise.resolve();
    await Promise.resolve();

    // Verify inline collapsible reasoning block is created
    const reasoningBlock = messageEl.querySelector<HTMLElement>(".systemsculpt-inline-reasoning");
    expect(reasoningBlock).not.toBeNull();
    expect(reasoningBlock?.classList.contains("systemsculpt-inline-collapsible")).toBe(true);
    expect(reasoningBlock?.classList.contains("systemsculpt-unified-part")).toBe(true);

    // Verify header with title
    const header = reasoningBlock?.querySelector<HTMLElement>(".systemsculpt-inline-collapsible-header");
    expect(header).not.toBeNull();

    const title = header?.querySelector<HTMLElement>(".systemsculpt-inline-collapsible-title");
    expect(title?.textContent).toBe("Reasoning");

    // Verify reasoning text container
    const reasoningText = reasoningBlock?.querySelector<HTMLElement>(".systemsculpt-inline-reasoning-text");
    expect(reasoningText).not.toBeNull();
    expect(reasoningText?.classList.contains("markdown-rendered")).toBe(true);

    // No old drawer structure
    const drawer = messageEl.querySelector(".systemsculpt-activity-drawer");
    expect(drawer).toBeNull();

    markdownSpy.mockRestore();
    renderer.unload();
  });

  test("strips blank paragraphs from reasoning output", async () => {
    const app = new App();
    const renderer = new TestMessageRenderer(app as any);

    const markdownSpy = jest
      .spyOn(MarkdownRenderer, "render")
      .mockImplementation(async (_app, _markdown, container) => {
        const blankBreak = container.createEl("p");
        blankBreak.createEl("br");

        const whitespace = container.createEl("p");
        whitespace.textContent = "   ";

        const actual = container.createEl("p");
        actual.textContent = "First insight";

        const trailingWhitespace = container.createEl("p");
        trailingWhitespace.textContent = "\n";
      });

    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");
    messageEl.dataset.messageId = "message-reasoning-trim";

    const contentContainer = document.createElement("div");
    contentContainer.classList.add("systemsculpt-message-content");
    contentContainer.style.fontSize = "16px";
    messageEl.appendChild(contentContainer);

    const parts: MessagePart[] = [
      {
        id: "reasoning-compact",
        type: "reasoning",
        timestamp: 1,
        data: "First insight",
      } as MessagePart,
    ];

    renderer.renderUnifiedMessageParts(messageEl, parts, false);

    await Promise.resolve();
    await Promise.resolve();

    // Use new inline reasoning text class
    const reasoningText = messageEl.querySelector<HTMLElement>(".systemsculpt-inline-reasoning-text");
    expect(reasoningText).not.toBeNull();

    const paragraphs = Array.from(reasoningText!.querySelectorAll("p"));
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].textContent?.trim()).toBe("First insight");

    markdownSpy.mockRestore();
    renderer.unload();
  });

  test("applies compact spacing to reasoning paragraphs", async () => {
    const app = new App();
    const renderer = new TestMessageRenderer(app as any);

    const markdownSpy = jest
      .spyOn(MarkdownRenderer, "render")
      .mockImplementation(async (_app, _markdown, container) => {
        const first = container.createEl("p");
        first.textContent = "First insight";

        const second = container.createEl("p");
        second.textContent = "Second insight";
      });

    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");
    messageEl.dataset.messageId = "message-reasoning-compact";

    const contentContainer = document.createElement("div");
    contentContainer.classList.add("systemsculpt-message-content");
    contentContainer.style.fontSize = "16px";
    messageEl.appendChild(contentContainer);

    const parts: MessagePart[] = [
      {
        id: "reasoning-compact",
        type: "reasoning",
        timestamp: 1,
        data: "First insight\n\nSecond insight",
      } as MessagePart,
    ];

    renderer.renderUnifiedMessageParts(messageEl, parts, false);

    await Promise.resolve();
    await Promise.resolve();

    // Use new inline reasoning text class
    const reasoningText = messageEl.querySelector<HTMLElement>(".systemsculpt-inline-reasoning-text");
    expect(reasoningText).not.toBeNull();
    // Note: compact spacing is applied via CSS now, not inline styles
    // Just verify the element exists and has content
    expect(reasoningText!.classList.contains("markdown-rendered")).toBe(true);

    const paragraphs = Array.from(reasoningText!.querySelectorAll("p"));
    expect(paragraphs).toHaveLength(2);

    markdownSpy.mockRestore();
    renderer.unload();
  });

  test("renders reasoning content correctly", async () => {
    const app = new App();
    const renderer = new TestMessageRenderer(app as any);

    const markdownSpy = jest
      .spyOn(MarkdownRenderer, "render")
      .mockImplementation(async (_app, _markdown, container) => {
        container.createEl("p").textContent = "Line 1";
        container.createEl("p").textContent = "Line 2";
      });

    let messageEl: HTMLElement | null = null;
    try {
      messageEl = document.createElement("div");
      messageEl.classList.add("systemsculpt-message");
      messageEl.dataset.messageId = "message-reasoning-content";

      const contentContainer = document.createElement("div");
      contentContainer.classList.add("systemsculpt-message-content");
      contentContainer.style.fontSize = "16px";
      messageEl.appendChild(contentContainer);

      document.body.appendChild(messageEl);

      const parts: MessagePart[] = [
        {
          id: "reasoning-content",
          type: "reasoning",
          timestamp: 1,
          data: "Line 1\n\nLine 2",
        } as MessagePart,
      ];

      renderer.renderUnifiedMessageParts(messageEl, parts, false);

      // Use new inline reasoning text class
      const reasoningText = messageEl.querySelector<HTMLElement>(
        ".systemsculpt-inline-reasoning-text"
      );
      expect(reasoningText).not.toBeNull();
      expect(reasoningText?.classList.contains("markdown-rendered")).toBe(true);

      await Promise.resolve();
      await Promise.resolve();

      const paragraphs = reasoningText!.querySelectorAll("p");
      expect(paragraphs.length).toBe(2);
    } finally {
      markdownSpy.mockRestore();
      renderer.unload();
      if (messageEl && document.body.contains(messageEl)) {
        document.body.removeChild(messageEl);
      }
    }
  });
});
