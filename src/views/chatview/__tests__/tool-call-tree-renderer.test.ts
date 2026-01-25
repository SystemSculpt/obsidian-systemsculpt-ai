/**
 * @jest-environment jsdom
 */

import { ToolCallTreeRenderer } from "../renderers/ToolCallTreeRenderer";
import type { ToolCall } from "../../../types/toolCalls";

class StubMessageRenderer {
  public app: any = {
    vault: {
      getAbstractFileByPath: jest.fn(() => ({
        path: "notes/todo.md",
      })),
    },
  };

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
    id: "call-1",
    messageId: "message-1",
    request: {
      id: "call-1",
      type: "function",
      function: {
        name: "mcp-filesystem_search",
        arguments: JSON.stringify({ patterns: ["private func configureAudioDevice"] }),
      },
    },
    state: "pending",
    timestamp: Date.now(),
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

const setupRenderer = () => {
  const parent = new StubMessageRenderer();
  const renderer = new ToolCallTreeRenderer(parent as any);
  const messageEl = document.createElement("div");
  messageEl.classList.add("systemsculpt-message");
  return { renderer, messageEl };
};

const getHeader = (messageEl: HTMLElement) =>
  messageEl.querySelector<HTMLElement>(".systemsculpt-chat-structured-title");

const getHeaderContainer = (messageEl: HTMLElement) =>
  messageEl.querySelector<HTMLElement>(".systemsculpt-chat-structured-header");

const getBullet = (messageEl: HTMLElement) =>
  messageEl.querySelector<HTMLElement>(".systemsculpt-chat-structured-bullet");

const getLineTexts = (messageEl: HTMLElement) =>
  Array.from(messageEl.querySelectorAll<HTMLElement>(".systemsculpt-chat-structured-line-text"))
    .filter((el) => (el.closest('.systemsculpt-chat-structured-line') as HTMLElement | null)?.style.display !== 'none')
    .map((el) => el.textContent?.trim());

const getLinePrefixes = (messageEl: HTMLElement) =>
  Array.from(messageEl.querySelectorAll<HTMLElement>(".systemsculpt-chat-structured-line-prefix"))
    .filter((el) => (el.closest('.systemsculpt-chat-structured-line') as HTMLElement | null)?.style.display !== 'none')
    .map((el) => el.textContent?.trim());

const getLineActionButtons = (line: HTMLElement) =>
  Array.from(line.querySelectorAll<HTMLButtonElement>(".systemsculpt-chat-structured-line-actions button"));

describe("ToolCallTreeRenderer – tree layout", () => {
  test("renders search tool calls with exploring header and updates on completion", () => {
    const { renderer, messageEl } = setupRenderer();

    const pendingCall = createToolCall({ state: "pending" });
    const line = renderer.renderToolCallAsContent(messageEl, pendingCall, 0, null, "part-1", false);

    expect(line).toBeInstanceOf(HTMLElement);
    expect(line?.classList.contains("systemsculpt-chat-structured-line")).toBe(true);
    expect(line?.dataset.treeConnector).toBe("end");

    const block = messageEl.querySelector<HTMLElement>(".systemsculpt-chat-structured-block");
    expect(block?.classList.contains("systemsculpt-chat-tree")).toBe(true);

    expect(getHeader(messageEl)?.textContent).toBe("Exploring");
    expect(getHeaderContainer(messageEl)?.dataset.treeConnector).toBe("header");
    expect(getBullet(messageEl)?.classList.contains("is-active")).toBe(true);
    expect(getLineTexts(messageEl)).toEqual([
      "Searched private func configureAudioDevice",
    ]);
    expect(getLinePrefixes(messageEl)).toEqual(["└──"]);

    const completedCall = createToolCall({
      state: "completed",
      result: {
        success: true,
        data: {
          results: [
            { file: "AudioSettingsView.swift", path: "src/AudioSettingsView.swift" },
          ],
        },
      },
    });

    renderer.updateInlineDisplay(line, completedCall);

    expect(getHeader(messageEl)?.textContent).toBe("Explored");
    expect(getBullet(messageEl)?.classList.contains("is-active")).toBe(false);
    expect(getLineTexts(messageEl)).toEqual([
      "Searched private func configureAudioDevice",
    ]);
  });

  test("renders scoped search location when path is provided", () => {
    const { renderer, messageEl } = setupRenderer();

    const scopedCall = createToolCall({
      state: "completed",
      request: {
        id: "call-scoped",
        type: "function",
        function: {
          name: "mcp-filesystem_search",
          arguments: JSON.stringify({ patterns: ["omni"], path: "SystemSculpt/Docs/Guides" }),
        },
      },
    });

    renderer.renderToolCallAsContent(messageEl, scopedCall, 0, null, "part-scoped", false);

    expect(getLineTexts(messageEl)).toEqual([
      "Searched omni in Guides",
    ]);
  });

  test("does not render details actions for completed tool calls", () => {
    const { renderer, messageEl } = setupRenderer();

    const completedCall = createToolCall({
      state: "completed",
      result: {
        success: true,
        data: { message: "noop" },
      },
    });

    const line = renderer.renderToolCallAsContent(messageEl, completedCall, 0, null, "part-details", false);

    const actionLabels = getLineActionButtons(line).map((btn) => btn.textContent?.trim());
    expect(actionLabels.some((label) => label?.includes("Detail"))).toBe(false);
  });

test("aggregates browse folder calls into a single visible line", () => {
  const { renderer, messageEl } = setupRenderer();

  const firstBrowse = createToolCall({
    id: "call-browse-1",
    state: "completed",
    request: {
      id: "call-browse-1",
      type: "function",
      function: {
        name: "mcp-filesystem_list_items",
        arguments: JSON.stringify({ path: "src" }),
      },
    },
  });

  const secondBrowse = createToolCall({
    id: "call-browse-2",
    state: "completed",
    request: {
      id: "call-browse-2",
      type: "function",
      function: {
        name: "mcp-filesystem_list_items",
        arguments: JSON.stringify({ path: "docs/guides" }),
      },
    },
  });

  const firstLine = renderer.renderToolCallAsContent(messageEl, firstBrowse, 0, null, "part-browse-1", false);
  const browseAnchor = renderer.getAnchorElement(firstLine);
  renderer.renderToolCallAsContent(messageEl, secondBrowse, 1, browseAnchor, "part-browse-2", false);

  expect(getLinePrefixes(messageEl)).toEqual(["└──"]);
  expect(getLineTexts(messageEl)).toEqual(["Browsed src, guides"]);

  const lines = Array.from(messageEl.querySelectorAll<HTMLElement>(".systemsculpt-chat-structured-line"));
  expect(lines).toHaveLength(2);
  const hidden = lines.filter((line) => line.dataset.treeHidden === "true");
  expect(hidden).toHaveLength(1);
  expect(hidden[0].style.display).toBe("none");
});

test("aggregated browse details persist around other tool types", () => {
  const { renderer, messageEl } = setupRenderer();

  const browse = createToolCall({
      id: "call-browse",
      state: "completed",
      request: {
        id: "call-browse",
        type: "function",
        function: {
          name: "mcp-filesystem_list_items",
          arguments: JSON.stringify({ path: "src/components" }),
        },
      },
    });

    const search = createToolCall({
      id: "call-search",
      state: "completed",
      request: {
        id: "call-search",
        type: "function",
        function: {
          name: "mcp-filesystem_search",
          arguments: JSON.stringify({ patterns: ["configureAudioDevice"] }),
        },
      },
    });

    const browseAgain = createToolCall({
      id: "call-browse-again",
      state: "completed",
      request: {
        id: "call-browse-again",
        type: "function",
        function: {
          name: "mcp-filesystem_list_items",
          arguments: JSON.stringify({ path: "src/utils" }),
        },
      },
    });

  const firstLine = renderer.renderToolCallAsContent(messageEl, browse, 0, null, "part-aggregate-1", false);
  const groupAnchor = renderer.getAnchorElement(firstLine);
  renderer.renderToolCallAsContent(messageEl, search, 1, groupAnchor, "part-aggregate-2", false);
  renderer.renderToolCallAsContent(messageEl, browseAgain, 2, groupAnchor, "part-aggregate-3", false);

  expect(getLinePrefixes(messageEl)).toEqual(["├──", "└──"]);
  expect(getLineTexts(messageEl)).toEqual([
    "Browsed components, utils",
    "Searched configureAudioDevice",
  ]);

  const lines = Array.from(messageEl.querySelectorAll<HTMLElement>(".systemsculpt-chat-structured-line"));
  expect(lines).toHaveLength(3);
  const hidden = lines.filter((line) => line.dataset.treeHidden === "true");
  expect(hidden).toHaveLength(1);
  expect(hidden[0].dataset.toolCallId).toBe("call-browse-again");
});

test("search tool details render comma separated terms", () => {
  const { renderer, messageEl } = setupRenderer();

  const search = createToolCall({
    id: "call-search-terms",
    state: "completed",
    request: {
      id: "call-search-terms",
      type: "function",
      function: {
        name: "mcp-filesystem_search",
        arguments: JSON.stringify({ query: "publish_date:: youtube video script duration: thumbnail: channels" }),
      },
    },
  });

  renderer.renderToolCallAsContent(messageEl, search, 0, null, "part-search-terms", false);

  expect(getLineTexts(messageEl)).toEqual([
    "Searched publish_date, youtube video script duration, thumbnail, channels",
  ]);
});

  test("renders file operation tool calls with past-tense labels", () => {
    const { renderer, messageEl } = setupRenderer();

    const move = createToolCall({
      id: "call-move",
      state: "completed",
      request: {
        id: "call-move",
        type: "function",
        function: {
          name: "mcp-filesystem_move",
          arguments: JSON.stringify({
            items: [{ path: "src/alpha.md" }],
            destination: "archive/2025",
          }),
        },
      },
    });

    const trash = createToolCall({
      id: "call-trash",
      state: "completed",
      request: {
        id: "call-trash",
        type: "function",
        function: {
          name: "mcp-filesystem_trash",
          arguments: JSON.stringify({ paths: ["notes/todo.md"] }),
        },
      },
    });

    const rename = createToolCall({
      id: "call-rename",
      state: "completed",
      request: {
        id: "call-rename",
        type: "function",
        function: {
          name: "mcp-filesystem_rename",
          arguments: JSON.stringify({ from: "docs/notes/todo.md", to: "docs/notes/tasks.md" }),
        },
      },
    });

    renderer.renderToolCallAsContent(messageEl, move, 0, null, "part-move", false);
    renderer.renderToolCallAsContent(messageEl, trash, 1, null, "part-trash", false);
    renderer.renderToolCallAsContent(messageEl, rename, 2, null, "part-rename", false);

    expect(getLineTexts(messageEl)).toEqual([
      "Moved 1 item to 2025",
      "Deleted todo.md",
      "Renamed todo.md → tasks.md",
    ]);
  });

  test("mutating tools use change-centric headers and failure messaging", () => {
    const { renderer, messageEl } = setupRenderer();

    const executingEdit = createToolCall({
      state: "executing",
      request: {
        id: "call-3",
        type: "function",
        function: {
          name: "mcp-filesystem_edit",
          arguments: JSON.stringify({ path: "todo_list.md", edits: [{ oldText: "a", newText: "b" }] }),
        },
      },
    });

    const line = renderer.renderToolCallAsContent(messageEl, executingEdit, 0, null, "part-3", false);

    expect(getHeader(messageEl)?.textContent).toBe("Changing");
    expect(getLineTexts(messageEl)).toEqual(["Edited todo_list.md"]);

    const failedEdit = {
      ...executingEdit,
      state: "failed" as const,
    };
    renderer.updateInlineDisplay(line, failedEdit);

    expect(getHeader(messageEl)?.textContent).toBe("Change Failed");
    expect(line.dataset.state).toBe("failed");
  });

  // Note: Approval deck tests removed - all tools are now auto-approved
});
