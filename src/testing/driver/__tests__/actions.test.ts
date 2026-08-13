/**
 * @jest-environment jsdom
 */

import type { App } from "obsidian";

import type { ChatMessage, MessagePart } from "../../../types";
import type { SupportDiagnosticEvent } from "../../../utils/PluginLogger";
import { canonicalAgentToolInput } from "../../../views/chatview/agent/MutationJournal";
import {
  DEVELOPMENT_TEST_ROOT,
  runDriverAction,
  type ActionContext,
} from "../actions";

function rect(visible = true): DOMRect {
  return {
    x: 0, y: 0, width: visible ? 100 : 0, height: visible ? 30 : 0,
    top: 0, right: visible ? 100 : 0, bottom: visible ? 30 : 0, left: 0,
    toJSON: () => ({}),
  };
}

function makeContext(
  read = jest.fn<Promise<string>, [string]>(),
  getAbstractFileByPath = jest.fn<unknown, [string]>(() => null),
) {
  const ctx: ActionContext = {
    app: {
      vault: {
        adapter: { read },
        getAbstractFileByPath,
      },
      workspace: { getLeavesOfType: () => [] },
    } as unknown as App,
    pluginId: "systemsculpt-ai",
    pluginVersion: "0.0.0-test",
    buildStamp: "test-build",
    diagnostics: {} as ActionContext["diagnostics"],
  };
  return { ctx, read, getAbstractFileByPath };
}

function makeDevelopmentHarness(options: { chatId?: string; draft?: string } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const input = document.createElement("textarea");
  input.className = "systemsculpt-agent-prompt-input";
  input.dataset.testid = "chat.composer.input";
  input.value = options.draft ?? "";
  input.getBoundingClientRect = () => rect();
  container.append(input);

  const send = document.createElement("button");
  send.dataset.testid = "chat.composer.send";
  send.getBoundingClientRect = () => rect();
  container.append(send);

  let running = false;
  const stop = document.createElement("button");
  stop.className = "systemsculpt-agent-stop";
  stop.dataset.testid = "chat.composer.stop";
  stop.getBoundingClientRect = () => rect(running);
  stop.onclick = () => { running = false; };
  container.append(stop);

  const approval = document.createElement("select");
  approval.dataset.testid = "chat.composer.approval-mode";
  approval.append(new Option("Ask", "ask"), new Option("Full access", "full-access"));
  approval.value = "full-access";
  container.append(approval);

  const picker = document.createElement("input");
  picker.type = "file";
  picker.dataset.testid = "chat.composer.file-picker";
  container.append(picker);

  const chatLoadedListeners = new Set<(chatId: string) => void>();
  const triggerChatLoaded = (chatId: string): void => {
    for (const listener of chatLoadedListeners) listener(chatId);
  };

  const agent = {
    active: {
      approvalDecisions: new Map<string, unknown>(),
      executingToolIds: new Set<string>(),
      toolIdentities: new Map<string, { canonicalInput: string; toolName: string }>(),
      toolTasks: new Map<string, unknown>(),
    },
    pendingApprovalDeliveries: new Map<string, unknown>(),
    pendingDeliveries: new Map<string, unknown>(),
  };
  const view = {
    agent,
    containerEl: container,
    chatId: options.chatId ?? "",
    messages: [] as ChatMessage[],
    getExpectedChatHistoryFilePath: jest.fn(() =>
      view.chatId ? `SystemSculpt/Chats/${view.chatId}.md` : null),
    getChatHistoryFilePath: jest.fn(() =>
      view.chatId ? `SystemSculpt/Chats/${view.chatId}.md` : null),
    loadChatById: jest.fn(async (chatId: string) => {
      view.chatId = chatId;
      input.value = "";
      for (const turn of container.querySelectorAll(".systemsculpt-agent-turn")) turn.remove();
    }),
  };
  const newChat = document.createElement("button");
  newChat.dataset.testid = "chat.header.new";
  newChat.scrollIntoView = jest.fn();
  newChat.onclick = () => {
    view.chatId = "";
    input.value = "";
    running = false;
    for (const turn of container.querySelectorAll(".systemsculpt-agent-turn")) turn.remove();
    for (const attachment of container.querySelectorAll(
      '[data-testid="chat.composer.attachment.remove"]',
    )) attachment.remove();
    triggerChatLoaded("");
  };
  container.append(newChat);

  const leaf = { view };
  const adapterRead = jest.fn(async () => "EXPECTED");
  const adapterExists = jest.fn(async () => false);
  const adapterRename = jest.fn(async () => undefined);
  const adapterRmdir = jest.fn(async () => undefined);
  const getAbstractFileByPath = jest.fn<unknown, [string]>(() => null);
  const trashFile = jest.fn(async () => undefined);
  const workspace = {
    activeLeaf: leaf,
    getLeavesOfType: jest.fn(() => [leaf]),
    revealLeaf: jest.fn(async () => undefined),
    getLeaf: jest.fn(),
    on: jest.fn((name: string, callback: (chatId: string) => void) => {
      if (name === "systemsculpt:chat-loaded") chatLoadedListeners.add(callback);
      return { name, callback };
    }),
    offref: jest.fn((ref: { name: string; callback: (chatId: string) => void }) => {
      if (ref.name === "systemsculpt:chat-loaded") chatLoadedListeners.delete(ref.callback);
    }),
  };
  const ctx: ActionContext = {
    app: {
      vault: {
        adapter: {
          exists: adapterExists,
          read: adapterRead,
          rename: adapterRename,
          rmdir: adapterRmdir,
        },
        getName: () => "main-vault",
        getAbstractFileByPath,
      },
      fileManager: { trashFile },
      workspace,
    } as unknown as App,
    pluginId: "systemsculpt-ai",
    pluginVersion: "0.0.0-test",
    buildStamp: "test-build",
    diagnostics: { recentErrorCount: () => 0 } as ActionContext["diagnostics"],
  };
  return {
    ctx, container, input, send, stop, approval, view, agent, newChat,
    adapterExists, adapterRead, adapterRename, adapterRmdir,
    getAbstractFileByPath, trashFile, triggerChatLoaded,
    setRunning(value: boolean) { running = value; },
  };
}

const supportToolOrdinals = new Map<string, number>();

function supportToolOrdinal(toolCallId: string): number {
  const existing = supportToolOrdinals.get(toolCallId);
  if (existing) return existing;
  const ordinal = supportToolOrdinals.size + 1;
  supportToolOrdinals.set(toolCallId, ordinal);
  return ordinal;
}

function supportDiagnostic(
  code: string,
  toolCallId?: string,
  sequence = 1,
): SupportDiagnosticEvent {
  const toolExecutionOrdinal = toolCallId ? supportToolOrdinal(toolCallId) : null;
  const resultCommand = code === "command_segment_dispatch_started"
    || code.startsWith("tool_result_acknowledged_")
    || code.startsWith("tool_result_sent_");
  return {
    timestamp: `2026-08-09T22:00:00.${String(sequence).padStart(3, "0")}Z`,
    severity: "info",
    code,
    phase: "test",
    sequence,
    ...(toolExecutionOrdinal !== null ? {
      tool_execution_ordinal: toolExecutionOrdinal,
      ...(resultCommand ? {
        command_kind: "client_tool_result" as const,
        command_segment_ordinal: 1_000 + toolExecutionOrdinal,
      } : {}),
    } : {}),
  };
}

function toolResultDeliveryDiagnostics(
  toolCallId: string,
  requestId: string,
  firstSequence: number,
  resultState: "succeeded" | "failed" = "succeeded",
): SupportDiagnosticEvent[] {
  const withRequest = (
    event: SupportDiagnosticEvent,
    extra: Partial<SupportDiagnosticEvent> = {},
  ): SupportDiagnosticEvent => ({ ...event, request_id: requestId, ...extra });
  const commandSegmentOrdinal = firstSequence + 1;
  return [
    withRequest(supportDiagnostic("local_tool_started", toolCallId, firstSequence)),
    withRequest(
      supportDiagnostic(
        "command_segment_dispatch_started",
        toolCallId,
        firstSequence + 1,
      ),
      {
        command_kind: "client_tool_result",
        command_segment_ordinal: commandSegmentOrdinal,
      },
    ),
    withRequest(
      supportDiagnostic(
        `tool_result_acknowledged_${resultState}`,
        toolCallId,
        firstSequence + 2,
      ),
      { command_segment_ordinal: commandSegmentOrdinal },
    ),
    withRequest(
      supportDiagnostic(
        `tool_result_sent_${resultState}`,
        toolCallId,
        firstSequence + 3,
      ),
      { command_segment_ordinal: commandSegmentOrdinal },
    ),
  ];
}

async function renderTerminalGroupedToolTurn(
  harness: ReturnType<typeof makeDevelopmentHarness>,
  options: Readonly<{
    continuation: string;
    firstCallId: string;
    beforeContinuation?: () => void;
    toolCount: number;
    turnId: string;
  }>,
): Promise<void> {
  const assistantTurn = document.createElement("div");
  assistantTurn.className = "systemsculpt-agent-turn is-assistant";
  assistantTurn.dataset.turnId = options.turnId;
  const tool = document.createElement("div");
  tool.className = "systemsculpt-agent-part is-tool is-succeeded";
  tool.dataset.partKey = `tool:${options.firstCallId}`;
  tool.dataset.toolCount = String(options.toolCount);
  tool.innerHTML = [
    '<span class="systemsculpt-agent-tool-icon"></span>',
    `<strong class="systemsculpt-agent-tool-label">Read ${String(options.toolCount)} ${
      options.toolCount === 1 ? "file" : "files"
    }</strong>`,
    '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="check"></span>',
  ].join("");
  assistantTurn.append(tool);
  harness.container.append(assistantTurn);
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  options.beforeContinuation?.();
  const continuation = document.createElement("div");
  continuation.className = "systemsculpt-agent-part is-text";
  continuation.textContent = options.continuation;
  assistantTurn.append(continuation);
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

interface ExactToolSeed {
  callId: string;
  input: unknown;
  name: string;
}

function exactToolElement(callId: string, state: "running" | "succeeded"): HTMLDivElement {
  const tool = document.createElement("div");
  tool.className = `systemsculpt-agent-part is-tool is-${state}`;
  tool.dataset.partKey = `tool:${callId}`;
  tool.innerHTML = [
    '<span class="systemsculpt-agent-tool-icon"></span>',
    '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
    `<span class="systemsculpt-agent-tool-state-icon" data-icon-state="${
      state === "running" ? "minus" : "check"
    }"></span>`,
  ].join("");
  return tool;
}

function settleExactTool(tool: HTMLElement): void {
  tool.className = "systemsculpt-agent-part is-tool is-succeeded";
  const stateIcon = tool.querySelector<HTMLElement>(".systemsculpt-agent-tool-state-icon");
  if (stateIcon) stateIcon.dataset.iconState = "check";
}

async function renderExactSequentialToolTurn(
  harness: ReturnType<typeof makeDevelopmentHarness>,
  diagnostics: SupportDiagnosticEvent[],
  options: Readonly<{
    beforeMarker?: (lifecycles: SupportDiagnosticEvent[][]) => void;
    collapseFinalSurface?: boolean;
    collapseFinalReasoning?: boolean;
    detachSettledBeforeNext?: boolean;
    diagnosticRequestId?: string;
    groupFinalSurface?: boolean;
    marker: string;
    parallelBatch?: boolean;
    preToolText?: string;
    tools: readonly ExactToolSeed[];
    turnId: string;
  }>,
): Promise<{
  lifecycles: SupportDiagnosticEvent[][];
  tools: HTMLDivElement[];
  turn: HTMLDivElement;
}> {
  const turn = document.createElement("div");
  turn.className = "systemsculpt-agent-turn is-assistant is-active";
  turn.dataset.turnId = options.turnId;
  harness.container.append(turn);
  if (options.preToolText) {
    const text = document.createElement("div");
    text.className = "systemsculpt-agent-part is-text";
    text.dataset.partKey = `text:pre:${options.turnId}`;
    text.textContent = options.preToolText;
    turn.append(text);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  const lifecycles = options.tools.map((tool, index) => toolResultDeliveryDiagnostics(
    tool.callId,
    options.diagnosticRequestId ?? options.turnId,
    10 + index * 10,
  ));
  const elements: HTMLDivElement[] = [];
  if (options.parallelBatch) {
    for (let index = 0; index < options.tools.length; index += 1) {
      const seed = options.tools[index]!;
      harness.agent.active.toolIdentities.set(seed.callId, {
        canonicalInput: canonicalAgentToolInput(seed.input),
        toolName: seed.name,
      });
      diagnostics.push(...lifecycles[index]!.slice(0, 2));
      const tool = exactToolElement(seed.callId, "running");
      turn.append(tool);
      elements.push(tool);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    for (let index = 0; index < elements.length; index += 1) {
      settleExactTool(elements[index]!);
      diagnostics.push(lifecycles[index]![2]!, lifecycles[index]![3]!);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  } else {
    for (let index = 0; index < options.tools.length; index += 1) {
      const seed = options.tools[index]!;
      harness.agent.active.toolIdentities.set(seed.callId, {
        canonicalInput: canonicalAgentToolInput(seed.input),
        toolName: seed.name,
      });
      diagnostics.push(...lifecycles[index]!.slice(0, 2));
      const tool = exactToolElement(seed.callId, "running");
      turn.append(tool);
      elements.push(tool);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      settleExactTool(tool);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      diagnostics.push(lifecycles[index]![2]!, lifecycles[index]![3]!);
      if (options.detachSettledBeforeNext && index < options.tools.length - 1) {
        tool.remove();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
  }
  options.beforeMarker?.(lifecycles);
  if (options.groupFinalSurface && elements.length > 1) {
    const first = elements[0]!;
    first.classList.add("is-grouped");
    first.dataset.toolCount = String(elements.length);
    const label = first.querySelector(".systemsculpt-agent-tool-label");
    if (label) label.textContent = `Read ${String(elements.length)} files`;
    for (const tool of elements.slice(1)) tool.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  if (options.collapseFinalSurface && elements.length > 1) {
    const latest = elements[elements.length - 1]!;
    const hiddenNodes: HTMLElement[] = [...elements.slice(0, -1)];
    if (options.collapseFinalReasoning) {
      const reasoning = document.createElement("div");
      reasoning.className = "systemsculpt-agent-part is-reasoning";
      reasoning.dataset.partKey = `reasoning:${options.turnId}`;
      reasoning.textContent = "Private reasoning";
      latest.before(reasoning);
      hiddenNodes.push(reasoning);
    }
    for (const node of hiddenNodes) node.remove();
    const overflow = document.createElement("button");
    overflow.dataset.agentActivityOverflow = "";
    overflow.dataset.hiddenCount = String(hiddenNodes.length);
    overflow.setAttribute("aria-expanded", "false");
    overflow.onclick = () => {
      const expanded = overflow.getAttribute("aria-expanded") === "true";
      overflow.setAttribute("aria-expanded", String(!expanded));
      if (expanded) {
        for (const node of hiddenNodes) node.remove();
      } else {
        for (const node of hiddenNodes) latest.before(node);
      }
    };
    latest.after(overflow);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  turn.classList.remove("is-active");
  const marker = document.createElement("div");
  marker.className = "systemsculpt-agent-part is-text";
  marker.dataset.partKey = `text:${options.turnId}`;
  marker.textContent = options.marker;
  turn.append(marker);
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  return { lifecycles, tools: elements, turn };
}

function exactSequentialPlanParams(
  tools: readonly ExactToolSeed[],
  marker: string,
): Record<string, unknown> {
  return {
    tools: tools.map((tool) => ({ name: tool.name, input: tool.input })),
    text: marker,
    textMode: "equals",
    requireNoOtherText: true,
    timeoutMs: 0,
  };
}

function persistedExactAssistantMessage(
  turnId: string,
  tools: readonly ExactToolSeed[],
  marker: string,
  assistantMessageId = `assistant:${turnId}`,
  content: string | null = marker,
): ChatMessage {
  const toolCalls = tools.map((tool, index) => ({
    id: tool.callId,
    messageId: assistantMessageId,
    request: {
      id: tool.callId,
      type: "function" as const,
      function: {
        name: tool.name,
        arguments: JSON.stringify(tool.input),
      },
    },
    result: { success: true, data: {} },
    state: "completed" as const,
    timestamp: index + 1,
  }));
  const messageParts: MessagePart[] = toolCalls.map((tool, index) => ({
    id: `tool:${tool.id}`,
    type: "tool_call" as const,
    timestamp: index + 1,
    data: tool,
  }));
  if (typeof content === "string" && content.length > 0) {
    messageParts.push({
      id: `text:${assistantMessageId}:0`,
      type: "content",
      timestamp: toolCalls.length + 1,
      data: content,
    });
  }
  return {
    role: "assistant",
    content,
    message_id: assistantMessageId,
    messageParts,
    tool_calls: toolCalls,
  };
}

async function replaceWithPersistedExactTurn(
  harness: ReturnType<typeof makeDevelopmentHarness>,
  liveTurn: HTMLElement,
  tools: readonly ExactToolSeed[],
  marker: string,
  turnId: string,
  groupTools = false,
): Promise<HTMLDivElement> {
  const historicalTurn = document.createElement("div");
  historicalTurn.className = "systemsculpt-agent-turn is-assistant";
  historicalTurn.dataset.turnId = turnId;
  if (groupTools) {
    const first = tools[0];
    if (!first) throw new Error("Expected at least one exact tool.");
    const grouped = exactToolElement(first.callId, "succeeded");
    grouped.classList.add("is-grouped");
    grouped.dataset.toolCount = String(tools.length);
    const label = grouped.querySelector(".systemsculpt-agent-tool-label");
    if (label) label.textContent = `Read ${String(tools.length)} files`;
    historicalTurn.append(grouped);
  } else {
    for (const seed of tools) historicalTurn.append(exactToolElement(seed.callId, "succeeded"));
  }
  const text = document.createElement("div");
  text.className = "systemsculpt-agent-part is-text";
  text.textContent = marker;
  historicalTurn.append(text);
  harness.container.prepend(historicalTurn);
  liveTurn.remove();
  harness.view.messages = [
    {
      role: "user",
      content: "PRIVATE USER REQUEST",
      message_id: turnId,
    },
    persistedExactAssistantMessage(turnId, tools, marker),
  ];
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  return historicalTurn;
}

async function rejectionError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the driver action to reject.");
}

function renderWriteApproval(
  harness: ReturnType<typeof makeDevelopmentHarness>,
  path: string,
  text: string,
): jest.Mock {
  const tool = document.createElement("div");
  tool.className = "systemsculpt-agent-part is-tool";
  tool.innerHTML = [
    '<strong class="systemsculpt-agent-tool-label">Write file</strong>',
    `<span class="systemsculpt-agent-tool-summary">${path}</span>`,
    '<div class="systemsculpt-agent-approval-preview">',
    `<div class="systemsculpt-diff-filename">${path}</div>`,
    `<div class="systemsculpt-diff-line-added"><span class="systemsculpt-diff-line-content">${text}</span></div>`,
    "</div>",
  ].join("");
  const allowOnce = document.createElement("button");
  allowOnce.dataset.testid = "chat.approval.allow-once";
  allowOnce.getBoundingClientRect = () => rect();
  const approved = jest.fn(() => { tool.remove(); });
  allowOnce.onclick = approved;
  tool.append(allowOnce);
  harness.container.append(tool);
  return approved;
}

function renderMutationApproval(
  harness: ReturnType<typeof makeDevelopmentHarness>,
  callId: string,
  toolName: string,
  input: unknown,
): jest.Mock {
  const turn = document.createElement("div");
  turn.className = "systemsculpt-agent-turn is-assistant is-active";
  turn.getBoundingClientRect = () => rect();
  const tool = document.createElement("div");
  tool.className = "systemsculpt-agent-part is-tool is-approval-required";
  tool.dataset.partKey = `tool:${callId}`;
  tool.getBoundingClientRect = () => rect();
  const allowOnce = document.createElement("button");
  allowOnce.dataset.testid = "chat.approval.allow-once";
  allowOnce.getBoundingClientRect = () => rect();
  const approved = jest.fn(() => {
    harness.agent.active.approvalDecisions.set(callId, {
      approved: true,
      source: "manual",
    });
    turn.remove();
  });
  allowOnce.onclick = approved;
  tool.append(allowOnce);
  turn.append(tool);
  harness.container.append(turn);
  harness.agent.active.toolIdentities.set(callId, {
    canonicalInput: canonicalAgentToolInput(input),
    toolName,
  });
  return approved;
}

function installHistoryEntry(
  harness: ReturnType<typeof makeDevelopmentHarness>,
  entryId: string,
): {
  close: HTMLButtonElement;
  history: HTMLButtonElement;
  row: HTMLDivElement;
  search: HTMLInputElement;
} {
  const history = document.createElement("button");
  history.dataset.testid = "chat.header.history";
  history.scrollIntoView = jest.fn();
  history.getBoundingClientRect = () => rect();
  const search = document.createElement("input");
  search.dataset.testid = "history.search";
  search.getBoundingClientRect = () => rect();
  const close = document.createElement("button");
  close.dataset.testid = "history.close";
  close.getBoundingClientRect = () => rect();
  const row = document.createElement("div");
  row.className = "systemsculpt-history-item";
  row.dataset.kind = "chat";
  row.dataset.entryId = entryId;
  row.getBoundingClientRect = () => rect();
  row.scrollIntoView = jest.fn();
  history.onclick = () => document.body.append(search, close, row);
  close.onclick = () => { search.remove(); close.remove(); row.remove(); };
  harness.container.append(history);
  return { close, history, row, search };
}

describe("test driver actions", () => {
  beforeEach(() => {
    document.body.empty();
    supportToolOrdinals.clear();
  });

  it("requires one exact trimmed text match", async () => {
    const { ctx } = makeContext();
    const first = document.createElement("div");
    first.className = "exact-response";
    first.textContent = "  EXPECTED  ";
    document.body.append(first);

    await expect(runDriverAction(ctx, "waitFor", {
      target: "css:.exact-response",
      state: "textEquals",
      text: "EXPECTED",
      timeoutMs: 0,
    })).resolves.toMatchObject({ satisfied: true });

    const extra = document.createElement("div");
    extra.className = "exact-response";
    extra.textContent = "EXTRA";
    document.body.append(extra);
    await expect(runDriverAction(ctx, "waitFor", {
      target: "css:.exact-response",
      state: "textEquals",
      text: "EXPECTED",
      timeoutMs: 0,
    })).rejects.toThrow(/did not reach "textEquals"/);
  });

  it("proves exact vault content without returning the content", async () => {
    const read = jest.fn(async () => "EXPECTED");
    const { ctx } = makeContext(read);

    await expect(runDriverAction(ctx, "vault.assertText", {
      path: "QA/E2E/result.md",
      text: "EXPECTED",
    })).resolves.toEqual({
      path: "QA/E2E/result.md",
      exact: true,
      characters: 8,
    });
    expect(read).toHaveBeenCalledWith("QA/E2E/result.md");

    await expect(runDriverAction(ctx, "vault.assertText", {
      path: "../outside.md",
      text: "EXPECTED",
    })).rejects.toThrow(/unsafe/);
  });

  it("proves an exact vault folder without returning its contents", async () => {
    const folderPath = "QA/E2E/created";
    const getAbstractFileByPath = jest.fn<unknown, [string]>(() => ({
      path: folderPath,
      children: [],
    }));
    const { ctx } = makeContext(jest.fn(async () => ""), getAbstractFileByPath);

    await expect(runDriverAction(ctx, "vault.assertFolder", {
      path: folderPath,
    })).resolves.toEqual({
      path: folderPath,
      folder: true,
      childCount: 0,
    });
    expect(getAbstractFileByPath).toHaveBeenCalledWith(folderPath);

    getAbstractFileByPath.mockReturnValue({ path: folderPath });
    await expect(runDriverAction(ctx, "vault.assertFolder", {
      path: folderPath,
    })).rejects.toThrow(/not an exact folder/);

    getAbstractFileByPath.mockReturnValue({ path: `${folderPath}-other`, children: [] });
    await expect(runDriverAction(ctx, "vault.assertFolder", {
      path: folderPath,
    })).rejects.toThrow(/not an exact folder/);
  });
});

describe("guarded development driver actions", () => {
  beforeEach(() => {
    document.body.empty();
    supportToolOrdinals.clear();
  });

  it("adds guarded actions without removing the generic action surface", async () => {
    const harness = makeDevelopmentHarness();
    await expect(runDriverAction(harness.ctx, "type", {
      target: "chat.composer.input",
      text: "generic draft",
    })).resolves.toMatchObject({ value: "generic draft" });
    expect(harness.input.value).toBe("generic draft");

    await expect(runDriverAction(harness.ctx, "waitForRun", { startMs: 0 }))
      .rejects.toThrow(/No run started within 0ms/);
  });

  it("times visible feedback from the current turn rather than historical replies", async () => {
    const harness = makeDevelopmentHarness();
    const historicalAssistant = document.createElement("div");
    historicalAssistant.className = "systemsculpt-agent-turn is-assistant";
    historicalAssistant.textContent = "old visible answer";
    harness.container.append(historicalAssistant);
    const currentUser = document.createElement("div");
    currentUser.className = "systemsculpt-agent-turn is-user";
    currentUser.textContent = "new request";
    harness.container.append(currentUser);
    const currentAssistant = document.createElement("div");
    currentAssistant.className = "systemsculpt-agent-turn is-assistant is-active";
    harness.container.append(currentAssistant);
    harness.setRunning(true);

    window.setTimeout(() => {
      const text = document.createElement("div");
      text.className = "systemsculpt-agent-part is-text";
      text.textContent = "new visible answer";
      currentAssistant.append(text);
      harness.setRunning(false);
    }, 150);

    const outcome = await runDriverAction(harness.ctx, "waitForRun", {
      startMs: 500,
      timeoutMs: 1000,
      stallMs: 500,
    });
    expect(outcome).toMatchObject({
      finished: true,
      timing: {
        firstVisibleFeedbackMs: expect.any(Number),
        firstVisibleContentMs: expect.any(Number),
      },
    });
    const timing = (outcome as { timing: {
      firstVisibleFeedbackMs: number;
      firstVisibleContentMs: number;
    } }).timing;
    expect(timing.firstVisibleFeedbackMs).toBeGreaterThanOrEqual(150);
    expect(timing.firstVisibleContentMs).toBeGreaterThanOrEqual(150);
    const result = await runDriverAction(harness.ctx, "snapshot", { scope: "chat" });
    expect(result).toMatchObject({ turnCount: 3 });
  });

  it("keeps detecting progress after bounded snapshot text reaches 4,000 characters", async () => {
    const harness = makeDevelopmentHarness();
    const user = document.createElement("div");
    user.className = "systemsculpt-agent-turn is-user";
    user.textContent = "stream a long response";
    harness.container.append(user);
    const assistant = document.createElement("div");
    assistant.className = "systemsculpt-agent-turn is-assistant is-active";
    const answer = document.createElement("div");
    answer.className = "systemsculpt-agent-part is-text";
    answer.textContent = "A".repeat(4001);
    assistant.append(answer);
    harness.container.append(assistant);
    harness.setRunning(true);

    window.setTimeout(() => { answer.textContent += "B".repeat(50); }, 70);
    window.setTimeout(() => { answer.textContent += "C".repeat(50); }, 140);
    window.setTimeout(() => { answer.textContent += "D".repeat(50); }, 210);
    window.setTimeout(() => { harness.setRunning(false); }, 280);

    const outcome = await runDriverAction(harness.ctx, "waitForRun", {
      startMs: 0,
      timeoutMs: 1000,
      stallMs: 160,
    }) as { snapshot: { turns: Array<{ text: string; textCharacters: number }> } };
    const latest = outcome.snapshot.turns[outcome.snapshot.turns.length - 1];
    expect(latest?.text).toHaveLength(4000);
    expect(latest?.textCharacters).toBeGreaterThan(4000);
  });

  it("keeps detecting repeated identical tools through a collapsed activity surface", async () => {
    const harness = makeDevelopmentHarness();
    const user = document.createElement("div");
    user.className = "systemsculpt-agent-turn is-user";
    user.textContent = "run repeated reads";
    harness.container.append(user);
    const assistant = document.createElement("div");
    assistant.className = "systemsculpt-agent-turn is-assistant is-active";
    const overflow = document.createElement("button");
    overflow.dataset.agentActivityOverflow = "";
    overflow.setAttribute("aria-expanded", "false");
    overflow.textContent = "+10 previous tool calls";
    let latest = exactToolElement("repeated-read-10", "succeeded");
    assistant.append(latest, overflow);
    harness.container.append(assistant);
    harness.setRunning(true);

    for (let index = 11; index <= 13; index += 1) {
      window.setTimeout(() => {
        const next = exactToolElement(`repeated-read-${String(index)}`, "succeeded");
        latest.replaceWith(next);
        latest = next;
        overflow.textContent = `+${String(index)} previous tool calls`;
      }, (index - 10) * 70);
    }
    window.setTimeout(() => {
      assistant.classList.remove("is-active");
      harness.setRunning(false);
    }, 280);

    await expect(runDriverAction(harness.ctx, "waitForRun", {
      startMs: 0,
      timeoutMs: 1000,
      stallMs: 160,
    })).resolves.toMatchObject({ finished: true });
  });

  it("accepts a submitted turn that completes before the stop button is observed", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "type", {
      text: "fast exact-output request",
      submit: true,
    });
    const user = document.createElement("div");
    user.className = "systemsculpt-agent-turn is-user";
    user.textContent = "fast exact-output request";
    harness.container.append(user);
    const assistant = document.createElement("div");
    assistant.className = "systemsculpt-agent-turn is-assistant";
    const answer = document.createElement("div");
    answer.className = "systemsculpt-agent-part is-text";
    answer.textContent = "FAST-COMPLETE";
    assistant.append(answer);
    harness.container.append(assistant);

    await expect(runDriverAction(harness.ctx, "waitForRun", { startMs: 0 }))
      .resolves.toMatchObject({
        finished: true,
        timing: {
          runStartObserved: false,
          runStartedMs: null,
          firstVisibleFeedbackMs: null,
          firstVisibleContentMs: null,
          feedbackPresentAtFirstObservation: true,
          contentPresentAtFirstObservation: true,
          submitToCompletionUpperBoundMs: expect.any(Number),
        },
      });
  });

  it("does not accept an arbitrary historical completed turn as a new run", async () => {
    const harness = makeDevelopmentHarness();
    const user = document.createElement("div");
    user.className = "systemsculpt-agent-turn is-user";
    user.textContent = "old request";
    harness.container.append(user);
    const assistant = document.createElement("div");
    assistant.className = "systemsculpt-agent-turn is-assistant";
    assistant.textContent = "old answer";
    harness.container.append(assistant);

    await expect(runDriverAction(harness.ctx, "waitForRun", { startMs: 0 }))
      .rejects.toThrow(/No run started within 0ms/);
  });

  it("cooperatively cancels a wait before it can approve a late tool", async () => {
    const harness = makeDevelopmentHarness();
    const controller = new AbortController();
    harness.ctx.signal = controller.signal;
    harness.setRunning(true);
    const approved = jest.fn();

    window.setTimeout(() => controller.abort(), 10);
    window.setTimeout(() => {
      const approval = document.createElement("button");
      approval.dataset.testid = "chat.approval.allow-once";
      approval.getBoundingClientRect = () => rect();
      approval.onclick = approved;
      harness.container.append(approval);
    }, 20);

    await expect(runDriverAction(harness.ctx, "waitForRun", {
      startMs: 100,
      timeoutMs: 1000,
      stallMs: 500,
    })).rejects.toThrow(/Driver action cancelled/);
    expect(approved).not.toHaveBeenCalled();
  });

  it("recognizes a guarded marker-owned turn that completes before its first poll", async () => {
    const marker = "SS-DEV-TEST-FAST";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    harness.send.onclick = () => {
      harness.input.value = "";
      const user = document.createElement("div");
      user.className = "systemsculpt-agent-turn is-user";
      user.textContent = `${marker} fast guarded request`;
      harness.container.append(user);
      const assistant = document.createElement("div");
      assistant.className = "systemsculpt-agent-turn is-assistant";
      const answer = document.createElement("div");
      answer.className = "systemsculpt-agent-part is-text";
      answer.textContent = "FAST-GUARDED-COMPLETE";
      assistant.append(answer);
      harness.container.append(assistant);
    };
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "fast guarded request",
      submit: true,
    });

    await expect(runDriverAction(harness.ctx, "chat.waitForDevelopmentRun", {
      until: "complete",
      timeoutMs: 0,
    })).resolves.toMatchObject({
      reached: "complete",
      completedBeforeRunningWasObserved: true,
    });
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
    await expect(runDriverAction(harness.ctx, "waitForRun", { startMs: 0 }))
      .rejects.toThrow(/No run started within 0ms/);
  });

  it("bridges the submitted composer marker to a next-task optimistic turn and durable id", async () => {
    const marker = "SS-DEV-TEST-HANDOFF";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    harness.send.onclick = () => {
      harness.input.value = "";
      window.setTimeout(() => {
        harness.view.chatId = "development-chat";
        const user = document.createElement("div");
        user.className = "systemsculpt-agent-turn is-user";
        user.textContent = `${marker} delayed optimistic request`;
        harness.container.append(user);
        const assistant = document.createElement("div");
        assistant.className = "systemsculpt-agent-turn is-assistant";
        assistant.textContent = "DELAYED-GUARDED-COMPLETE";
        harness.container.append(assistant);
      }, 0);
    };

    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "delayed optimistic request",
      submit: true,
    });
    expect(harness.input.value).toBe("");
    expect(harness.view.chatId).toBe("");

    await expect(runDriverAction(harness.ctx, "chat.waitForDevelopmentRun", {
      until: "complete",
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      reached: "complete",
      completedBeforeRunningWasObserved: true,
    });
    expect(harness.view.chatId).toBe("development-chat");
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("reopens only the exact marker-owned saved chat through visible history", async () => {
    const marker = "SS-DEV-TEST-REOPEN";
    const ownedChatId = "owned-development-chat";
    const harness = makeDevelopmentHarness();
    const renderOwnedTranscript = (): void => {
      for (const turn of harness.container.querySelectorAll(".systemsculpt-agent-turn")) turn.remove();
      const user = document.createElement("div");
      user.className = "systemsculpt-agent-turn is-user";
      user.textContent = `${marker} persisted request`;
      harness.container.append(user);
    };
    const historyEntry = installHistoryEntry(harness, `chat:${ownedChatId}`);
    const openFromVisibleHistory = jest.fn(() => {
      void harness.view.loadChatById(ownedChatId);
      historyEntry.close.click();
    });
    historyEntry.row.onclick = openFromVisibleHistory;
    harness.view.loadChatById.mockImplementation(async (chatId: string) => {
      harness.view.chatId = chatId;
      harness.input.value = "";
      renderOwnedTranscript();
      harness.triggerChatLoaded(chatId);
    });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    harness.send.onclick = () => {
      harness.view.chatId = ownedChatId;
      harness.input.value = "";
      renderOwnedTranscript();
    };
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "persist and reopen",
      submit: true,
    });

    const result = await runDriverAction(
      harness.ctx,
      "chat.reopenOwnedDevelopmentHistory",
      { timeoutMs: 0 },
    );
    expect(result).toEqual({
      reopened: true,
      visibleHistoryMatched: true,
      exactIdentityPreserved: true,
      markerRestored: true,
    });
    expect(JSON.stringify(result)).not.toContain(ownedChatId);
    expect(openFromVisibleHistory).toHaveBeenCalledTimes(1);
    expect(harness.view.loadChatById).toHaveBeenCalledWith(ownedChatId);
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("fails closed when the active view changes during the submitted marker handoff", async () => {
    const marker = "SS-DEV-TEST-VIEW";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    harness.send.onclick = () => { harness.input.value = ""; };
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "view ownership check",
      submit: true,
    });

    const workspace = harness.ctx.app.workspace as unknown as {
      activeLeaf: { view: unknown };
      getLeavesOfType: jest.Mock;
    };
    const originalLeaf = workspace.activeLeaf;
    const unrelatedContainer = document.createElement("div");
    const unrelatedInput = document.createElement("textarea");
    unrelatedInput.dataset.testid = "chat.composer.input";
    unrelatedContainer.append(unrelatedInput);
    document.body.append(unrelatedContainer);
    const unrelatedLeaf = {
      view: {
        chatId: "unrelated-chat",
        containerEl: unrelatedContainer,
        getChatHistoryFilePath: () => null,
        getExpectedChatHistoryFilePath: () => null,
        loadChatById: async () => undefined,
      },
    };
    workspace.getLeavesOfType.mockReturnValue([originalLeaf, unrelatedLeaf]);
    workspace.activeLeaf = unrelatedLeaf;

    await expect(runDriverAction(harness.ctx, "chat.waitForDevelopmentRun", {
      until: "complete",
      timeoutMs: 1000,
    })).rejects.toThrow(/active chat does not contain the owned development-test marker/);

    workspace.activeLeaf = originalLeaf;
    workspace.getLeavesOfType.mockReturnValue([originalLeaf]);
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("fails closed when the owned marker never reaches the submitted turn", async () => {
    const marker = "SS-DEV-TEST-MISSING";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    harness.send.onclick = () => {
      harness.input.value = "";
      const unrelated = document.createElement("div");
      unrelated.className = "systemsculpt-agent-turn is-user";
      unrelated.textContent = "SS-DEV-TEST-OTHER unrelated request";
      harness.container.append(unrelated);
    };
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "marker ownership check",
      submit: true,
    });

    await expect(runDriverAction(harness.ctx, "chat.waitForDevelopmentRun", {
      until: "complete",
      timeoutMs: 25,
    })).rejects.toThrow(/active chat does not contain the owned development-test marker/);

    for (const turn of harness.container.querySelectorAll(".systemsculpt-agent-turn")) turn.remove();
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("fails closed when an already claimed submitted chat id changes during handoff", async () => {
    const marker = "SS-DEV-TEST-IDENTITY";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    harness.send.onclick = () => {
      harness.input.value = "";
      harness.view.chatId = "owned-development-chat";
    };
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "identity ownership check",
      submit: true,
    });
    harness.view.chatId = "different-chat";

    await expect(runDriverAction(harness.ctx, "chat.waitForDevelopmentRun", {
      until: "complete",
      timeoutMs: 1000,
    })).rejects.toThrow(/owned development chat identity changed/);

    harness.view.chatId = "owned-development-chat";
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("installs the ownership marker after the asynchronous new-chat reset settles", async () => {
    const marker = "SS-DEV-TEST-RERENDER";
    const harness = makeDevelopmentHarness();
    harness.newChat.onclick = () => {
      harness.view.chatId = "";
      harness.input.value = "";
      setTimeout(() => {
        // AgentChatView.startNewChat resets the composer after awaiting its
        // session replacement, even when the old composer was already blank.
        harness.input.value = "";
        harness.approval.value = "ask";
        harness.triggerChatLoaded("");
      }, 0);
    };

    await expect(runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker }))
      .resolves.toMatchObject({ markerInstalled: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(harness.input.value).toBe(marker);
    await expect(runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "survives the transition",
    })).resolves.toMatchObject({ submitted: false });

    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("refuses to replace a turnful unsaved chat", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness();
    const turn = document.createElement("div");
    turn.className = "systemsculpt-agent-turn";
    turn.textContent = "private unsaved conversation";
    harness.container.append(turn);

    await expect(runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker }))
      .rejects.toThrow(/unsaved chat that already contains messages/);
    expect(harness.newChat.scrollIntoView).not.toHaveBeenCalled();

    turn.remove();
    await expect(runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker }))
      .resolves.toMatchObject({ owned: true });
    expect(harness.approval.value).toBe("ask");
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
    expect(harness.approval.value).toBe("full-access");
  });

  it("refuses to reuse a pre-existing development marker root", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness();
    const root = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    harness.getAbstractFileByPath.mockImplementation((filePath) =>
      filePath === root ? { path: root } : null);

    await expect(runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker }))
      .rejects.toThrow(/Refusing to reuse the existing development-test root/);
    expect(harness.newChat.scrollIntoView).not.toHaveBeenCalled();
  });

  it("fails strict cleanup when no exact development ownership proof remains", async () => {
    const marker = "SS-DEV-TEST-STRICTCLEANUP";
    const harness = makeDevelopmentHarness();

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
    })).resolves.toEqual({ owned: false, skipped: true });
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      requireOwned: true,
    })).rejects.toThrow(/ownership proof is unavailable; cleanup did not run/);
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      requireOwned: "yes",
    })).rejects.toThrow(/requireOwned must be a boolean/);
  });

  it("restores and releases provisional ownership when new-chat setup fails", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    const originalNewChat = harness.newChat.onclick;
    harness.newChat.onclick = () => {
      harness.view.chatId = "";
      harness.input.value = "";
      harness.approval.remove();
    };
    const now = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10000);
    try {
      await expect(runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker }))
        .rejects.toThrow(/New Chat did not establish/);
    } finally {
      now.mockRestore();
    }
    expect(harness.view.loadChatById).toHaveBeenCalledWith("private-chat");

    harness.container.append(harness.approval);
    harness.newChat.onclick = originalNewChat;
    await expect(runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker }))
      .resolves.toMatchObject({ owned: true });
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("trashes only the exact marked chat and folder, then restores the previous chat", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "owned draft",
      submit: true,
    });
    harness.view.chatId = "development-chat";
    const chatFile = { path: "SystemSculpt/Chats/development-chat.md" };
    const folderPath = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const approvedPath = `${folderPath}/round-trip.md`;
    const folder = { path: folderPath, children: [{ path: approvedPath }] };
    harness.getAbstractFileByPath.mockImplementation((filePath) =>
      filePath === chatFile.path ? chatFile : filePath === folderPath ? folder : null);
    harness.adapterRead.mockImplementation(async (path) => path === approvedPath
      ? "EXACT"
      : `<!-- SYSTEMSCULPT-MESSAGE-START role="user" -->\n${marker}\n`);
    const approved = renderWriteApproval(harness, approvedPath, "EXACT");
    await expect(runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: approvedPath,
      text: "EXACT",
    })).resolves.toEqual({ approved: true, path: approvedPath });
    expect(approved).toHaveBeenCalledTimes(1);

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      trashDevelopmentPath: `${DEVELOPMENT_TEST_ROOT}/SS-DEV-TEST-CD`,
      trashSavedChat: true,
    })).rejects.toThrow(/exact owned marker folder/);
    expect(harness.trashFile).not.toHaveBeenCalled();

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      trashDevelopmentPath: folderPath,
      trashSavedChat: true,
    })).resolves.toMatchObject({
      trashedChat: true,
      trashedDevelopmentPath: true,
      restoredPreviousChat: true,
    });
    expect(harness.trashFile).toHaveBeenNthCalledWith(1, chatFile);
    expect(harness.trashFile).toHaveBeenNthCalledWith(2, folder);
    expect(harness.view.loadChatById).toHaveBeenCalledWith("private-chat");
  });

  it("retains refused cleanup ownership until the exact owned chat is restored", async () => {
    const marker = "SS-DEV-TEST-RETRYCLEANUP";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "owned draft" });

    harness.view.chatId = "unrelated-private-chat";
    harness.input.value = "PRIVATE-UNRELATED-DRAFT";
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker }))
      .rejects.toThrow(/ownership was retained for retry/);

    await expect(runDriverAction(harness.ctx, "chat.beginDevelopmentState", {
      marker: "SS-DEV-TEST-BLOCKED",
    })).rejects.toThrow(/development-test chat is already owned/);

    harness.view.chatId = "";
    harness.input.value = `${marker} owned draft`;
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker }))
      .resolves.toMatchObject({ owned: true, draftCleared: true });

    await expect(runDriverAction(harness.ctx, "chat.beginDevelopmentState", {
      marker: "SS-DEV-TEST-UNBLOCKED",
    })).resolves.toMatchObject({ owned: true });
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker: "SS-DEV-TEST-UNBLOCKED",
    });
  });

  it("retries a failed folder trash without repeating successful chat trash", async () => {
    const marker = "SS-DEV-TEST-FOLDERRETRY";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "owned draft",
      submit: true,
    });
    harness.view.chatId = "development-chat";

    const chatFile = { path: "SystemSculpt/Chats/development-chat.md" };
    const folderPath = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const approvedPath = `${folderPath}/round-trip.md`;
    const folder = { path: folderPath, children: [{ path: approvedPath }] };
    harness.getAbstractFileByPath.mockImplementation((filePath) =>
      filePath === chatFile.path ? chatFile : filePath === folderPath ? folder : null);
    harness.adapterRead.mockImplementation(async (path) => path === approvedPath
      ? "EXACT"
      : `<!-- SYSTEMSCULPT-MESSAGE-START role="user" -->\n${marker}\n`);
    const approved = renderWriteApproval(harness, approvedPath, "EXACT");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: approvedPath,
      text: "EXACT",
    });
    expect(approved).toHaveBeenCalledTimes(1);

    let rejectFolderTrash = true;
    harness.trashFile.mockImplementation(async (file) => {
      if (file === folder && rejectFolderTrash) throw new Error("folder trash failed");
    });
    const cleanup = {
      marker,
      trashDevelopmentPath: folderPath,
      trashSavedChat: true,
    };
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", cleanup))
      .rejects.toThrow(/folder trash failed/);
    expect(harness.trashFile.mock.calls.filter(([file]) => file === chatFile)).toHaveLength(1);
    expect(harness.view.loadChatById).toHaveBeenCalledTimes(1);

    rejectFolderTrash = false;
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", cleanup))
      .resolves.toMatchObject({
        trashedChat: true,
        trashedDevelopmentPath: true,
        restoredPreviousChat: true,
      });
    expect(harness.trashFile.mock.calls.filter(([file]) => file === chatFile)).toHaveLength(1);
    expect(harness.trashFile.mock.calls.filter(([file]) => file === folder)).toHaveLength(2);
    expect(harness.view.loadChatById).toHaveBeenCalledTimes(1);
  });

  it("retries restoration without repeating completed trash operations", async () => {
    const marker = "SS-DEV-TEST-RESTORERETRY";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "owned draft",
      submit: true,
    });
    harness.view.chatId = "development-chat";

    const chatFile = { path: "SystemSculpt/Chats/development-chat.md" };
    const folderPath = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const approvedPath = `${folderPath}/round-trip.md`;
    const folder = { path: folderPath, children: [{ path: approvedPath }] };
    harness.getAbstractFileByPath.mockImplementation((filePath) =>
      filePath === chatFile.path ? chatFile : filePath === folderPath ? folder : null);
    harness.adapterRead.mockImplementation(async (path) => path === approvedPath
      ? "EXACT"
      : `<!-- SYSTEMSCULPT-MESSAGE-START role="user" -->\n${marker}\n`);
    renderWriteApproval(harness, approvedPath, "EXACT");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: approvedPath,
      text: "EXACT",
    });
    harness.view.loadChatById.mockRejectedValueOnce(new Error("restore failed"));

    const cleanup = {
      marker,
      trashDevelopmentPath: folderPath,
      trashSavedChat: true,
    };
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", cleanup))
      .rejects.toThrow(/restore failed/);
    expect(harness.trashFile).toHaveBeenCalledTimes(2);

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", cleanup))
      .resolves.toMatchObject({
        trashedChat: true,
        trashedDevelopmentPath: true,
        restoredPreviousChat: true,
      });
    expect(harness.trashFile).toHaveBeenCalledTimes(2);
    expect(harness.view.loadChatById).toHaveBeenCalledTimes(2);
    expect(harness.view.loadChatById).toHaveBeenLastCalledWith("private-chat");
  });

  it("rejects cleanup retries whose destructive request changes", async () => {
    const marker = "SS-DEV-TEST-REQUESTPIN";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "owned draft" });
    harness.view.chatId = "unrelated-private-chat";
    harness.input.value = "PRIVATE-UNRELATED-DRAFT";

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker }))
      .rejects.toThrow(/ownership was retained for retry/);
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      trashSavedChat: true,
    })).rejects.toThrow(/retry must use the exact cleanup request/);

    harness.view.chatId = "";
    harness.input.value = `${marker} owned draft`;
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker }))
      .resolves.toMatchObject({ owned: true });
  });

  it("accepts an absent requested marker root only before any owned mutation", async () => {
    const marker = "SS-DEV-TEST-ABSENTROOT";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "read-only journey",
    });
    const folderPath = `${DEVELOPMENT_TEST_ROOT}/${marker}`;

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      trashDevelopmentPath: folderPath,
    })).resolves.toMatchObject({
      owned: true,
      draftCleared: true,
      trashedDevelopmentPath: false,
      restoredPreviousChat: true,
    });
    expect(harness.getAbstractFileByPath).toHaveBeenCalledWith(folderPath);
    expect(harness.trashFile).not.toHaveBeenCalled();
    expect(harness.view.loadChatById).toHaveBeenCalledWith("private-chat");
  });

  it("never trashes a marker folder that appeared without an owned approved write", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "owned draft" });
    const folderPath = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const folder = { path: folderPath, children: [] };
    let unexpectedFolderExists = true;
    harness.getAbstractFileByPath.mockImplementation((filePath) =>
      filePath === folderPath && unexpectedFolderExists ? folder : null);
    const cleanup = { marker, trashDevelopmentPath: folderPath };

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", cleanup))
      .rejects.toThrow(/without an owned approved write/);
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", cleanup))
      .rejects.toThrow(/without an owned approved write/);
    expect(harness.trashFile).not.toHaveBeenCalled();
    expect(harness.view.loadChatById).toHaveBeenCalledWith("private-chat");

    unexpectedFolderExists = false;
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", cleanup))
      .resolves.toMatchObject({ trashedDevelopmentPath: false });
    expect(harness.trashFile).not.toHaveBeenCalled();
  });

  it("fails closed when an approved marker root disappears and retries exactly", async () => {
    const marker = "SS-DEV-TEST-MISSINGROOT";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "owned draft" });
    const folderPath = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const approvedPath = `${folderPath}/owned.md`;
    const folder = { path: folderPath, children: [{ path: approvedPath }] };
    renderWriteApproval(harness, approvedPath, "EXACT");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: approvedPath,
      text: "EXACT",
    });
    const cleanup = { marker, trashDevelopmentPath: folderPath };

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", cleanup))
      .rejects.toThrow(/exact owned development marker root is unavailable/);
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker }))
      .rejects.toThrow(/retry must use the exact cleanup request/);
    expect(harness.trashFile).not.toHaveBeenCalled();

    harness.getAbstractFileByPath.mockImplementation((filePath) =>
      filePath === folderPath ? folder : null);
    harness.adapterRead.mockResolvedValue("EXACT");
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", cleanup))
      .resolves.toMatchObject({ trashedDevelopmentPath: true });
    expect(harness.trashFile).toHaveBeenCalledWith(folder);
  });

  it("refuses whole-root cleanup when any descendant was not exactly approved", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "owned draft" });
    const folderPath = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const approvedPath = `${folderPath}/round-trip.md`;
    const unexpectedPath = `${folderPath}/unrelated.md`;
    const approved = renderWriteApproval(harness, approvedPath, "EXACT");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: approvedPath,
      text: "EXACT",
    });
    expect(approved).toHaveBeenCalledTimes(1);
    const folder = {
      path: folderPath,
      children: [{ path: approvedPath }, { path: unexpectedPath }],
    };
    harness.getAbstractFileByPath.mockImplementation((filePath) =>
      filePath === folderPath ? folder : null);
    harness.adapterRead.mockImplementation(async (path) => path === approvedPath ? "EXACT" : "");

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      trashDevelopmentPath: folderPath,
    })).rejects.toThrow(/unapproved or missing descendants/);
    expect(harness.trashFile).not.toHaveBeenCalled();
    expect(harness.view.loadChatById).toHaveBeenCalledWith("private-chat");
  });

  it("refuses whole-root cleanup when an unapproved empty directory is present", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "owned draft" });
    const folderPath = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const approvedPath = `${folderPath}/round-trip.md`;
    const approved = renderWriteApproval(harness, approvedPath, "EXACT");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: approvedPath,
      text: "EXACT",
    });
    expect(approved).toHaveBeenCalledTimes(1);
    const folder = {
      path: folderPath,
      children: [
        { path: approvedPath },
        { path: `${folderPath}/unapproved-empty`, children: [] },
      ],
    };
    harness.getAbstractFileByPath.mockImplementation((filePath) =>
      filePath === folderPath ? folder : null);
    harness.adapterRead.mockImplementation(async (path) => path === approvedPath ? "EXACT" : "");

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      trashDevelopmentPath: folderPath,
    })).rejects.toThrow(/unapproved or missing descendants/);
    expect(harness.trashFile).not.toHaveBeenCalled();
    expect(harness.view.loadChatById).toHaveBeenCalledWith("private-chat");
  });

  it("refuses unrelated active-chat cleanup without touching private state", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "owned draft" });
    harness.input.value = "PRIVATE-UNRELATED-DRAFT";
    harness.view.chatId = "private-chat";
    const inputEvents = jest.fn();
    harness.input.addEventListener("input", inputEvents);

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker }))
      .rejects.toThrow(/not the owned development-test chat/);
    expect(harness.input.value).toBe("PRIVATE-UNRELATED-DRAFT");
    expect(inputEvents).not.toHaveBeenCalled();
    expect(harness.trashFile).not.toHaveBeenCalled();
    expect(harness.view.loadChatById).not.toHaveBeenCalled();
  });

  it("refuses cleanup after the owned saved-chat identity changes", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness({ chatId: "private-chat" });
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    harness.send.onclick = () => { harness.view.chatId = "owned-development-chat"; };
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "owned draft",
      submit: true,
    });
    harness.view.chatId = "different-chat";

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      trashSavedChat: true,
    })).rejects.toThrow(/owned development chat identity changed/);
    expect(harness.trashFile).not.toHaveBeenCalled();
  });

  it("approves only one exact marker-owned write", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "approval check" });
    const ownedPath = `${DEVELOPMENT_TEST_ROOT}/${marker}/round-trip.md`;
    const approved = renderWriteApproval(harness, ownedPath, "EXACT");

    await expect(runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: "WRONG",
    })).rejects.toThrow(/does not exactly match/);
    await expect(runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: `${DEVELOPMENT_TEST_ROOT}/SS-DEV-TEST-CD/round-trip.md`,
      text: "EXACT",
    })).rejects.toThrow(/does not belong to the owned/);
    await expect(runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: "EXACT",
    })).resolves.toEqual({ approved: true, path: ownedPath });
    expect(approved).toHaveBeenCalledTimes(1);

    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("keeps approval and cleanup byte-exact across boundary whitespace", async () => {
    const marker = "SS-DEV-TEST-AB";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "approval check" });
    const folderPath = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const ownedPath = `${folderPath}/round-trip.md`;
    const exactText = "  EXACT  ";
    const approved = renderWriteApproval(harness, ownedPath, exactText);

    await expect(runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: exactText.trim(),
    })).rejects.toThrow(/does not exactly match/);
    expect(approved).not.toHaveBeenCalled();

    await expect(runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: exactText,
    })).resolves.toEqual({ approved: true, path: ownedPath });
    expect(approved).toHaveBeenCalledTimes(1);

    const folder = { path: folderPath, children: [{ path: ownedPath }] };
    harness.getAbstractFileByPath.mockImplementation((filePath) =>
      filePath === folderPath ? folder : null);
    harness.adapterRead.mockResolvedValue(exactText);
    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      trashDevelopmentPath: folderPath,
    })).resolves.toMatchObject({ trashedDevelopmentPath: true });
    expect(harness.trashFile).toHaveBeenCalledWith(folder);
  });

  it("approves the exact supported mutation sequence and restores local trash before cleanup", async () => {
    const marker = "SS-DEV-TEST-MUTATIONMATRIX";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", {
      text: "mutation approval check",
    });
    const root = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const workRoot = `${root}/work`;
    const createdFolderPath = `${workRoot}/created`;
    const primaryPath = `${workRoot}/primary.md`;
    const movedPath = `${workRoot}/moved.md`;
    const original = "ORIGINAL";
    const edited = "EDITED";
    const multi = "MULTI";
    const files = new Map<string, string>();
    const directories = new Set<string>([root, workRoot]);
    const seedApproval = renderWriteApproval(harness, primaryPath, original);
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: primaryPath,
      text: original,
    });
    files.set(primaryPath, original);
    expect(seedApproval).toHaveBeenCalledTimes(1);

    harness.adapterExists.mockImplementation(async (path) =>
      files.has(path) || directories.has(path));
    harness.adapterRead.mockImplementation(async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing synthetic file");
      return value;
    });
    harness.adapterRename.mockImplementation(async (source, destination) => {
      const value = files.get(source);
      if (value === undefined || files.has(destination)) {
        throw new Error("invalid synthetic rename");
      }
      files.delete(source);
      files.set(destination, value);
    });
    harness.adapterRmdir.mockImplementation(async (path, recursive) => {
      if (
        recursive
        || [...files.keys()].some((filePath) => filePath.startsWith(`${path}/`))
        || [...directories].some((directory) =>
          directory !== path && directory.startsWith(`${path}/`))
      ) {
        throw new Error("refused synthetic directory removal");
      }
      directories.delete(path);
    });

    const approve = async (
      index: number,
      toolName: string,
      toolInput: unknown,
    ): Promise<jest.Mock> => {
      const clicked = renderMutationApproval(
        harness,
        `mutation-call-${String(index)}`,
        toolName,
        toolInput,
      );
      await expect(runDriverAction(
        harness.ctx,
        "chat.approveDevelopmentMutationOnce",
        { toolName, input: toolInput },
      )).resolves.toMatchObject({
        approved: true,
        toolName,
        mutationIndex: index,
      });
      expect(clicked).toHaveBeenCalledTimes(1);
      return clicked;
    };

    await approve(1, "create_folders", { paths: [createdFolderPath] });
    directories.add(createdFolderPath);
    await approve(2, "edit", {
      path: primaryPath,
      edits: [{ oldText: original, newText: edited, occurrence: "first", mode: "exact" }],
      strict: true,
    });
    files.set(primaryPath, edited);
    await approve(3, "multi_edit", {
      files: [{
        path: primaryPath,
        edits: [{ oldText: edited, newText: multi, occurrence: "first", mode: "exact" }],
        strict: true,
      }],
    });
    files.set(primaryPath, multi);
    await approve(4, "move", {
      items: [{ source: primaryPath, destination: movedPath }],
    });
    files.delete(primaryPath);
    files.set(movedPath, multi);
    await approve(5, "trash", { paths: [movedPath] });

    const localTrashPath = `.trash/${movedPath}`;
    files.delete(movedPath);
    files.set(localTrashPath, multi);
    directories.add(`.trash/${root}`);
    directories.add(`.trash/${workRoot}`);
    const folder = {
      path: root,
      children: [{
        path: workRoot,
        children: [
          { path: createdFolderPath, children: [] },
          { path: movedPath },
        ],
      }],
    };
    harness.getAbstractFileByPath.mockImplementation((path) => path === root
      ? folder
      : path === movedPath && files.has(movedPath) ? { path: movedPath } : null);

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
    })).rejects.toThrow(/require cleanup of the exact owned marker folder/);
    expect(harness.trashFile).not.toHaveBeenCalled();

    await expect(runDriverAction(harness.ctx, "chat.resetDevelopmentState", {
      marker,
      trashDevelopmentPath: root,
    })).resolves.toMatchObject({
      trashedDevelopmentPath: true,
    });
    expect(harness.adapterRename).toHaveBeenCalledWith(localTrashPath, movedPath);
    expect(harness.adapterRmdir.mock.calls).toEqual([
      [`.trash/${workRoot}`, false],
      [`.trash/${root}`, false],
    ]);
    expect(harness.trashFile).toHaveBeenCalledWith(folder);
  });

  it("refuses identity mismatches and out-of-marker mutation paths before clicking", async () => {
    const marker = "SS-DEV-TEST-MUTATIONREFUSAL";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "approval check" });
    const ownedPath = `${DEVELOPMENT_TEST_ROOT}/${marker}/owned.md`;
    renderWriteApproval(harness, ownedPath, "ORIGINAL");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: "ORIGINAL",
    });

    const actualInput = {
      path: ownedPath,
      edits: [{ oldText: "ORIGINAL", newText: "ACTUAL", occurrence: "first", mode: "exact" }],
      strict: true,
    };
    const mismatched = renderMutationApproval(
      harness,
      "mutation-mismatch",
      "edit",
      actualInput,
    );
    await expect(runDriverAction(
      harness.ctx,
      "chat.approveDevelopmentMutationOnce",
      {
        toolName: "edit",
        input: {
          ...actualInput,
          edits: [{
            oldText: "ORIGINAL",
            newText: "EXPECTED",
            occurrence: "first",
            mode: "exact",
          }],
        },
      },
    )).rejects.toThrow(/does not exactly match/);
    expect(mismatched).not.toHaveBeenCalled();
    harness.container.querySelector(".systemsculpt-agent-turn.is-active")?.remove();

    const escapedInput = {
      items: [{ source: ownedPath, destination: "Outside/moved.md" }],
    };
    const escaped = renderMutationApproval(
      harness,
      "mutation-escaped",
      "move",
      escapedInput,
    );
    await expect(runDriverAction(
      harness.ctx,
      "chat.approveDevelopmentMutationOnce",
      { toolName: "move", input: escapedInput },
    )).rejects.toThrow(/must use a unique marker/);
    expect(escaped).not.toHaveBeenCalled();
    harness.container.querySelector(".systemsculpt-agent-turn.is-active")?.remove();
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("approves a semantically identical mutation that trims executor-default fields", async () => {
    const marker = "SS-DEV-TEST-MUTATIONDEFAULTS";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "approval check" });
    const ownedPath = `${DEVELOPMENT_TEST_ROOT}/${marker}/owned.md`;
    renderWriteApproval(harness, ownedPath, "ORIGINAL");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: "ORIGINAL",
    });

    const trimmedActual = {
      path: ownedPath,
      edits: [{ oldText: "ORIGINAL", newText: "UPDATED" }],
    };
    const clicked = renderMutationApproval(
      harness,
      "mutation-trimmed-defaults",
      "edit",
      trimmedActual,
    );
    await expect(runDriverAction(
      harness.ctx,
      "chat.approveDevelopmentMutationOnce",
      {
        toolName: "edit",
        input: {
          path: ownedPath,
          edits: [{
            oldText: "ORIGINAL",
            newText: "UPDATED",
            occurrence: "first",
            mode: "exact",
          }],
          strict: true,
        },
      },
    )).resolves.toMatchObject({ approved: true, toolName: "edit" });
    expect(clicked).toHaveBeenCalledTimes(1);
    // No reset: an approved mutation demands full marker-folder cleanup, which
    // the dedicated cleanup tests already cover; this harness is test-local.
  });

  it("approves an edit whose every optional field echoes its executor default", async () => {
    // Pins the live tool-matrix observation: the model echoed isRegex:false and
    // preserveIndent:true (both executor defaults, byte-identical effect)
    // alongside occurrence/mode/strict, and approval must not refuse that.
    const marker = "SS-DEV-TEST-MUTATIONECHOES";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "approval check" });
    const ownedPath = `${DEVELOPMENT_TEST_ROOT}/${marker}/owned.md`;
    renderWriteApproval(harness, ownedPath, "ORIGINAL");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: "ORIGINAL",
    });

    const echoedActual = {
      path: ownedPath,
      edits: [{
        oldText: "ORIGINAL",
        newText: "UPDATED",
        occurrence: "first",
        mode: "exact",
        isRegex: false,
        preserveIndent: true,
      }],
      strict: true,
    };
    const clicked = renderMutationApproval(
      harness,
      "mutation-default-echoes",
      "edit",
      echoedActual,
    );
    await expect(runDriverAction(
      harness.ctx,
      "chat.approveDevelopmentMutationOnce",
      {
        toolName: "edit",
        input: {
          path: ownedPath,
          edits: [{ oldText: "ORIGINAL", newText: "UPDATED" }],
        },
      },
    )).resolves.toMatchObject({ approved: true, toolName: "edit" });
    expect(clicked).toHaveBeenCalledTimes(1);
    // No reset: an approved mutation demands full marker-folder cleanup, which
    // the dedicated cleanup tests already cover; this harness is test-local.
  });

  it("still refuses an edit whose echoed optional field changes the effect", async () => {
    const marker = "SS-DEV-TEST-MUTATIONREGEX";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "approval check" });
    const ownedPath = `${DEVELOPMENT_TEST_ROOT}/${marker}/owned.md`;
    renderWriteApproval(harness, ownedPath, "ORIGINAL");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: "ORIGINAL",
    });

    const regexActual = {
      path: ownedPath,
      edits: [{ oldText: "ORIGINAL", newText: "UPDATED", isRegex: true }],
    };
    const refused = renderMutationApproval(
      harness,
      "mutation-regex-mode",
      "edit",
      regexActual,
    );
    await expect(runDriverAction(
      harness.ctx,
      "chat.approveDevelopmentMutationOnce",
      {
        toolName: "edit",
        input: {
          path: ownedPath,
          edits: [{ oldText: "ORIGINAL", newText: "UPDATED" }],
        },
      },
    )).rejects.toThrow(/does not exactly match/);
    expect(refused).not.toHaveBeenCalled();
    harness.container.querySelector(".systemsculpt-agent-turn.is-active")?.remove();
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("still refuses a trimmed mutation whose resolved semantics differ", async () => {
    const marker = "SS-DEV-TEST-MUTATIONSEMANTICS";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "approval check" });
    const ownedPath = `${DEVELOPMENT_TEST_ROOT}/${marker}/owned.md`;
    renderWriteApproval(harness, ownedPath, "ORIGINAL");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: "ORIGINAL",
    });

    const looseActual = {
      path: ownedPath,
      edits: [{ oldText: "ORIGINAL", newText: "UPDATED", mode: "loose" }],
    };
    const refused = renderMutationApproval(
      harness,
      "mutation-loose-mode",
      "edit",
      looseActual,
    );
    await expect(runDriverAction(
      harness.ctx,
      "chat.approveDevelopmentMutationOnce",
      {
        toolName: "edit",
        input: {
          path: ownedPath,
          edits: [{ oldText: "ORIGINAL", newText: "UPDATED" }],
        },
      },
    )).rejects.toThrow(/does not exactly match/);
    expect(refused).not.toHaveBeenCalled();
    harness.container.querySelector(".systemsculpt-agent-turn.is-active")?.remove();
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("refuses multiple visible pending mutations and occupied local-trash destinations", async () => {
    const marker = "SS-DEV-TEST-MUTATIONCOLLISION";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "approval check" });
    const ownedPath = `${DEVELOPMENT_TEST_ROOT}/${marker}/owned.md`;
    renderWriteApproval(harness, ownedPath, "ORIGINAL");
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: "ORIGINAL",
    });
    const firstInput = { paths: [`${DEVELOPMENT_TEST_ROOT}/${marker}/first`] };
    const secondInput = { paths: [`${DEVELOPMENT_TEST_ROOT}/${marker}/second`] };
    const first = renderMutationApproval(harness, "mutation-first", "create_folders", firstInput);
    const second = renderMutationApproval(harness, "mutation-second", "create_folders", secondInput);
    await expect(runDriverAction(
      harness.ctx,
      "chat.approveDevelopmentMutationOnce",
      { toolName: "create_folders", input: firstInput },
    )).rejects.toThrow(/Exactly one visible/);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    for (const turn of harness.container.querySelectorAll(
      ".systemsculpt-agent-turn.is-active",
    )) turn.remove();

    const trashInput = { paths: [ownedPath] };
    const occupied = `.trash/${ownedPath}`;
    harness.adapterExists.mockImplementation(async (path) =>
      path === ownedPath || path === occupied);
    harness.adapterRead.mockResolvedValue("ORIGINAL");
    const trash = renderMutationApproval(harness, "mutation-trash", "trash", trashInput);
    await expect(runDriverAction(
      harness.ctx,
      "chat.approveDevelopmentMutationOnce",
      { toolName: "trash", input: trashInput },
    )).rejects.toThrow(/ambiguous or already occupied/);
    expect(trash).not.toHaveBeenCalled();
    harness.container.querySelector(".systemsculpt-agent-turn.is-active")?.remove();
    await runDriverAction(harness.ctx, "chat.resetDevelopmentState", { marker });
  });

  it("retains cleanup ownership across ambiguous and byte-mismatched trash artifacts", async () => {
    const marker = "SS-DEV-TEST-TRASHRETRY";
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginDevelopmentState", { marker });
    await runDriverAction(harness.ctx, "chat.typeDevelopmentDraft", { text: "approval check" });
    const root = `${DEVELOPMENT_TEST_ROOT}/${marker}`;
    const ownedPath = `${root}/owned.md`;
    const expected = "EXACT";
    const files = new Map<string, string>([[ownedPath, expected]]);
    const directories = new Set<string>([root]);
    renderWriteApproval(harness, ownedPath, expected);
    await runDriverAction(harness.ctx, "chat.approveDevelopmentWriteOnce", {
      path: ownedPath,
      text: expected,
    });
    harness.adapterExists.mockImplementation(async (path) =>
      files.has(path) || directories.has(path));
    harness.adapterRead.mockImplementation(async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing synthetic file");
      return value;
    });
    harness.adapterRename.mockImplementation(async (source, destination) => {
      const value = files.get(source);
      if (value === undefined) throw new Error("missing synthetic trash artifact");
      files.delete(source);
      files.set(destination, value);
    });
    harness.adapterRmdir.mockImplementation(async (path) => { directories.delete(path); });
    const trashInput = { paths: [ownedPath] };
    renderMutationApproval(harness, "mutation-trash-retry", "trash", trashInput);
    await runDriverAction(harness.ctx, "chat.approveDevelopmentMutationOnce", {
      toolName: "trash",
      input: trashInput,
    });

    const mirrored = `.trash/${ownedPath}`;
    const flattened = `.trash/owned.md`;
    files.delete(ownedPath);
    files.set(mirrored, expected);
    files.set(flattened, expected);
    directories.add(`.trash/${root}`);
    const folder = { path: root, children: [{ path: ownedPath }] };
    harness.getAbstractFileByPath.mockImplementation((path) => path === root
      ? folder
      : path === ownedPath && files.has(ownedPath) ? { path: ownedPath } : null);
    const cleanup = { marker, trashDevelopmentPath: root };

    await expect(runDriverAction(
      harness.ctx,
      "chat.resetDevelopmentState",
      cleanup,
    )).rejects.toThrow(/no unique exact local-trash destination/);
    expect(harness.trashFile).not.toHaveBeenCalled();

    files.delete(flattened);
    files.set(mirrored, "WRONG");
    await expect(runDriverAction(
      harness.ctx,
      "chat.resetDevelopmentState",
      cleanup,
    )).rejects.toThrow(/no longer matches its tracked content/);
    expect(harness.trashFile).not.toHaveBeenCalled();

    files.set(mirrored, expected);
    await expect(runDriverAction(
      harness.ctx,
      "chat.resetDevelopmentState",
      cleanup,
    )).resolves.toMatchObject({ trashedDevelopmentPath: true });
    expect(harness.adapterRename).toHaveBeenCalledTimes(1);
    expect(harness.trashFile).toHaveBeenCalledWith(folder);
  });

  it("keeps failing after the fact when continuation appeared before tool settlement", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});

    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant is-active";
    assistantTurn.dataset.turnId = "run-invalid-order";
    harness.container.append(assistantTurn);
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-running";
    tool.dataset.partKey = "tool-live-lifecycle";
    tool.innerHTML = [
      '<div class="systemsculpt-agent-tool">',
      '<div class="systemsculpt-agent-tool-header">',
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read files</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="minus"></span>',
      "</div>",
      "</div>",
    ].join("");
    assistantTurn.append(tool);
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "CONTINUATION-MARKER";
    assistantTurn.append(continuation);
    const status = document.createElement("div");
    status.className = "systemsculpt-agent-tail-status";
    status.dataset.status = "Working in vault";
    harness.container.append(status);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      { toolLabel: "Read files", text: "CONTINUATION-MARKER", timeoutMs: 0 },
    )).rejects.toThrow(/Continuation text appeared.*before its row was visibly settled/);

    tool.className = "systemsculpt-agent-part is-tool is-succeeded";
    const stateIcon = tool.querySelector<HTMLElement>(".systemsculpt-agent-tool-state-icon");
    status.dataset.status = "Thinking";
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      { toolLabel: "Read files", text: "CONTINUATION-MARKER", timeoutMs: 0 },
    )).rejects.toThrow(/Continuation text appeared.*before its row was visibly settled/);

    if (stateIcon) stateIcon.dataset.iconState = "circle-check";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assistantTurn.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      { toolLabel: "Read files", text: "CONTINUATION-MARKER", timeoutMs: 0 },
    )).rejects.toThrow(/Continuation text appeared.*before its row was visibly settled/);

    await expect(runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {}))
      .resolves.toMatchObject({ active: false, source: "live_dom_mutation" });
  });

  it("proves current-run visual settlement preceded continuation using mutation order", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant is-active";
    assistantTurn.dataset.turnId = "run-valid-order";
    harness.container.append(assistantTurn);
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-running";
    tool.dataset.partKey = "tool-valid-lifecycle";
    tool.innerHTML = [
      '<div class="systemsculpt-agent-tool">',
      '<div class="systemsculpt-agent-tool-header">',
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read files</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="minus"></span>',
      "</div>",
      "</div>",
    ].join("");
    assistantTurn.append(tool);
    const status = document.createElement("div");
    status.className = "systemsculpt-agent-tail-status";
    status.dataset.status = "Working in vault";
    harness.container.append(status);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    tool.className = "systemsculpt-agent-part is-tool is-succeeded";
    const stateIcon = tool.querySelector<HTMLElement>(".systemsculpt-agent-tool-state-icon");
    if (stateIcon) stateIcon.dataset.iconState = "check";
    status.dataset.status = "Thinking";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "CONTINUATION-AFTER-DONE";
    assistantTurn.append(continuation);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assistantTurn.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      { toolLabel: "Read files", text: "CONTINUATION-AFTER-DONE", timeoutMs: 0 },
    )).resolves.toMatchObject({
      settled: true,
      turnId: "run-valid-order",
      tool: {
        partKey: "tool-valid-lifecycle",
        state: "succeeded",
        stateIcon: "check",
      },
      continuationAt: { observedSequence: expect.any(Number) },
      lifecycle: {
        partKey: "tool-valid-lifecycle",
        turnId: "run-valid-order",
        transitions: [
          { state: "running", observedSequence: expect.any(Number) },
          { state: "succeeded", observedSequence: expect.any(Number) },
        ],
        visualTransitions: [
          { settled: false, observedSequence: expect.any(Number) },
          { settled: true, observedSequence: expect.any(Number) },
        ],
      },
    });

    await expect(runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {}))
      .resolves.toMatchObject({ active: false, source: "live_dom_mutation" });
  });

  it("correlates a disconnected terminal history row without a rendered part key", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.messageId = "message-keyless-terminal";
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-failed";
    tool.innerHTML = [
      '<div class="systemsculpt-agent-tool">',
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 2 files</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="x"></span>',
      "</div>",
    ].join("");
    assistantTurn.append(tool);
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "KEYLESS-TERMINAL-RECOVERED";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 2 files",
        text: "KEYLESS-TERMINAL-RECOVERED",
        textMode: "equals",
        expectedState: "failed",
        timeoutMs: 0,
      },
    )).resolves.toMatchObject({
      settled: true,
      turnId: expect.stringMatching(/^rendered-turn:/),
      tool: {
        partKey: expect.stringMatching(/^rendered-tool:/),
        state: "failed",
        stateIcon: "x",
      },
      continuationAt: { observedSequence: expect.any(Number) },
      lifecycle: {
        partKey: expect.stringMatching(/^rendered-tool:/),
        turnId: expect.stringMatching(/^rendered-turn:/),
        connected: true,
        transitions: [
          { state: "failed", observedSequence: expect.any(Number) },
        ],
        visualTransitions: [
          { settled: true, observedSequence: expect.any(Number) },
        ],
      },
    });

    assistantTurn.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 2 files",
        text: "KEYLESS-TERMINAL-RECOVERED",
        textMode: "equals",
        expectedState: "failed",
        timeoutMs: 0,
      },
    )).resolves.toMatchObject({
      settled: true,
      tool: { partKey: expect.stringMatching(/^rendered-tool:/) },
      lifecycle: { connected: false },
    });

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects a keyless terminal row that settled after its continuation", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-running";
    tool.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 2 files</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="minus"></span>',
    ].join("");
    assistantTurn.append(tool);
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "KEYLESS-EARLY-CONTINUATION";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    tool.className = "systemsculpt-agent-part is-tool is-failed";
    const stateIcon = tool.querySelector<HTMLElement>(".systemsculpt-agent-tool-state-icon");
    if (stateIcon) stateIcon.dataset.iconState = "x";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assistantTurn.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 2 files",
        text: "KEYLESS-EARLY-CONTINUATION",
        textMode: "equals",
        expectedState: "failed",
        timeoutMs: 0,
      },
    )).rejects.toThrow(/before its row was visibly settled/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("proves a failed tool row settled before recovery continuation", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant is-active";
    assistantTurn.dataset.turnId = "run-failed-tool-recovery";
    harness.container.append(assistantTurn);
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-running";
    tool.dataset.partKey = "tool-failed-recovery";
    tool.innerHTML = [
      '<div class="systemsculpt-agent-tool">',
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="minus"></span>',
      "</div>",
    ].join("");
    assistantTurn.append(tool);
    const status = document.createElement("div");
    status.className = "systemsculpt-agent-tail-status";
    status.dataset.status = "Working in vault";
    harness.container.append(status);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    tool.className = "systemsculpt-agent-part is-tool is-failed";
    const stateIcon = tool.querySelector<HTMLElement>(".systemsculpt-agent-tool-state-icon");
    if (stateIcon) stateIcon.dataset.iconState = "x";
    status.dataset.status = "Thinking";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "FAILED-TOOL-RECOVERED";
    assistantTurn.append(continuation);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 1 file",
        text: "FAILED-TOOL-RECOVERED",
        textMode: "equals",
        expectedState: "failed",
        timeoutMs: 0,
      },
    )).resolves.toMatchObject({
      settled: true,
      turnId: "run-failed-tool-recovery",
      tool: {
        partKey: "tool-failed-recovery",
        state: "failed",
        stateIcon: "x",
      },
      continuationAt: { observedSequence: expect.any(Number) },
    });

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("binds a detached continuation to its own turn before choosing a grouped tool", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const appendCompletedTurn = async (
      turnId: string,
      partKey: string,
      continuationText: string,
      callCount: number,
    ): Promise<void> => {
      const turn = document.createElement("div");
      turn.className = "systemsculpt-agent-turn is-assistant";
      turn.dataset.turnId = turnId;
      const tool = document.createElement("div");
      tool.className = "systemsculpt-agent-part is-tool is-succeeded";
      tool.dataset.partKey = partKey;
      if (callCount > 1) tool.dataset.toolCount = String(callCount);
      tool.innerHTML = [
        '<span class="systemsculpt-agent-tool-icon"></span>',
        '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
        '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="check"></span>',
      ].join("");
      turn.append(tool);
      const continuation = document.createElement("div");
      continuation.className = "systemsculpt-agent-part is-text";
      continuation.textContent = continuationText;
      turn.append(continuation);
      harness.container.append(turn);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      turn.remove();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    };

    await appendCompletedTurn("run-prior-group", "tool-prior-group", "PRIOR-MARKER", 30);
    await appendCompletedTurn("run-latest-single", "tool-latest-single", "LATEST-MARKER", 1);

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      { toolLabel: "Read 1 file", text: "LATEST-MARKER", textMode: "equals", timeoutMs: 0 },
    )).resolves.toMatchObject({
      settled: true,
      turnId: "run-latest-single",
      tool: { partKey: "tool-latest-single", callCount: 1 },
      toolCallCountAtContinuation: 1,
      terminalToolCallCountAtContinuation: 1,
    });
    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects a later marker after early text and still counts grouped partial terminals", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant is-active";
    assistantTurn.dataset.turnId = "run-mixed-tools";
    harness.container.append(assistantTurn);
    const running = document.createElement("div");
    running.className = "systemsculpt-agent-part is-tool is-running";
    running.dataset.partKey = "tool-running-group";
    running.dataset.toolCount = "29";
    running.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Search vault</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="minus"></span>',
    ].join("");
    assistantTurn.append(running);
    const partial = document.createElement("div");
    partial.className = "systemsculpt-agent-part is-tool is-partial";
    partial.dataset.partKey = "tool-partial";
    partial.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read files</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="x"></span>',
    ].join("");
    assistantTurn.append(partial);
    const status = document.createElement("div");
    status.className = "systemsculpt-agent-tail-status";
    status.dataset.status = "Thinking";
    harness.container.append(status);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const earlyContinuation = document.createElement("div");
    earlyContinuation.className = "systemsculpt-agent-part is-text";
    earlyContinuation.textContent = "EARLY-CONTINUATION";
    assistantTurn.append(earlyContinuation);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read files",
        text: "EARLY-CONTINUATION",
        expectedState: "partial",
        timeoutMs: 0,
      },
    )).rejects.toThrow(/before every prior current-run tool was visibly terminal/);

    running.className = "systemsculpt-agent-part is-tool is-succeeded";
    const runningStateIcon = running.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-state-icon",
    );
    if (runningStateIcon) runningStateIcon.dataset.iconState = "check";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      { toolLabel: "Read files", text: "EARLY-CONTINUATION", timeoutMs: 0 },
    )).rejects.toThrow(/before every prior current-run tool was visibly terminal/);

    const lateContinuation = document.createElement("div");
    lateContinuation.className = "systemsculpt-agent-part is-text";
    lateContinuation.textContent = "LATE-CONTINUATION";
    assistantTurn.append(lateContinuation);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read files",
        text: "LATE-CONTINUATION",
        expectedState: "partial",
        timeoutMs: 0,
      },
    )).rejects.toThrow(/before every prior current-run tool was visibly terminal/);
    await expect(runDriverAction(harness.ctx, "chat.assertToolLifecycle", {
      minToolCount: 30,
      requireTerminal: true,
    })).resolves.toMatchObject({
      asserted: true,
      turnId: "run-mixed-tools",
      toolCallCount: 30,
      toolRowCount: 2,
      allTerminal: true,
    });
    await expect(runDriverAction(harness.ctx, "chat.assertToolLifecycle", {
      minToolCount: 31,
    })).rejects.toThrow(/observed 30 tool calls/);
    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects early same-turn text even when terminal UI, ACK, and an exact marker follow", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const lifecycle = toolResultDeliveryDiagnostics(
      "early-pollution",
      "request-early-pollution",
      10,
    );
    diagnostics.push(...lifecycle.slice(0, 2));

    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "turn-early-pollution";
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-running";
    tool.dataset.partKey = "tool:early-pollution";
    tool.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="minus"></span>',
    ].join("");
    assistantTurn.append(tool);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const pollutedText = "PRIVATE-EARLY-CONTINUATION-CONTENT";
    const early = document.createElement("div");
    early.className = "systemsculpt-agent-part is-text";
    early.textContent = pollutedText;
    assistantTurn.append(early);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    tool.className = "systemsculpt-agent-part is-tool is-succeeded";
    const stateIcon = tool.querySelector<HTMLElement>(".systemsculpt-agent-tool-state-icon");
    if (stateIcon) stateIcon.dataset.iconState = "check";
    diagnostics.push(lifecycle[2]!);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const expectedText = "EXACT-AFTER-EARLY-CONTINUATION";
    const exact = document.createElement("div");
    exact.className = "systemsculpt-agent-part is-text";
    exact.textContent = expectedText;
    assistantTurn.append(exact);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const error = await rejectionError(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 1 file",
        text: expectedText,
        textMode: "equals",
        requireCommandAck: true,
        requireAllToolResultAcks: true,
        timeoutMs: 0,
      },
    ));
    expect(error.message).toMatch(/present-but-polluted/);
    expect(error.message).toMatch(/"characters":34/);
    expect(error.message).toMatch(/"sha256":"sha256:[0-9a-f]{64}"/);
    expect(error.message).not.toContain(pollutedText);
    expect(error.message).not.toContain(expectedText);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects same-turn text that painted after terminal UI but before durable ACK", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const lifecycle = toolResultDeliveryDiagnostics(
      "late-ack-pollution",
      "request-late-ack-pollution",
      10,
    );
    diagnostics.push(...lifecycle.slice(0, 2));
    await renderTerminalGroupedToolTurn(harness, {
      continuation: "PRIVATE-BEFORE-ACK-CONTENT",
      firstCallId: "late-ack-pollution",
      toolCount: 1,
      turnId: "turn-late-ack-pollution",
    });
    diagnostics.push(lifecycle[2]!);
    const assistantTurn = harness.container.querySelector<HTMLElement>(
      '[data-turn-id="turn-late-ack-pollution"]',
    );
    if (!assistantTurn) throw new Error("Expected the synthetic assistant turn.");
    const expectedText = "EXACT-AFTER-DURABLE-ACK";
    const exact = document.createElement("div");
    exact.className = "systemsculpt-agent-part is-text";
    exact.textContent = expectedText;
    assistantTurn.append(exact);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const error = await rejectionError(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 1 file",
        text: expectedText,
        textMode: "equals",
        requireCommandAck: true,
        requireAllToolResultAcks: true,
        timeoutMs: 0,
      },
    ));
    expect(error.message).toMatch(/before the matching tool-result command was acknowledged/);
    expect(error.message).not.toContain("PRIVATE-BEFORE-ACK-CONTENT");
    expect(error.message).not.toContain(expectedText);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("accepts multiple same-turn text observations only after terminal UI and durable ACK", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const lifecycle = toolResultDeliveryDiagnostics(
      "safe-multiple-text",
      "request-safe-multiple-text",
      10,
    );
    diagnostics.push(...lifecycle.slice(0, 2));
    await renderTerminalGroupedToolTurn(harness, {
      continuation: "SAFE-FIRST-CONTINUATION",
      firstCallId: "safe-multiple-text",
      beforeContinuation: () => { diagnostics.push(lifecycle[2]!); },
      toolCount: 1,
      turnId: "turn-safe-multiple-text",
    });
    const assistantTurn = harness.container.querySelector<HTMLElement>(
      '[data-turn-id="turn-safe-multiple-text"]',
    );
    if (!assistantTurn) throw new Error("Expected the synthetic assistant turn.");
    const exact = document.createElement("div");
    exact.className = "systemsculpt-agent-part is-text";
    exact.textContent = "SAFE-FINAL-CONTINUATION";
    assistantTurn.append(exact);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 1 file",
        text: "SAFE-FINAL-CONTINUATION",
        textMode: "equals",
        requireCommandAck: true,
        requireAllToolResultAcks: true,
        timeoutMs: 0,
      },
    )).resolves.toMatchObject({
      settled: true,
      continuationObservationsChecked: 2,
      allToolResultsAcknowledgedBeforeContinuation: true,
      expectedAllToolResultState: "succeeded",
    });

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("keeps same-batch pre-tool text before a later tool despite live ancestor nodes", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});

    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "turn-reverse-same-batch";
    harness.container.append(assistantTurn);
    const preToolText = document.createElement("div");
    preToolText.className = "systemsculpt-agent-part is-text";
    preToolText.textContent = "LEGITIMATE-PRE-TOOL-TEXT";
    assistantTurn.append(preToolText);
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-running";
    tool.dataset.partKey = "tool:reverse-same-batch";
    tool.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="minus"></span>',
    ].join("");
    const laterToolWrapper = document.createElement("div");
    laterToolWrapper.className = "systemsculpt-agent-tool-wrapper";
    laterToolWrapper.append(tool);
    assistantTurn.append(laterToolWrapper);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    tool.className = "systemsculpt-agent-part is-tool is-succeeded";
    const stateIcon = tool.querySelector<HTMLElement>(".systemsculpt-agent-tool-state-icon");
    if (stateIcon) stateIcon.dataset.iconState = "check";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "REVERSE-SAME-BATCH-COMPLETE";
    assistantTurn.append(continuation);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 1 file",
        text: "REVERSE-SAME-BATCH-COMPLETE",
        textMode: "equals",
        timeoutMs: 0,
      },
    )).resolves.toMatchObject({
      settled: true,
      continuationObservationsChecked: 2,
      priorToolsChecked: 1,
    });

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("distinguishes mismatched continuation content without exposing it", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const actualText = "PRIVATE-MISMATCHED-CONTINUATION";
    const expectedText = "EXPECTED-PRIVATE-CONTINUATION";
    await renderTerminalGroupedToolTurn(harness, {
      continuation: actualText,
      firstCallId: "mismatched-continuation",
      toolCount: 1,
      turnId: "turn-mismatched-continuation",
    });

    for (const action of [
      "chat.assertLatestToolSettledAfterContinuation",
      "chat.assertAllToolResultSendsCompleted",
    ]) {
      const error = await rejectionError(runDriverAction(harness.ctx, action, {
        toolLabel: "Read 1 file",
        text: expectedText,
        textMode: "equals",
        timeoutMs: 0,
      }));
      expect(error.message).toMatch(/continuation present but mismatched/);
      expect(error.message).toMatch(/"characters":31/);
      expect(error.message).toMatch(/"sha256":"sha256:[0-9a-f]{64}"/);
      expect(error.message).not.toContain(actualText);
      expect(error.message).not.toContain(expectedText);
    }

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("distinguishes an absent continuation for both delivery assertions", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});

    for (const action of [
      "chat.assertLatestToolSettledAfterContinuation",
      "chat.assertAllToolResultSendsCompleted",
    ]) {
      const error = await rejectionError(runDriverAction(harness.ctx, action, {
        toolLabel: "Read 1 file",
        text: "EXPECTED-BUT-ABSENT-CONTINUATION",
        textMode: "equals",
        timeoutMs: 0,
      }));
      expect(error.message).toMatch(/continuation absent/);
      expect(error.message).not.toContain("EXPECTED-BUT-ABSENT-CONTINUATION");
    }

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("counts terminal regrouping without double-counting superseded tool rows", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-regrouped-tools";
    harness.container.append(assistantTurn);
    const tools: HTMLElement[] = [];
    for (let index = 0; index < 30; index += 1) {
      const tool = document.createElement("div");
      tool.className = "systemsculpt-agent-part is-tool is-succeeded";
      tool.dataset.partKey = `tool:read-${String(index)}`;
      tool.innerHTML = [
        '<span class="systemsculpt-agent-tool-icon"></span>',
        '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
        '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="check"></span>',
      ].join("");
      assistantTurn.append(tool);
      tools.push(tool);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const grouped = tools[0];
    if (!grouped) throw new Error("Expected a grouped tool seed.");
    grouped.dataset.toolCount = "30";
    const groupedLabel = grouped.querySelector(".systemsculpt-agent-tool-label");
    if (groupedLabel) groupedLabel.textContent = "Read 30 files";
    for (const tool of tools.slice(1)) tool.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assistantTurn.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(harness.ctx, "chat.assertToolLifecycle", {
      minToolCount: 30,
      requireTerminal: true,
    })).resolves.toMatchObject({
      asserted: true,
      turnId: "run-regrouped-tools",
      toolCallCount: 30,
      toolRowCount: 1,
      connectedToolRowCount: 0,
      observedToolIdentityCount: 30,
      supersededToolRowCount: 29,
      connectedToolCallCount: 0,
      terminalToolCallCount: 30,
      allTerminal: true,
    });
    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("requires the matching command acknowledgement before continuation", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});

    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-ack-before-continuation";
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-succeeded";
    tool.dataset.partKey = "tool:call-ack-before";
    tool.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="check"></span>',
    ].join("");
    assistantTurn.append(tool);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    diagnostics.push(...toolResultDeliveryDiagnostics(
      "call-ack-before",
      "request-ack-before",
      10,
    ).slice(0, 3));
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "ACK-BEFORE-CONTINUATION";
    assistantTurn.append(continuation);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 1 file",
        text: "ACK-BEFORE-CONTINUATION",
        textMode: "equals",
        expectedState: "succeeded",
        requireCommandAck: true,
        timeoutMs: 0,
      },
    )).resolves.toMatchObject({
      settled: true,
      commandAcknowledgedBeforeContinuation: true,
      commandAcknowledgementCountAtContinuation: 1,
    });

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("requires successful result state by default for every-tool ACK proof", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const lifecycle = toolResultDeliveryDiagnostics(
      "failed-result-ack",
      "request-failed-result-ack",
      10,
      "failed",
    );
    diagnostics.push(...lifecycle.slice(0, 3));

    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "turn-failed-result-ack";
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-failed";
    tool.dataset.partKey = "tool:failed-result-ack";
    tool.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="x"></span>',
    ].join("");
    assistantTurn.append(tool);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "FAILED-RESULT-ACK-CONTINUATION";
    assistantTurn.append(continuation);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const params = {
      toolLabel: "Read 1 file",
      text: "FAILED-RESULT-ACK-CONTINUATION",
      textMode: "equals",
      expectedState: "failed",
      requireCommandAck: true,
      timeoutMs: 0,
    };
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      params,
    )).resolves.toMatchObject({
      settled: true,
      commandAcknowledgedBeforeContinuation: true,
      expectedAllToolResultState: null,
    });
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      { ...params, requireAllToolResultAcks: true },
    )).rejects.toThrow(/every current-turn tool result to be succeeded/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("splits every grouped tool ACK before continuation from clean send completion", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const firstLifecycle = toolResultDeliveryDiagnostics(
      "group-call-1",
      "request-grouped-tools",
      10,
    );
    const secondLifecycle = toolResultDeliveryDiagnostics(
      "group-call-2",
      "request-grouped-tools",
      20,
    );
    diagnostics.push(
      ...firstLifecycle.slice(0, 2),
      ...secondLifecycle.slice(0, 2),
    );
    await renderTerminalGroupedToolTurn(harness, {
      continuation: "GROUPED-TOOLS-COMPLETE",
      firstCallId: "group-call-1",
      beforeContinuation: () => {
        diagnostics.push(firstLifecycle[2]!, secondLifecycle[2]!);
      },
      toolCount: 2,
      turnId: "turn-grouped-tools",
    });

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 2 files",
        text: "GROUPED-TOOLS-COMPLETE",
        textMode: "equals",
        requireCommandAck: true,
        requireAllToolResultAcks: true,
        expectedAllToolResultState: "succeeded",
        timeoutMs: 0,
      },
    )).resolves.toMatchObject({
      settled: true,
      allToolResultsAcknowledgedBeforeContinuation: true,
      toolCallCountAtContinuation: 2,
      toolResultAcknowledgementCount: 2,
      expectedAllToolResultState: "succeeded",
      toolResultAcknowledgements: [
        {
          toolExecutionOrdinal: 1,
          localStartCount: 1,
          sendAttemptCount: 1,
          sendCompletionCountAtContinuation: 0,
          sendFailureCompletionCountAtContinuation: 0,
          acknowledgementCount: 1,
          acknowledgedResultState: "succeeded",
        },
        {
          toolExecutionOrdinal: 2,
          localStartCount: 1,
          sendAttemptCount: 1,
          sendCompletionCountAtContinuation: 0,
          sendFailureCompletionCountAtContinuation: 0,
          acknowledgementCount: 1,
          acknowledgedResultState: "succeeded",
        },
      ],
    });

    const completionParams = {
      toolLabel: "Read 2 files",
      text: "GROUPED-TOOLS-COMPLETE",
      textMode: "equals",
      timeoutMs: 0,
    };
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertAllToolResultSendsCompleted",
      completionParams,
    )).rejects.toThrow(/did not record one clean send completion/);

    diagnostics.push(firstLifecycle[3]!, secondLifecycle[3]!);
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertAllToolResultSendsCompleted",
      completionParams,
    )).resolves.toMatchObject({
      completed: true,
      toolCallCount: 2,
      toolResultSendCompletionCount: 2,
      toolResultSendCompletions: [
        {
          toolExecutionOrdinal: 1,
          localStartCount: 1,
          sendAttemptCount: 1,
          acknowledgementCount: 1,
          sendCompletionCount: 1,
          resultState: "succeeded",
        },
        {
          toolExecutionOrdinal: 2,
          localStartCount: 1,
          sendAttemptCount: 1,
          acknowledgementCount: 1,
          sendCompletionCount: 1,
          resultState: "succeeded",
        },
      ],
    });

    diagnostics.push({ ...secondLifecycle[3]!, sequence: 99 });
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertAllToolResultSendsCompleted",
      completionParams,
    )).rejects.toThrow(/duplicate or mismatched send-completion evidence/);
    diagnostics.pop();
    diagnostics.push(
      ...toolResultDeliveryDiagnostics(
        "unbound-call",
        "request-grouped-tools",
        100,
      ),
    );
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertAllToolResultSendsCompleted",
      completionParams,
    )).rejects.toThrow(/unbound current-request tool/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("validates the expected state contract for every current-turn tool result", async () => {
    const harness = makeDevelopmentHarness();
    const params = {
      toolLabel: "Read 1 file",
      text: "EXPECTED-STATE-CONTRACT",
      timeoutMs: 0,
    };

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      { ...params, expectedAllToolResultState: "partial" },
    )).rejects.toThrow(/must be "succeeded" or "failed"/);
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      { ...params, expectedAllToolResultState: "succeeded" },
    )).rejects.toThrow(/requires requireAllToolResultAcks=true/);
  });

  it("rejects a failed sibling acknowledgement when every grouped result must succeed", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const firstLifecycle = toolResultDeliveryDiagnostics(
      "mixed-state-1",
      "request-mixed-state",
      10,
    );
    const secondLifecycle = toolResultDeliveryDiagnostics(
      "mixed-state-2",
      "request-mixed-state",
      20,
      "failed",
    );
    diagnostics.push(...firstLifecycle.slice(0, 2), ...secondLifecycle.slice(0, 2));
    await renderTerminalGroupedToolTurn(harness, {
      continuation: "MIXED-STATE-CONTINUATION",
      firstCallId: "mixed-state-1",
      beforeContinuation: () => {
        diagnostics.push(firstLifecycle[2]!, secondLifecycle[2]!);
      },
      toolCount: 2,
      turnId: "turn-mixed-state",
    });

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 2 files",
        text: "MIXED-STATE-CONTINUATION",
        textMode: "equals",
        requireCommandAck: true,
        requireAllToolResultAcks: true,
        expectedAllToolResultState: "succeeded",
        timeoutMs: 0,
      },
    )).rejects.toThrow(/every current-turn tool result to be succeeded/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects a failed send completion recorded before continuation", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const lifecycle = toolResultDeliveryDiagnostics(
      "premature-failed-send",
      "request-premature-failed-send",
      10,
      "failed",
    );
    diagnostics.push(...lifecycle.slice(0, 2));
    await renderTerminalGroupedToolTurn(harness, {
      continuation: "PREMATURE-FAILED-SEND-CONTINUATION",
      firstCallId: "premature-failed-send",
      beforeContinuation: () => { diagnostics.push(lifecycle[2]!, lifecycle[3]!); },
      toolCount: 1,
      turnId: "turn-premature-failed-send",
    });

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 1 file",
        text: "PREMATURE-FAILED-SEND-CONTINUATION",
        textMode: "equals",
        requireCommandAck: true,
        requireAllToolResultAcks: true,
        timeoutMs: 0,
      },
    )).rejects.toThrow(/no failed send completion before continuation/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects a missing acknowledgement on a nonmatching grouped tool", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const firstLifecycle = toolResultDeliveryDiagnostics(
      "missing-ack-1",
      "request-missing-ack",
      10,
    );
    const secondLifecycle = toolResultDeliveryDiagnostics(
      "missing-ack-2",
      "request-missing-ack",
      20,
    );
    diagnostics.push(...firstLifecycle.slice(0, 2), ...secondLifecycle.slice(0, 2));
    await renderTerminalGroupedToolTurn(harness, {
      continuation: "MISSING-ACK-CONTINUATION",
      firstCallId: "missing-ack-1",
      beforeContinuation: () => { diagnostics.push(firstLifecycle[2]!); },
      toolCount: 2,
      turnId: "turn-missing-ack",
    });

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 2 files",
        text: "MISSING-ACK-CONTINUATION",
        textMode: "equals",
        requireCommandAck: true,
        requireAllToolResultAcks: true,
        timeoutMs: 0,
      },
    )).rejects.toThrow(/every current-turn client tool.*one matching acknowledgement/iu);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects duplicate result delivery on a nonmatching grouped tool", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const firstLifecycle = toolResultDeliveryDiagnostics(
      "duplicate-1",
      "request-duplicate",
      10,
    );
    const secondLifecycle = toolResultDeliveryDiagnostics(
      "duplicate-2",
      "request-duplicate",
      20,
    );
    diagnostics.push(...firstLifecycle.slice(0, 2), ...secondLifecycle.slice(0, 2));
    await renderTerminalGroupedToolTurn(harness, {
      continuation: "DUPLICATE-CONTINUATION",
      firstCallId: "duplicate-1",
      beforeContinuation: () => {
        diagnostics.push(
          firstLifecycle[2]!,
          secondLifecycle[2]!,
          {
            ...supportDiagnostic("command_segment_dispatch_started", "duplicate-2", 30),
            request_id: "request-duplicate",
            command_kind: "client_tool_result",
            command_segment_ordinal: 30,
          },
          {
            ...supportDiagnostic("tool_result_acknowledged_succeeded", "duplicate-2", 31),
            request_id: "request-duplicate",
          },
        );
      },
      toolCount: 2,
      turnId: "turn-duplicate",
    });

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 2 files",
        text: "DUPLICATE-CONTINUATION",
        textMode: "equals",
        requireCommandAck: true,
        requireAllToolResultAcks: true,
        timeoutMs: 0,
      },
    )).rejects.toThrow(/exactly one result-send attempt/iu);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rebinds one canonical lifecycle record across live-to-history replacement", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});

    const turnId = "run-live-history-rebind";
    const callId = "call-live-history-rebind";
    const liveTurn = document.createElement("div");
    liveTurn.className = "systemsculpt-agent-turn is-assistant is-active";
    liveTurn.dataset.turnId = turnId;
    const liveTool = document.createElement("div");
    liveTool.className = "systemsculpt-agent-part is-tool is-running";
    liveTool.dataset.partKey = `tool:${callId}`;
    liveTool.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="minus"></span>',
    ].join("");
    liveTurn.append(liveTool);
    harness.container.append(liveTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    liveTool.className = "systemsculpt-agent-part is-tool is-succeeded";
    const liveStateIcon = liveTool.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-state-icon",
    );
    if (liveStateIcon) liveStateIcon.dataset.iconState = "check";
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    diagnostics.push(...toolResultDeliveryDiagnostics(
      callId,
      "request-live-history-rebind",
      10,
    ).slice(0, 3));

    const historicalTurn = document.createElement("div");
    historicalTurn.className = "systemsculpt-agent-turn is-assistant";
    historicalTurn.dataset.turnId = turnId;
    const historicalTool = document.createElement("div");
    historicalTool.className = "systemsculpt-agent-part is-tool is-succeeded";
    historicalTool.dataset.partKey = `tool:${callId}`;
    historicalTool.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="check"></span>',
    ].join("");
    historicalTurn.append(historicalTool);
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "LIVE-HISTORY-REBIND-CONTINUATION";
    historicalTurn.append(continuation);
    harness.container.prepend(historicalTurn);
    liveTurn.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 1 file",
        text: "LIVE-HISTORY-REBIND-CONTINUATION",
        textMode: "equals",
        expectedState: "succeeded",
        requireCommandAck: true,
        timeoutMs: 0,
      },
    )).resolves.toMatchObject({
      settled: true,
      turnId,
      commandAcknowledgedBeforeContinuation: true,
      lifecycle: {
        partKey: `tool:${callId}`,
        turnId,
        connected: true,
        transitions: [
          { state: "running", observedSequence: expect.any(Number) },
          { state: "succeeded", observedSequence: expect.any(Number) },
        ],
      },
    });
    await expect(runDriverAction(harness.ctx, "chat.toolLifecycle", {}))
      .resolves.toMatchObject({
        tools: [{ partKey: `tool:${callId}`, turnId, connected: true }],
      });

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects an acknowledgement recorded after continuation was observed", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});

    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-ack-after-continuation";
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-succeeded";
    tool.dataset.partKey = "tool:call-ack-after";
    tool.innerHTML = [
      '<span class="systemsculpt-agent-tool-icon"></span>',
      '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>',
      '<span class="systemsculpt-agent-tool-state-icon" data-icon-state="check"></span>',
    ].join("");
    assistantTurn.append(tool);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const lifecycle = toolResultDeliveryDiagnostics(
      "call-ack-after",
      "request-ack-after",
      10,
    );
    diagnostics.push(...lifecycle.slice(0, 2));
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "ACK-AFTER-CONTINUATION";
    assistantTurn.append(continuation);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    diagnostics.push(lifecycle[2]!);

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertLatestToolSettledAfterContinuation",
      {
        toolLabel: "Read 1 file",
        text: "ACK-AFTER-CONTINUATION",
        textMode: "equals",
        expectedState: "succeeded",
        requireCommandAck: true,
        timeoutMs: 0,
      },
    )).rejects.toThrow(/before the matching tool-result command was acknowledged/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("proves an exact terminal plan through a collapsed previous-tool surface", async () => {
    const harness = makeDevelopmentHarness({ chatId: "chat-collapsed-exact-plan" });
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    const tools: ExactToolSeed[] = [{
      callId: "collapsed-exact-1",
      name: "read",
      input: { paths: ["QA/one.md"] },
    }, {
      callId: "collapsed-exact-2",
      name: "read",
      input: { paths: ["QA/two.md"] },
    }];
    const marker = "COLLAPSED-EXACT-COMPLETE";
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
      collapseFinalSurface: true,
      marker,
      tools,
      turnId: "request-collapsed-exact-plan",
    });

    expect(rendered.turn.querySelectorAll(".systemsculpt-agent-part.is-tool"))
      .toHaveLength(1);
    expect(rendered.turn.querySelector(
      'button[data-agent-activity-overflow][aria-expanded="false"]',
    )).not.toBeNull();
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertExactSequentialToolPlan",
      exactSequentialPlanParams(tools, marker),
    )).resolves.toMatchObject({ asserted: true, exactToolCallCount: 2 });
    await expect(runDriverAction(harness.ctx, "chat.assertToolLifecycle", {
      minToolCount: 2,
      requireTerminal: true,
    })).resolves.toMatchObject({
      connectedToolRowCount: 1,
      observedToolIdentityCount: 2,
      observedToolCallCount: 2,
      retainedTerminalToolCallCount: 2,
      terminalToolCallCount: 2,
      allTerminal: true,
    });
    await runDriverAction(harness.ctx, "chat.assertExactToolPlanCleanClose", {});
    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("proves collapsed tools when the hidden activity also includes reasoning", async () => {
    const harness = makeDevelopmentHarness({ chatId: "chat-collapsed-reasoning-plan" });
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    const tools: ExactToolSeed[] = [{
      callId: "collapsed-reasoning-1",
      name: "read",
      input: { paths: ["QA/one.md"] },
    }, {
      callId: "collapsed-reasoning-2",
      name: "read",
      input: { paths: ["QA/two.md"] },
    }];
    const marker = "COLLAPSED-REASONING-COMPLETE";
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
      collapseFinalReasoning: true,
      collapseFinalSurface: true,
      marker,
      tools,
      turnId: "request-collapsed-reasoning-plan",
    });

    const overflow = rendered.turn.querySelector<HTMLButtonElement>(
      'button[data-agent-activity-overflow][aria-expanded="false"]',
    );
    expect(overflow?.dataset.hiddenCount).toBe("2");
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertExactSequentialToolPlan",
      exactSequentialPlanParams(tools, marker),
    )).resolves.toMatchObject({ asserted: true, exactToolCallCount: 2 });
    expect(overflow?.getAttribute("aria-expanded")).toBe("false");
    expect(rendered.turn.querySelectorAll(".systemsculpt-agent-part.is-tool"))
      .toHaveLength(1);
    expect(rendered.turn.querySelector(".systemsculpt-agent-part.is-reasoning"))
      .toBeNull();
    await runDriverAction(harness.ctx, "chat.assertExactToolPlanCleanClose", {});
    expect(overflow?.getAttribute("aria-expanded")).toBe("false");
    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("proves collapsed sequential tools retained after earlier rows detach", async () => {
    const harness = makeDevelopmentHarness({ chatId: "chat-collapsed-retained-plan" });
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    const tools: ExactToolSeed[] = [1, 2, 3].map((index) => ({
      callId: `collapsed-retained-${String(index)}`,
      name: "read",
      input: { paths: [`QA/${String(index)}.md`] },
    }));
    const marker = "COLLAPSED-RETAINED-COMPLETE";
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
      collapseFinalSurface: true,
      detachSettledBeforeNext: true,
      marker,
      tools,
      turnId: "request-collapsed-retained-plan",
    });

    expect(rendered.turn.querySelectorAll(".systemsculpt-agent-part.is-tool"))
      .toHaveLength(1);
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertExactSequentialToolPlan",
      exactSequentialPlanParams(tools, marker),
    )).resolves.toMatchObject({ asserted: true, exactToolCallCount: 3 });
    await runDriverAction(harness.ctx, "chat.assertExactToolPlanCleanClose", {});
    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects malformed production-grouped terminal tool surfaces", async () => {
    const mutations: Array<(row: HTMLElement) => void> = [
      (row) => { row.dataset.toolCount = "3"; },
      (row) => { row.classList.remove("is-grouped"); },
      (row) => { row.dataset.partKey = "tool:wrong-group-anchor"; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const harness = makeDevelopmentHarness({ chatId: `chat-grouped-negative-${String(index)}` });
      const diagnostics: SupportDiagnosticEvent[] = [];
      harness.ctx.readSupportDiagnostics = () => diagnostics;
      const tools: ExactToolSeed[] = [
        { callId: `grouped-negative-${String(index)}-1`, name: "read", input: { paths: ["QA/one.md"] } },
        { callId: `grouped-negative-${String(index)}-2`, name: "read", input: { paths: ["QA/two.md"] } },
      ];
      const marker = `GROUPED-NEGATIVE-${String(index)}`;
      await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
      const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
        groupFinalSurface: true,
        marker,
        tools,
        turnId: `request-grouped-negative-${String(index)}`,
      });
      mutate(rendered.tools[0]!);
      await expect(runDriverAction(
        harness.ctx,
        "chat.assertExactSequentialToolPlan",
        exactSequentialPlanParams(tools, marker),
      )).rejects.toThrow();
      await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
    }
  });

  it("rejects late timer and paint mutations at the exact-plan clean-close boundary", async () => {
    const cases: Array<{
      mutate: (
        harness: ReturnType<typeof makeDevelopmentHarness>,
        rendered: Awaited<ReturnType<typeof renderExactSequentialToolTurn>>,
        tools: readonly ExactToolSeed[],
      ) => void;
      schedule: "paint" | "timer";
      suffix: string;
    }> = [
      {
        suffix: "extra-tool",
        schedule: "timer",
        mutate: (harness, rendered) => {
          const callId = "clean-close-extra-tool";
          harness.agent.active.toolIdentities.set(callId, {
            canonicalInput: canonicalAgentToolInput({ paths: ["QA/late.md"] }),
            toolName: "read",
          });
          rendered.turn.append(exactToolElement(callId, "succeeded"));
        },
      },
      {
        suffix: "nonterminal-tool",
        schedule: "paint",
        mutate: (_harness, rendered) => {
          const tool = rendered.tools[1]!;
          tool.className = "systemsculpt-agent-part is-tool is-running";
          const stateIcon = tool.querySelector<HTMLElement>(
            ".systemsculpt-agent-tool-state-icon",
          );
          if (stateIcon) stateIcon.dataset.iconState = "minus";
        },
      },
      {
        suffix: "additional-text",
        schedule: "timer",
        mutate: (_harness, rendered) => {
          const text = document.createElement("div");
          text.className = "systemsculpt-agent-part is-text";
          text.dataset.partKey = "text:clean-close-additional";
          text.textContent = "PRIVATE LATE ADDITIONAL TEXT";
          rendered.turn.append(text);
        },
      },
      {
        suffix: "duplicate-text",
        schedule: "paint",
        mutate: (_harness, rendered, tools) => {
          const text = document.createElement("div");
          text.className = "systemsculpt-agent-part is-text";
          text.dataset.partKey = "text:clean-close-duplicate";
          text.textContent = `CLEAN-CLOSE-${String(tools.length)}-DUPLICATE-TEXT`;
          rendered.turn.append(text);
        },
      },
    ];

    for (const testCase of cases) {
      const harness = makeDevelopmentHarness({ chatId: `chat-clean-close-${testCase.suffix}` });
      const diagnostics: SupportDiagnosticEvent[] = [];
      harness.ctx.readSupportDiagnostics = () => diagnostics;
      const tools: ExactToolSeed[] = [
        { callId: `${testCase.suffix}-1`, name: "read", input: { paths: ["QA/one.md"] } },
        { callId: `${testCase.suffix}-2`, name: "read", input: { paths: ["QA/two.md"] } },
      ];
      const marker = testCase.suffix === "duplicate-text"
        ? `CLEAN-CLOSE-${String(tools.length)}-DUPLICATE-TEXT`
        : `CLEAN-CLOSE-${testCase.suffix.toUpperCase()}`;
      await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
      const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
        marker,
        tools,
        turnId: `request-clean-close-${testCase.suffix}`,
      });
      await expect(runDriverAction(
        harness.ctx,
        "chat.assertExactSequentialToolPlan",
        exactSequentialPlanParams(tools, marker),
      )).resolves.toMatchObject({ asserted: true });

      if (testCase.schedule === "paint") {
        window.requestAnimationFrame(() => testCase.mutate(harness, rendered, tools));
      } else {
        window.setTimeout(() => testCase.mutate(harness, rendered, tools), 0);
      }
      const error = await rejectionError(runDriverAction(
        harness.ctx,
        "chat.assertExactToolPlanCleanClose",
        {},
      ));
      expect(error.message).toMatch(/did not preserve the proven terminal tool and text surface/);
      expect(error.message).not.toContain("PRIVATE LATE ADDITIONAL TEXT");
      await expect(runDriverAction(
        harness.ctx,
        "chat.endToolLifecycleCapture",
        {},
      )).rejects.toThrow(/post-run clean-close assertion/);
    }
  });

  it("rejects a missing turn, wrong chat, and reordered marker at clean close", async () => {
    const cases: Array<{
      mutate: (
        harness: ReturnType<typeof makeDevelopmentHarness>,
        rendered: Awaited<ReturnType<typeof renderExactSequentialToolTurn>>,
      ) => void;
      suffix: string;
    }> = [
      { suffix: "missing-turn", mutate: (_harness, rendered) => { rendered.turn.remove(); } },
      { suffix: "wrong-chat", mutate: (harness) => { harness.view.chatId = "different-chat"; } },
      {
        suffix: "reordered-marker",
        mutate: (_harness, rendered) => {
          const marker = rendered.turn.querySelector<HTMLElement>(
            ".systemsculpt-agent-part.is-text",
          );
          if (marker) rendered.turn.prepend(marker);
        },
      },
    ];
    for (const testCase of cases) {
      const harness = makeDevelopmentHarness({ chatId: `chat-close-${testCase.suffix}` });
      const diagnostics: SupportDiagnosticEvent[] = [];
      harness.ctx.readSupportDiagnostics = () => diagnostics;
      const tools: ExactToolSeed[] = [
        { callId: `${testCase.suffix}-1`, name: "read", input: { paths: ["QA/one.md"] } },
        { callId: `${testCase.suffix}-2`, name: "read", input: { paths: ["QA/two.md"] } },
      ];
      const marker = `CLEAN-CLOSE-${testCase.suffix.toUpperCase()}`;
      await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
      const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
        groupFinalSurface: true,
        marker,
        tools,
        turnId: `request-close-${testCase.suffix}`,
      });
      await runDriverAction(
        harness.ctx,
        "chat.assertExactSequentialToolPlan",
        exactSequentialPlanParams(tools, marker),
      );
      window.setTimeout(() => testCase.mutate(harness, rendered), 0);
      await expect(runDriverAction(
        harness.ctx,
        "chat.assertExactToolPlanCleanClose",
        {},
      )).rejects.toThrow(/Exact tool-plan clean close/);
      await expect(runDriverAction(
        harness.ctx,
        "chat.endToolLifecycleCapture",
        {},
      )).rejects.toThrow(/post-run clean-close assertion/);
    }
  });

  it("rejects a late duplicate ACK at the exact-plan clean-close boundary", async () => {
    const harness = makeDevelopmentHarness({ chatId: "chat-clean-close-duplicate-ack" });
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    const tools: ExactToolSeed[] = [
      { callId: "clean-close-ack-1", name: "read", input: { paths: ["QA/one.md"] } },
      { callId: "clean-close-ack-2", name: "read", input: { paths: ["QA/two.md"] } },
    ];
    const marker = "CLEAN-CLOSE-DUPLICATE-ACK";
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
      marker,
      tools,
      turnId: "request-clean-close-duplicate-ack",
    });
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertExactSequentialToolPlan",
      exactSequentialPlanParams(tools, marker),
    )).resolves.toMatchObject({ asserted: true });
    window.setTimeout(() => {
      diagnostics.push({ ...rendered.lifecycles[1]![2]!, sequence: 999 });
    }, 0);
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertExactToolPlanCleanClose",
      {},
    )).rejects.toThrow(/proven request delivery boundary/);
    await expect(runDriverAction(
      harness.ctx,
      "chat.endToolLifecycleCapture",
      {},
    )).rejects.toThrow(/post-run clean-close assertion/);
  });

  it("releases a failed exact-plan capture so a new capture can begin", async () => {
    const harness = makeDevelopmentHarness({ chatId: "chat-clean-close-reuse" });
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    const tools: ExactToolSeed[] = [
      { callId: "clean-close-reuse-1", name: "read", input: { paths: ["QA/one.md"] } },
      { callId: "clean-close-reuse-2", name: "read", input: { paths: ["QA/two.md"] } },
    ];
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    await renderExactSequentialToolTurn(harness, diagnostics, {
      marker: "CLEAN-CLOSE-REUSE",
      tools,
      turnId: "request-clean-close-reuse",
    });
    await runDriverAction(
      harness.ctx,
      "chat.assertExactSequentialToolPlan",
      exactSequentialPlanParams(tools, "CLEAN-CLOSE-REUSE"),
    );
    await expect(runDriverAction(
      harness.ctx,
      "chat.endToolLifecycleCapture",
      {},
    )).rejects.toThrow(/post-run clean-close assertion/);
    await expect(runDriverAction(
      harness.ctx,
      "chat.beginToolLifecycleCapture",
      {},
    )).resolves.toMatchObject({ active: true });
    await expect(runDriverAction(
      harness.ctx,
      "chat.endToolLifecycleCapture",
      {},
    )).resolves.toMatchObject({ active: false });
  });

  it("retains same-tick detached text and response-error turn provenance", async () => {
    for (const kind of ["text", "error"] as const) {
      const harness = makeDevelopmentHarness({ chatId: `chat-transient-${kind}` });
      const diagnostics: SupportDiagnosticEvent[] = [];
      harness.ctx.readSupportDiagnostics = () => diagnostics;
      const tools: ExactToolSeed[] = [
        { callId: `transient-${kind}-1`, name: "read", input: { paths: ["QA/one.md"] } },
        { callId: `transient-${kind}-2`, name: "read", input: { paths: ["QA/two.md"] } },
      ];
      const marker = `TRANSIENT-${kind.toUpperCase()}`;
      await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
      const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
        marker,
        tools,
        turnId: `request-transient-${kind}`,
      });
      const transient = document.createElement("div");
      transient.className = `systemsculpt-agent-part is-${kind}`;
      transient.textContent = `PRIVATE TRANSIENT ${kind.toUpperCase()}`;
      rendered.turn.append(transient);
      transient.remove();
      const error = await rejectionError(runDriverAction(
        harness.ctx,
        "chat.assertExactSequentialToolPlan",
        exactSequentialPlanParams(tools, marker),
      ));
      expect(error.message).not.toContain(`PRIVATE TRANSIENT ${kind.toUpperCase()}`);
      if (kind === "text") {
        expect(error.message).toMatch(/pre-tool, duplicate, or additional assistant text/);
      } else {
        expect(error.message).toMatch(/response-wide error part/);
      }
      await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
    }
  });

  it("rejects extra calls and wrong canonical tool identity without exposing input", async () => {
    const cases: Array<{
      actual: ExactToolSeed[];
      expected: ExactToolSeed[];
      marker: string;
    }> = [
      {
        actual: [
          { callId: "extra-1", name: "read", input: { paths: ["Private/one.md"] } },
          { callId: "extra-2", name: "read", input: { paths: ["Private/two.md"] } },
          { callId: "extra-3", name: "read", input: { paths: ["Private/three.md"] } },
        ],
        expected: [
          { callId: "extra-1", name: "read", input: { paths: ["Private/one.md"] } },
          { callId: "extra-2", name: "read", input: { paths: ["Private/two.md"] } },
        ],
        marker: "EXTRA-CALL-REJECTED",
      },
      {
        actual: [
          { callId: "wrong-name-1", name: "search", input: { paths: ["Private/one.md"] } },
          { callId: "wrong-name-2", name: "read", input: { paths: ["Private/two.md"] } },
        ],
        expected: [
          { callId: "wrong-name-1", name: "read", input: { paths: ["Private/one.md"] } },
          { callId: "wrong-name-2", name: "read", input: { paths: ["Private/two.md"] } },
        ],
        marker: "WRONG-NAME-REJECTED",
      },
      {
        actual: [
          { callId: "wrong-input-1", name: "read", input: { paths: ["Private/wrong.md"] } },
          { callId: "wrong-input-2", name: "read", input: { paths: ["Private/two.md"] } },
        ],
        expected: [
          { callId: "wrong-input-1", name: "read", input: { paths: ["Private/right.md"] } },
          { callId: "wrong-input-2", name: "read", input: { paths: ["Private/two.md"] } },
        ],
        marker: "WRONG-INPUT-REJECTED",
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const harness = makeDevelopmentHarness({ chatId: `chat-exact-negative-${String(index)}` });
      const diagnostics: SupportDiagnosticEvent[] = [];
      harness.ctx.readSupportDiagnostics = () => diagnostics;
      await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
      await renderExactSequentialToolTurn(harness, diagnostics, {
        marker: testCase.marker,
        tools: testCase.actual,
        turnId: `request-exact-negative-${String(index)}`,
      });
      const error = await rejectionError(runDriverAction(
        harness.ctx,
        "chat.assertExactSequentialToolPlan",
        exactSequentialPlanParams(testCase.expected, testCase.marker),
      ));
      expect(error.message).not.toContain("Private/");
      await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
    }
  });

  it("accepts trimmed executor-default inputs and benign prose in tolerant plan mode", async () => {
    const harness = makeDevelopmentHarness({ chatId: "chat-exact-semantic" });
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    const actual: ExactToolSeed[] = [
      {
        callId: "semantic-1",
        name: "write",
        input: { path: "QA/one.md", content: "SEMANTIC", createDirs: true },
      },
      { callId: "semantic-2", name: "read", input: { offset: 0, paths: ["QA/one.md"] } },
    ];
    const marker = "SEMANTIC-ACCEPTED";
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    await renderExactSequentialToolTurn(harness, diagnostics, {
      marker,
      preToolText: "I'll write the file first.",
      tools: actual,
      turnId: "request-exact-semantic",
    });
    await expect(runDriverAction(harness.ctx, "chat.assertExactSequentialToolPlan", {
      tools: [
        { name: "write", input: { path: "QA/one.md", content: "SEMANTIC" } },
        { name: "read", input: { paths: ["QA/one.md"] } },
      ],
      text: marker,
      textMode: "contains",
      requireNoOtherText: false,
      timeoutMs: 0,
    })).resolves.toMatchObject({ asserted: true, exactToolCallCount: 2 });
  });

  it("still rejects a trimmed input whose resolved plan semantics differ", async () => {
    const harness = makeDevelopmentHarness({ chatId: "chat-exact-semantic-negative" });
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    const actual: ExactToolSeed[] = [{
      callId: "semantic-negative-1",
      name: "write",
      input: { path: "QA/one.md", content: "SEMANTIC", ifExists: "skip" },
    }];
    const marker = "SEMANTIC-REJECTED";
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    await renderExactSequentialToolTurn(harness, diagnostics, {
      marker,
      tools: actual,
      turnId: "request-exact-semantic-negative",
    });
    await expect(runDriverAction(harness.ctx, "chat.assertExactSequentialToolPlan", {
      tools: [{ name: "write", input: { path: "QA/one.md", content: "SEMANTIC" } }],
      text: marker,
      textMode: "contains",
      requireNoOtherText: false,
      timeoutMs: 0,
    })).rejects.toThrow(/Exact canonical tool identity mismatch/);
    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects same-batch parallel introduction and pre-tool or duplicate prose", async () => {
    const scenarios: Array<{
      duplicate?: boolean;
      marker: string;
      parallelBatch?: boolean;
      preToolText?: string;
    }> = [
      { marker: "PARALLEL-REJECTED", parallelBatch: true },
      { marker: "PRETEXT-REJECTED", preToolText: "PRIVATE-PRE-TOOL-PROSE" },
      { marker: "DUPLICATE-TEXT-REJECTED", duplicate: true },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const harness = makeDevelopmentHarness({ chatId: `chat-order-negative-${String(index)}` });
      const diagnostics: SupportDiagnosticEvent[] = [];
      harness.ctx.readSupportDiagnostics = () => diagnostics;
      const tools: ExactToolSeed[] = [
        { callId: `order-${String(index)}-1`, name: "read", input: { paths: ["QA/one.md"] } },
        { callId: `order-${String(index)}-2`, name: "read", input: { paths: ["QA/two.md"] } },
      ];
      await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
      const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
        marker: scenario.marker,
        parallelBatch: scenario.parallelBatch,
        preToolText: scenario.preToolText,
        tools,
        turnId: `request-order-negative-${String(index)}`,
      });
      if (scenario.duplicate) {
        const duplicate = document.createElement("div");
        duplicate.className = "systemsculpt-agent-part is-text";
        duplicate.dataset.partKey = `text:duplicate:${String(index)}`;
        duplicate.textContent = scenario.marker;
        rendered.turn.append(duplicate);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      await expect(runDriverAction(
        harness.ctx,
        "chat.assertExactSequentialToolPlan",
        exactSequentialPlanParams(tools, scenario.marker),
      )).rejects.toThrow();
      await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
    }
  });

  it("scopes exact delivery evidence to the current request across multiple turns", async () => {
    const harness = makeDevelopmentHarness({ chatId: "chat-multi-request" });
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const firstTools: ExactToolSeed[] = [
      { callId: "multi-first-1", name: "read", input: { paths: ["QA/first-1.md"] } },
      { callId: "multi-first-2", name: "read", input: { paths: ["QA/first-2.md"] } },
    ];
    const secondTools: ExactToolSeed[] = [
      { callId: "multi-second-1", name: "read", input: { paths: ["QA/second-1.md"] } },
      { callId: "multi-second-2", name: "read", input: { paths: ["QA/second-2.md"] } },
    ];
    await renderExactSequentialToolTurn(harness, diagnostics, {
      marker: "MULTI-FIRST-COMPLETE",
      tools: firstTools,
      turnId: "request-multi-first",
    });
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertExactSequentialToolPlan",
      exactSequentialPlanParams(firstTools, "MULTI-FIRST-COMPLETE"),
    )).resolves.toMatchObject({ asserted: true, exactToolCallCount: 2 });

    await renderExactSequentialToolTurn(harness, diagnostics, {
      marker: "MULTI-SECOND-COMPLETE",
      tools: secondTools,
      turnId: "request-multi-second",
    });
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertExactSequentialToolPlan",
      exactSequentialPlanParams(secondTools, "MULTI-SECOND-COMPLETE"),
    )).resolves.toMatchObject({ asserted: true, exactToolCallCount: 2 });

    const wrongRequestTools: ExactToolSeed[] = [
      { callId: "multi-wrong-1", name: "read", input: { paths: ["QA/wrong-1.md"] } },
      { callId: "multi-wrong-2", name: "read", input: { paths: ["QA/wrong-2.md"] } },
    ];
    await renderExactSequentialToolTurn(harness, diagnostics, {
      diagnosticRequestId: "request-multi-first",
      marker: "MULTI-WRONG-REQUEST",
      tools: wrongRequestTools,
      turnId: "request-multi-third",
    });
    await expect(runDriverAction(
      harness.ctx,
      "chat.assertExactSequentialToolPlan",
      exactSequentialPlanParams(wrongRequestTools, "MULTI-WRONG-REQUEST"),
    )).rejects.toThrow(/bind the current tool surface to one request/);
    await runDriverAction(harness.ctx, "chat.assertExactToolPlanCleanClose", {});
    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("requires unique result segments and exact ACK command kind", async () => {
    const run = async (
      suffix: string,
      mutate: (diagnostics: SupportDiagnosticEvent[], lifecycles: SupportDiagnosticEvent[][]) => void,
      shouldPass: boolean,
    ): Promise<void> => {
      const harness = makeDevelopmentHarness({ chatId: `chat-segment-${suffix}` });
      const diagnostics: SupportDiagnosticEvent[] = [];
      harness.ctx.readSupportDiagnostics = () => diagnostics;
      const tools: ExactToolSeed[] = [
        { callId: `segment-${suffix}-1`, name: "read", input: { paths: ["QA/one.md"] } },
        { callId: `segment-${suffix}-2`, name: "read", input: { paths: ["QA/two.md"] } },
      ];
      const marker = `SEGMENT-${suffix.toUpperCase()}`;
      await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
      await renderExactSequentialToolTurn(harness, diagnostics, {
        beforeMarker: (lifecycles) => mutate(diagnostics, lifecycles),
        marker,
        tools,
        turnId: `request-segment-${suffix}`,
      });
      const assertion = runDriverAction(
        harness.ctx,
        "chat.assertExactSequentialToolPlan",
        exactSequentialPlanParams(tools, marker),
      );
      if (shouldPass) {
        await expect(assertion).resolves.toMatchObject({ asserted: true });
        await runDriverAction(harness.ctx, "chat.assertExactToolPlanCleanClose", {});
      } else {
        await expect(assertion).rejects.toThrow();
      }
      await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
    };

    await run("duplicate", (diagnostics, lifecycles) => {
      const duplicate = lifecycles[0]![1]!.command_segment_ordinal;
      const secondOrdinal = lifecycles[1]![0]!.tool_execution_ordinal;
      for (let index = 0; index < diagnostics.length; index += 1) {
        const event = diagnostics[index]!;
        if (
          event.tool_execution_ordinal === secondOrdinal
          && (
            event.code === "command_segment_dispatch_started"
            || event.code === "tool_result_acknowledged_succeeded"
          )
        ) diagnostics[index] = { ...event, command_segment_ordinal: duplicate };
      }
    }, false);
    await run("wrong-kind", (diagnostics, lifecycles) => {
      const secondOrdinal = lifecycles[1]![0]!.tool_execution_ordinal;
      const index = diagnostics.findIndex((event) =>
        event.tool_execution_ordinal === secondOrdinal
        && event.code === "tool_result_acknowledged_succeeded");
      diagnostics[index] = { ...diagnostics[index]!, command_kind: "client_tool_approval" };
    }, false);
    await run("late-sent", (diagnostics) => {
      for (let index = 0; index < diagnostics.length; index += 1) {
        const event = diagnostics[index]!;
        if (!event.code.startsWith("tool_result_sent_")) continue;
        diagnostics[index] = {
          ...event,
          command_kind: undefined,
          command_segment_ordinal: undefined,
        };
      }
    }, true);
  });

  it("catches a response-wide error during the mandatory paint quiescence", async () => {
    const harness = makeDevelopmentHarness({ chatId: "chat-quiescence-error" });
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    const tools: ExactToolSeed[] = [
      { callId: "quiescence-1", name: "read", input: { paths: ["QA/one.md"] } },
      { callId: "quiescence-2", name: "read", input: { paths: ["QA/two.md"] } },
    ];
    const marker = "QUIESCENCE-ERROR";
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const rendered = await renderExactSequentialToolTurn(harness, diagnostics, {
      marker,
      tools,
      turnId: "request-quiescence-error",
    });
    window.setTimeout(() => {
      const error = document.createElement("div");
      error.className = "systemsculpt-agent-part is-error";
      error.textContent = "PRIVATE LATE FAILURE";
      rendered.turn.append(error);
    }, 0);
    const error = await rejectionError(runDriverAction(
      harness.ctx,
      "chat.assertExactSequentialToolPlan",
      exactSequentialPlanParams(tools, marker),
    ));
    expect(error.message).toMatch(/response-wide error part/);
    expect(error.message).not.toContain("PRIVATE LATE FAILURE");
    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("proves an exact continuation had zero client-tool activity", async () => {
    const harness = makeDevelopmentHarness();
    harness.ctx.readSupportDiagnostics = () => [];
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-no-client-tools";
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "INVALID-TOOLS-CORRECTED-V1";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertNoClientToolsBeforeContinuation",
      { text: "INVALID-TOOLS-CORRECTED-V1", timeoutMs: 0 },
    )).resolves.toEqual({
      asserted: true,
      continuationObserved: true,
      observedToolIdentityCount: 0,
      observedToolCallCount: 0,
      localToolExecutionCount: 0,
      toolResultSentCount: 0,
      toolResultAcknowledgedCount: 0,
      pendingApprovalCount: 0,
      pendingClientToolCount: 0,
    });

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects zero-tool proof when support diagnostics are missing", async () => {
    const harness = makeDevelopmentHarness();
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-missing-support-diagnostics";
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "MISSING-DIAGNOSTICS-CORRECTED";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertNoClientToolsBeforeContinuation",
      { text: "MISSING-DIAGNOSTICS-CORRECTED", timeoutMs: 0 },
    )).rejects.toThrow(/Support diagnostics were unavailable/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects zero-tool proof when the support diagnostic baseline throws", async () => {
    const harness = makeDevelopmentHarness();
    let diagnosticsThrow = true;
    harness.ctx.readSupportDiagnostics = () => {
      if (diagnosticsThrow) throw new Error("diagnostics unavailable");
      return [];
    };
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    diagnosticsThrow = false;
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-throwing-support-baseline";
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "THROWING-BASELINE-CORRECTED";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertNoClientToolsBeforeContinuation",
      { text: "THROWING-BASELINE-CORRECTED", timeoutMs: 0 },
    )).rejects.toThrow(/Support diagnostics were unavailable/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects zero-tool proof when the current support diagnostic read throws", async () => {
    const harness = makeDevelopmentHarness();
    let diagnosticsThrow = false;
    harness.ctx.readSupportDiagnostics = () => {
      if (diagnosticsThrow) throw new Error("diagnostics unavailable");
      return [];
    };
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    diagnosticsThrow = true;
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-throwing-current-support";
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "THROWING-CURRENT-CORRECTED";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertNoClientToolsBeforeContinuation",
      { text: "THROWING-CURRENT-CORRECTED", timeoutMs: 0 },
    )).rejects.toThrow(/Support diagnostics were unavailable/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects a transient client-tool card removed before continuation", async () => {
    const harness = makeDevelopmentHarness();
    harness.ctx.readSupportDiagnostics = () => [];
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-transient-client-tool";
    harness.container.append(assistantTurn);
    const tool = document.createElement("div");
    tool.className = "systemsculpt-agent-part is-tool is-running";
    tool.dataset.partKey = "tool:transient-client-tool";
    tool.innerHTML = '<strong class="systemsculpt-agent-tool-label">Read 1 file</strong>';
    assistantTurn.append(tool);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    tool.remove();
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "TRANSIENT-TOOL-CORRECTED";
    assistantTurn.append(continuation);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertNoClientToolsBeforeContinuation",
      { text: "TRANSIENT-TOOL-CORRECTED", timeoutMs: 0 },
    )).rejects.toThrow(/"observedToolIdentityCount":1/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects a local execution lifecycle record without a tool card", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    diagnostics.push(supportDiagnostic("local_tool_started", "local-tool-started"));
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-local-tool-started";
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "LOCAL-EXECUTION-CORRECTED";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertNoClientToolsBeforeContinuation",
      { text: "LOCAL-EXECUTION-CORRECTED", timeoutMs: 0 },
    )).rejects.toThrow(/"localToolExecutionCount":1/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects client-tool result send and acknowledgement records without a card", async () => {
    const harness = makeDevelopmentHarness();
    const diagnostics: SupportDiagnosticEvent[] = [];
    harness.ctx.readSupportDiagnostics = () => diagnostics;
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    diagnostics.push(
      supportDiagnostic("tool_result_sent_failed", "unexpected-result", 1),
      supportDiagnostic("tool_result_acknowledged_failed", "unexpected-result", 2),
    );
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-unexpected-tool-result";
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "UNEXPECTED-RESULT-CORRECTED";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertNoClientToolsBeforeContinuation",
      { text: "UNEXPECTED-RESULT-CORRECTED", timeoutMs: 0 },
    )).rejects.toThrow(
      /"toolResultSentCount":1,"toolResultAcknowledgedCount":1/,
    );

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects a pending client-tool result delivery", async () => {
    const harness = makeDevelopmentHarness();
    harness.ctx.readSupportDiagnostics = () => [];
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    harness.agent.pendingDeliveries.set("pending-result", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-pending-result";
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "PENDING-RESULT-CORRECTED";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertNoClientToolsBeforeContinuation",
      { text: "PENDING-RESULT-CORRECTED", timeoutMs: 0 },
    )).rejects.toThrow(/"pendingClientToolCount":1/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });

  it("rejects a pending client-tool approval", async () => {
    const harness = makeDevelopmentHarness();
    harness.ctx.readSupportDiagnostics = () => [];
    await runDriverAction(harness.ctx, "chat.beginToolLifecycleCapture", {});
    harness.agent.pendingApprovalDeliveries.set("pending-approval", {});
    const assistantTurn = document.createElement("div");
    assistantTurn.className = "systemsculpt-agent-turn is-assistant";
    assistantTurn.dataset.turnId = "run-pending-approval";
    const continuation = document.createElement("div");
    continuation.className = "systemsculpt-agent-part is-text";
    continuation.textContent = "PENDING-APPROVAL-CORRECTED";
    assistantTurn.append(continuation);
    harness.container.append(assistantTurn);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect(runDriverAction(
      harness.ctx,
      "chat.assertNoClientToolsBeforeContinuation",
      { text: "PENDING-APPROVAL-CORRECTED", timeoutMs: 0 },
    )).rejects.toThrow(/"pendingApprovalCount":1/);

    await runDriverAction(harness.ctx, "chat.endToolLifecycleCapture", {});
  });
});

describe("diagnostics export attribution", () => {
  interface FakeDiagnosticsFs {
    files: Map<string, string>;
    trashed: string[];
  }

  function makeDiagnosticsContext(options: {
    trashLocal?: boolean;
    basePath?: string;
  } = {}) {
    const fs: FakeDiagnosticsFs = { files: new Map(), trashed: [] };
    const directory = ".systemsculpt/diagnostics";
    const adapter: Record<string, unknown> = {
      exists: jest.fn(async (path: string) =>
        path === directory || fs.files.has(path)),
      list: jest.fn(async () => ({
        files: [...fs.files.keys()],
        folders: [],
      })),
      read: jest.fn(async (path: string) => {
        const text = fs.files.get(path);
        if (text === undefined) throw new Error(`missing ${path}`);
        return text;
      }),
      stat: jest.fn(async (path: string) => {
        const text = fs.files.get(path);
        if (text === undefined) return null;
        return { type: "file", size: new TextEncoder().encode(text).byteLength };
      }),
    };
    if (options.trashLocal !== false) {
      adapter.trashLocal = jest.fn(async (path: string) => {
        fs.files.delete(path);
        fs.trashed.push(path);
      });
    }
    if (options.basePath) {
      adapter.getBasePath = () => options.basePath;
    }
    const ctx: ActionContext = {
      app: { vault: { adapter } } as unknown as App,
      pluginId: "systemsculpt-ai",
      pluginVersion: "0.0.0-test",
      buildStamp: "test-build",
      diagnostics: {} as ActionContext["diagnostics"],
    };
    return { ctx, fs, adapter };
  }

  function snapshotText(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schema_version: 1,
      generated_at: "2026-08-10T14:00:00.000Z",
      plugin_version: "0.0.0-test",
      obsidian_version: "1.13.0",
      status: { safe_mode: false },
      event_count: 1,
      events: [{ level: "info", message: "plugin loaded" }],
      resource_sample_count: 0,
      resources: [],
      ...overrides,
    }, null, 2);
  }

  function exportPath(nonceChar: string): string {
    return `.systemsculpt/diagnostics/diagnostics-20260810-140000-${nonceChar.repeat(32)}.txt`;
  }

  it("attributes exactly one new export and trashes only that file", async () => {
    const { ctx, fs } = makeDiagnosticsContext();
    fs.files.set(exportPath("a"), snapshotText());

    const baseline = await runDriverAction(ctx, "diagnostics.baselineExports", {});
    expect(baseline).toEqual({ baselinedCount: 1 });

    fs.files.set(exportPath("b"), snapshotText());
    const attribution = await runDriverAction(
      ctx,
      "diagnostics.attributeNewExport",
      { timeoutMs: 0 },
    ) as Record<string, unknown>;
    expect(attribution.basename)
      .toBe(`diagnostics-20260810-140000-${"b".repeat(32)}.txt`);
    expect(attribution.eventCount).toBe(1);
    expect(attribution.resourceSampleCount).toBe(0);
    expect(typeof attribution.bytes).toBe("number");
    expect(attribution.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    const trashResult = await runDriverAction(
      ctx,
      "diagnostics.trashAttributedExport",
      {},
    ) as Record<string, unknown>;
    expect(trashResult.trashed).toBe(true);
    expect(fs.trashed).toEqual([exportPath("b")]);
    expect(fs.files.has(exportPath("a"))).toBe(true);
  });

  it("requires a baseline before attribution", async () => {
    const { ctx } = makeDiagnosticsContext();
    await expect(runDriverAction(ctx, "diagnostics.attributeNewExport", { timeoutMs: 0 }))
      .rejects.toThrow(/baselineExports first/);
  });

  it("fails when more than one new export appears", async () => {
    const { ctx, fs } = makeDiagnosticsContext();
    await runDriverAction(ctx, "diagnostics.baselineExports", {});
    fs.files.set(exportPath("a"), snapshotText());
    fs.files.set(exportPath("b"), snapshotText());
    await expect(runDriverAction(ctx, "diagnostics.attributeNewExport", { timeoutMs: 0 }))
      .rejects.toThrow(/exactly one new diagnostics export; found 2/);
  });

  it("fails when no new export appears within the timeout", async () => {
    const { ctx } = makeDiagnosticsContext();
    await runDriverAction(ctx, "diagnostics.baselineExports", {});
    await expect(runDriverAction(ctx, "diagnostics.attributeNewExport", { timeoutMs: 0 }))
      .rejects.toThrow(/No new diagnostics export appeared/);
  });

  it("rejects a snapshot with a non-allowlisted top-level key", async () => {
    const { ctx, fs } = makeDiagnosticsContext();
    await runDriverAction(ctx, "diagnostics.baselineExports", {});
    fs.files.set(exportPath("a"), snapshotText({ raw_console: [] }));
    await expect(runDriverAction(ctx, "diagnostics.attributeNewExport", { timeoutMs: 0 }))
      .rejects.toThrow(/non-allowlisted top-level key: "raw_console"/);
  });

  it("rejects a snapshot whose plugin_version mismatches the loaded plugin", async () => {
    const { ctx, fs } = makeDiagnosticsContext();
    await runDriverAction(ctx, "diagnostics.baselineExports", {});
    fs.files.set(exportPath("a"), snapshotText({ plugin_version: "9.9.9" }));
    await expect(runDriverAction(ctx, "diagnostics.attributeNewExport", { timeoutMs: 0 }))
      .rejects.toThrow(/plugin_version does not match/);
  });

  it("rejects a snapshot failing the tool_call_id privacy canary", async () => {
    const { ctx, fs } = makeDiagnosticsContext();
    await runDriverAction(ctx, "diagnostics.baselineExports", {});
    fs.files.set(exportPath("a"), snapshotText({
      events: [{ message: "tool_call_id leaked" }],
      event_count: 1,
    }));
    await expect(runDriverAction(ctx, "diagnostics.attributeNewExport", { timeoutMs: 0 }))
      .rejects.toThrow(/tool_call_id must not be exported/);
  });

  it("rejects a snapshot leaking the absolute vault base path", async () => {
    const { ctx, fs } = makeDiagnosticsContext({ basePath: "/Users/example/vault" });
    await runDriverAction(ctx, "diagnostics.baselineExports", {});
    fs.files.set(exportPath("a"), snapshotText({
      events: [{ message: "wrote /Users/example/vault/note.md" }],
      event_count: 1,
    }));
    await expect(runDriverAction(ctx, "diagnostics.attributeNewExport", { timeoutMs: 0 }))
      .rejects.toThrow(/absolute vault path leaked/);
  });

  it("refuses to trash without a successful attribution", async () => {
    const { ctx } = makeDiagnosticsContext();
    await expect(runDriverAction(ctx, "diagnostics.trashAttributedExport", {}))
      .rejects.toThrow(/requires a successful diagnostics.attributeNewExport/);
  });

  it("refuses to trash when the attributed file changed since attribution", async () => {
    const { ctx, fs } = makeDiagnosticsContext();
    await runDriverAction(ctx, "diagnostics.baselineExports", {});
    fs.files.set(exportPath("a"), snapshotText());
    await runDriverAction(ctx, "diagnostics.attributeNewExport", { timeoutMs: 0 });
    fs.files.set(exportPath("a"), snapshotText({ generated_at: "2026-08-10T15:00:00.000Z" }));
    await expect(runDriverAction(ctx, "diagnostics.trashAttributedExport", {}))
      .rejects.toThrow(/changed since attribution/);
    expect(fs.trashed).toEqual([]);
  });

  it("refuses permanent deletion when recoverable trash is unavailable", async () => {
    const { ctx, fs } = makeDiagnosticsContext({ trashLocal: false });
    await runDriverAction(ctx, "diagnostics.baselineExports", {});
    fs.files.set(exportPath("a"), snapshotText());
    await runDriverAction(ctx, "diagnostics.attributeNewExport", { timeoutMs: 0 });
    await expect(runDriverAction(ctx, "diagnostics.trashAttributedExport", {}))
      .rejects.toThrow(/refusing to delete permanently/);
    expect(fs.files.has(exportPath("a"))).toBe(true);
  });
});
