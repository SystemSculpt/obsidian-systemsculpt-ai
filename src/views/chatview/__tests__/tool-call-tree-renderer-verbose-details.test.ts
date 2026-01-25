/**
 * @jest-environment jsdom
 */

import { ToolCallTreeRenderer } from "../renderers/ToolCallTreeRenderer";
import type { ToolCall } from "../../../types/toolCalls";

class StubMessageRenderer {
  public app: any = {};

  insertElementInOrder(messageEl: HTMLElement, newElement: HTMLElement, insertAfterElement?: HTMLElement | null): void {
    if (insertAfterElement && insertAfterElement.parentElement) {
      insertAfterElement.insertAdjacentElement("afterend", newElement);
    } else {
      messageEl.appendChild(newElement);
    }
  }
}

const createToolCall = (overrides: Partial<ToolCall> = {}): ToolCall => {
  const defaults: ToolCall = {
    id: "call-ops",
    messageId: "message-ops",
    request: {
      id: "call-ops",
      type: "function",
      function: {
        name: "mcp-filesystem_move",
        arguments: JSON.stringify({ items: [{ source: "a.md", destination: "x/a.md" }, { source: "b.md", destination: "x/b.md" }] }),
      },
    },
    state: "completed",
    timestamp: Date.now(),
    result: {
      success: true,
      data: {
        results: [
          { source: "a.md", destination: "x/a.md", success: true },
          { source: "b.md", destination: "x/b.md", success: true },
        ],
      },
    },
  } as ToolCall;

  return {
    ...defaults,
    ...overrides,
    request: {
      ...defaults.request,
      ...(overrides.request ?? {}),
      function: {
        ...defaults.request.function,
        ...(overrides.request?.function ?? {}),
      },
    },
  };
};

describe("ToolCallTreeRenderer verbose details", () => {
  test("renders all move items in a single compact preview line", () => {
    const parent = new StubMessageRenderer();
    const renderer = new ToolCallTreeRenderer(parent as any);
    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");

    const call = createToolCall();
    const line = renderer.renderToolCallAsContent(messageEl, call, 0, null, "part-move", false);

    // Expect a verbose detail container attached to the line
    const details = line.querySelector<HTMLElement>(".systemsculpt-inline-ops, .systemsculpt-toolcall-details");
    expect(details).toBeTruthy();

    // New compact layout renders all moves on a single <li>
    const items = Array.from(details!.querySelectorAll("li"));
    expect(items).toHaveLength(1);
    const itemText = items[0]?.textContent || "";
    expect(itemText).toContain("a.md");
    expect(itemText).toContain("x/a.md");
    expect(itemText).toContain("b.md");
    expect(itemText).toContain("x/b.md");
  });

  test("does not render read file contents (minimal tree-only)", () => {
    const parent = new StubMessageRenderer();
    const renderer = new ToolCallTreeRenderer(parent as any);
    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");

    const readCall: ToolCall = {
      id: "call-read",
      messageId: "message-read",
      request: {
        id: "call-read",
        type: "function",
        function: { name: "mcp-filesystem_read", arguments: JSON.stringify({ paths: ["notes/todo.md"] }) },
      },
      state: "completed",
      timestamp: Date.now(),
      result: {
        success: true,
        data: {
          files: [
            { path: "notes/todo.md", content: "- one\n- two\n", metadata: { fileSize: 10, windowStart: 0, windowEnd: 10, hasMore: false } },
          ],
        },
      },
    } as any;

    const line = renderer.renderToolCallAsContent(messageEl, readCall, 0, null, "part-read", false);
    // Expect no content details for read
    const details = line.querySelector<HTMLElement>(".systemsculpt-toolcall-details, .systemsculpt-inline-ops");
    expect(details).toBeNull();
  });
});
