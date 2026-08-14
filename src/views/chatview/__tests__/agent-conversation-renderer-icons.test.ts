/**
 * @jest-environment jsdom
 */

import { App, MarkdownRenderer, setIcon, TFile } from "obsidian";
import type { ChatMessage, MessagePart } from "../../../types";
import type { AgentConversationSnapshot, AgentPart } from "../AgentConversation";
import type { ToolCall } from "../../../types/toolCalls";
import type {
  AgentConversationPresentation,
  AgentPresentationPhase,
} from "../AgentConversationPresentation";
import { AgentConversationRenderer } from "../AgentConversationRenderer";

function presentation(
  phase: AgentPresentationPhase,
  busy: boolean,
  activityStatus: string,
  snapshot: AgentConversationSnapshot,
): AgentConversationPresentation {
  return {
    phase,
    busy,
    composerRunning: busy,
    visibleParts: snapshot.parts,
    activityStatus,
  };
}

describe("AgentConversationRenderer tail status", () => {
  afterEach(() => {
    document.body.empty();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("maintains a frozen scalar-only incident snapshot without reading rendered content", async () => {
    let now = 100;
    const performanceNow = jest.spyOn(window.performance, "now")
      .mockImplementation(() => now);
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "private-path-canary.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const snapshot: AgentConversationSnapshot = {
      runId: "private-run-id-canary",
      turnId: "private-turn-id-canary",
      status: "running",
      phase: "working",
      messages: [{
        id: "private-message-id-canary",
        role: "assistant",
        partIds: ["private-reasoning-id-canary", "private-tool-id-canary"],
      }],
      parts: [{
        id: "private-reasoning-id-canary",
        kind: "reasoning",
        messageId: "private-message-id-canary",
        state: "streaming",
        summary: "private-reasoning-content-canary",
        order: 0,
      }, {
        id: "private-tool-id-canary",
        kind: "tool",
        messageId: "private-message-id-canary",
        callId: "private-tool-call-id-canary",
        name: "read",
        location: "vault",
        input: { paths: ["private-tool-path-canary.md"] },
        state: "running",
        order: 1,
      }],
    };

    const rendering = renderer.renderActive(
      snapshot,
      presentation("responding", true, "Working", snapshot),
    );
    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      renderPassCount: 1,
      pendingRenderPassCount: 1,
    });
    now = 112;
    await rendering;

    const captured = renderer.captureIncidentSnapshot();
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.keys(captured)).toEqual([
      "renderPassCount",
      "pendingRenderPassCount",
      "lastRenderDurationMs",
      "maxRenderDurationMs",
      "historicalRowCount",
      "historicalPartCount",
      "activePartCount",
      "disclosureCount",
      "openDisclosureCount",
      "activityDisclosureCount",
      "reasoningDisclosureCount",
      "toolDisclosureCount",
      "overflowDisclosureCount",
      "pendingHydrationCount",
      "renderingEnabled",
    ]);
    expect(captured).toMatchObject({
      renderPassCount: 1,
      pendingRenderPassCount: 0,
      lastRenderDurationMs: 12,
      maxRenderDurationMs: 12,
      historicalRowCount: 0,
      historicalPartCount: 0,
      activePartCount: 2,
      disclosureCount: 3,
      openDisclosureCount: 0,
      activityDisclosureCount: 0,
      reasoningDisclosureCount: 1,
      toolDisclosureCount: 1,
      overflowDisclosureCount: 1,
      pendingHydrationCount: 0,
      renderingEnabled: true,
    });
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("private-");
    expect(Object.values(captured).every((value) =>
      typeof value === "number" || typeof value === "boolean"))
      .toBe(true);
    const querySelectorAll = jest.spyOn(renderer.element, "querySelectorAll")
      .mockImplementation(() => {
        throw new Error("dom-traversal-private-canary");
      });
    expect(() => renderer.captureIncidentSnapshot()).not.toThrow();
    expect(querySelectorAll).not.toHaveBeenCalled();
    querySelectorAll.mockRestore();

    const overflow = parent.querySelector<HTMLButtonElement>(
      ".systemsculpt-agent-activity-overflow",
    )!;
    overflow.click();
    const disclosures = parent.querySelectorAll<HTMLDetailsElement>(
      ".systemsculpt-agent-reasoning-details, details.systemsculpt-agent-tool",
    );
    for (const disclosure of Array.from(disclosures)) {
      disclosure.open = true;
      disclosure.dispatchEvent(new Event("toggle"));
    }
    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      disclosureCount: 3,
      openDisclosureCount: 3,
      activityDisclosureCount: 0,
      reasoningDisclosureCount: 1,
      toolDisclosureCount: 1,
      overflowDisclosureCount: 1,
    });

    const reasoning = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-reasoning-details",
    )!;
    reasoning.open = false;
    reasoning.dispatchEvent(new Event("toggle"));
    expect(renderer.captureIncidentSnapshot().openDisclosureCount).toBe(2);

    const unavailableToolSnapshot: AgentConversationSnapshot = {
      ...snapshot,
      parts: snapshot.parts.map((part) => part.kind === "tool"
        ? { ...part, input: {} }
        : part),
    };
    await renderer.renderActive(
      unavailableToolSnapshot,
      presentation("responding", true, "Working", unavailableToolSnapshot),
    );
    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      disclosureCount: 2,
      openDisclosureCount: 1,
      activityDisclosureCount: 0,
      reasoningDisclosureCount: 1,
      toolDisclosureCount: 0,
      overflowDisclosureCount: 1,
    });

    const reasoningOnlySnapshot: AgentConversationSnapshot = {
      ...snapshot,
      messages: [{
        ...snapshot.messages[0]!,
        partIds: [snapshot.parts[0]!.id],
      }],
      parts: [snapshot.parts[0]!],
    };
    await renderer.renderActive(
      reasoningOnlySnapshot,
      presentation("reasoning", true, "Working", reasoningOnlySnapshot),
    );
    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      activePartCount: 1,
      disclosureCount: 0,
      openDisclosureCount: 0,
      activityDisclosureCount: 0,
      reasoningDisclosureCount: 0,
      toolDisclosureCount: 0,
      overflowDisclosureCount: 0,
    });

    renderer.resetIncidentRenderMetrics();
    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      renderPassCount: 0,
      pendingRenderPassCount: 0,
      disclosureCount: 0,
      reasoningDisclosureCount: 0,
    });

    renderer.clearActive();
    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      activePartCount: 0,
      disclosureCount: 0,
      openDisclosureCount: 0,
    });
    await renderer.renderHistory([{
      role: "user",
      message_id: "user-incident-history",
      content: "Private user content canary",
    }, {
      role: "assistant",
      message_id: "assistant-incident-history",
      content: "Private assistant content canary",
    }]);
    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      historicalRowCount: 2,
      historicalPartCount: 1,
    });
    const internals = renderer as unknown as {
      historyRows: Map<unknown, unknown>;
      incidentDisclosureStates: Map<unknown, unknown>;
      historicalActivityHydrationStates: Map<unknown, unknown>;
      historicalOverflowHydrationStates: Map<unknown, unknown>;
    };
    const disclosureValues = jest.spyOn(internals.incidentDisclosureStates, "values");
    const forbiddenTraversalSpies = [
      jest.spyOn(internals.historyRows, "values").mockImplementation(() => {
        throw new Error("history-traversal-private-canary");
      }),
      jest.spyOn(internals.historicalActivityHydrationStates, "values").mockImplementation(() => {
        throw new Error("activity-hydration-traversal-private-canary");
      }),
      jest.spyOn(internals.historicalOverflowHydrationStates, "values").mockImplementation(() => {
        throw new Error("overflow-hydration-traversal-private-canary");
      }),
    ];
    expect(() => renderer.captureIncidentSnapshot()).not.toThrow();
    expect(disclosureValues).toHaveBeenCalledTimes(1);
    expect(forbiddenTraversalSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    disclosureValues.mockRestore();
    for (const spy of forbiddenTraversalSpies) spy.mockRestore();

    await renderer.renderActive(
      snapshot,
      presentation("responding", true, "Working", snapshot),
    );
    expect(renderer.captureIncidentSnapshot().disclosureCount).toBe(3);
    renderer.unload();
    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      disclosureCount: 0,
      openDisclosureCount: 0,
      activityDisclosureCount: 0,
      reasoningDisclosureCount: 0,
      toolDisclosureCount: 0,
      overflowDisclosureCount: 0,
      renderingEnabled: false,
    });
    performanceNow.mockRestore();
  });

  it("bounds incident render metrics and isolates a reset from an older render pass", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "private-path-canary.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const internals = renderer as unknown as {
      incidentRenderPassCount: number;
      incidentPendingRenderPassCount: number;
      incidentLastRenderDurationMs: number;
      incidentMaxRenderDurationMs: number;
      incidentHistoricalPartCount: number;
      trackIncidentDisclosure(
        element: HTMLElement,
        kind: "activity" | "reasoning" | "tool" | "overflow",
        available: boolean,
        open: boolean,
      ): void;
      incidentPendingHydrationCount: number;
      incidentMonotonicNow: () => number;
      measureIncidentRenderPass: (task: () => Promise<void>) => Promise<void>;
    };
    internals.incidentRenderPassCount = Number.POSITIVE_INFINITY;
    internals.incidentPendingRenderPassCount = -2;
    internals.incidentLastRenderDurationMs = Number.NaN;
    internals.incidentMaxRenderDurationMs = 100_000_000;
    internals.incidentHistoricalPartCount = 1_000_001;
    internals.incidentPendingHydrationCount = 1_000_001;
    internals.trackIncidentDisclosure(parent.createDiv(), "activity", true, true);
    internals.trackIncidentDisclosure(parent.createDiv(), "reasoning", true, false);
    internals.trackIncidentDisclosure(parent.createDiv(), "tool", true, true);
    internals.trackIncidentDisclosure(parent.createDiv(), "overflow", false, true);

    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      renderPassCount: 0,
      pendingRenderPassCount: 0,
      lastRenderDurationMs: 0,
      maxRenderDurationMs: 86_400_000,
      historicalPartCount: 1_000_000,
      disclosureCount: 3,
      openDisclosureCount: 2,
      activityDisclosureCount: 1,
      reasoningDisclosureCount: 1,
      toolDisclosureCount: 1,
      overflowDisclosureCount: 0,
      pendingHydrationCount: 1_000_000,
    });

    let release!: () => void;
    const task = new Promise<void>((resolve) => { release = resolve; });
    const measured = internals.measureIncidentRenderPass(() => task);
    renderer.resetIncidentRenderMetrics();
    release();
    await measured;
    expect(renderer.captureIncidentSnapshot()).toMatchObject({
      renderPassCount: 0,
      pendingRenderPassCount: 0,
      lastRenderDurationMs: 0,
      maxRenderDurationMs: 0,
      disclosureCount: 3,
      openDisclosureCount: 2,
    });

    const performanceNow = jest.spyOn(window.performance, "now")
      .mockImplementation(() => { throw new Error("private clock failure"); });
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(Number.NaN);
    expect(internals.incidentMonotonicNow()).toBe(0);
    dateNow.mockImplementation(() => { throw new Error("private wall clock failure"); });
    expect(internals.incidentMonotonicNow()).toBe(0);
    dateNow.mockRestore();
    performanceNow.mockRestore();
    renderer.unload();
  });

  it("reports committed failures and restores selection without optional browser helpers", () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "private-path-canary.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const internals = renderer as unknown as {
      activeTurnId: string | null;
      committedFailedTurnIds: Set<string>;
      incidentMonotonicNow(): number;
      restoreDomSelection(selection: Readonly<{
        anchorNode: Node;
        anchorOffset: number;
        focusNode: Node;
        focusOffset: number;
      }> | null): void;
    };

    internals.committedFailedTurnIds.add("turn-committed-failure");
    expect(renderer.hasCommittedFailureSurface("turn-committed-failure")).toBe(true);
    internals.activeTurnId = "turn-other-failure";
    expect(renderer.hasCommittedFailureSurface("turn-missing-failure")).toBe(false);

    const performanceNow = jest.spyOn(window.performance, "now").mockReturnValue(Number.NaN);
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(321);
    expect(internals.incidentMonotonicNow()).toBe(321);
    dateNow.mockRestore();
    performanceNow.mockRestore();

    const anchor = document.createTextNode("private-selection-canary");
    const focus = parent.createSpan();
    parent.appendChild(anchor);
    const preserved = {
      anchorNode: anchor,
      anchorOffset: 99,
      focusNode: focus,
      focusOffset: 99,
    };
    const getSelection = jest.spyOn(document, "getSelection").mockReturnValue(null);
    expect(() => internals.restoreDomSelection(preserved)).not.toThrow();

    const removeAllRanges = jest.fn();
    const addRange = jest.fn();
    getSelection.mockReturnValue({
      removeAllRanges,
      addRange,
    } as unknown as Selection);
    Object.defineProperty(anchor, "nodeValue", {
      configurable: true,
      get: () => null,
    });
    internals.restoreDomSelection(preserved);
    expect(addRange).toHaveBeenCalledTimes(1);
    expect((addRange.mock.calls[0]?.[0] as Range).startOffset).toBe(0);

    addRange.mockImplementationOnce(() => {
      throw new Error("private-selection-restore-canary");
    });
    expect(() => internals.restoreDomSelection(preserved)).not.toThrow();
    expect(removeAllRanges).toHaveBeenCalledTimes(3);
    getSelection.mockRestore();

    const history = renderer.element.querySelector<HTMLElement>(
      ".systemsculpt-agent-history",
    )!;
    const row = history.createDiv({
      cls: "systemsculpt-agent-turn",
      attr: { "data-message-id": "message-focus-guard" },
    });
    const edit = row.createEl("button", { attr: { "data-focus-key": "edit-message" } });
    renderer.focusMessageEditAction("message-focus-guard");
    expect(document.activeElement).toBe(edit);
    renderer.unload();
  });

  it("keeps malformed durable and historical parts inside defensive rendering guards", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const internals = renderer as unknown as {
      finalHistoricalAnswerPartIds(parts: readonly Readonly<{
        part: MessagePart;
        messageId: string;
      }>[] | readonly []): ReadonlySet<string>;
      renderHistoricalPart(parent: HTMLElement, part: MessagePart): Promise<void>;
      renderHistoricalParts(
        parent: HTMLElement,
        parts: readonly MessagePart[],
        elapsedMs?: number,
        finalAnswerPartIds?: ReadonlySet<string>,
        cancelled?: boolean,
      ): Promise<boolean>;
      renderHistoricalTimeline(
        parent: HTMLElement,
        parts: readonly MessagePart[],
        isCurrent?: () => boolean,
      ): Promise<boolean>;
    };
    const blankReasoning: MessagePart = {
      id: "reasoning-blank-guard",
      type: "reasoning",
      timestamp: 1,
      data: "   ",
    };
    expect(internals.finalHistoricalAnswerPartIds([{
      part: blankReasoning,
      messageId: "assistant-blank-reasoning-guard",
    }]).has(blankReasoning.id)).toBe(false);

    const scratch = parent.createDiv();
    await internals.renderHistoricalPart(scratch, blankReasoning);
    await internals.renderHistoricalPart(scratch, {
      id: "unsupported-historical-guard",
      type: "unsupported",
      timestamp: 2,
      data: null,
    } as unknown as MessagePart);
    expect(scratch.childElementCount).toBe(0);

    const imagePart: MessagePart = {
      id: "image-historical-guard",
      type: "content",
      timestamp: 3,
      data: [{
        type: "image_url",
        image_url: { url: "data:image/png;base64,AA==" },
      }],
    };
    await internals.renderHistoricalPart(scratch, imagePart);
    expect(scratch.querySelector(".systemsculpt-agent-message-attachment.is-image")).not.toBeNull();

    const defaulted = parent.createDiv();
    await expect(internals.renderHistoricalParts(defaulted, [])).resolves.toBe(false);
    const renderPart = jest.spyOn(internals, "renderHistoricalPart");
    await expect(internals.renderHistoricalTimeline(
      defaulted,
      [{ id: "content-stale-guard", type: "content", timestamp: 4, data: "ignored" }],
      () => false,
    )).resolves.toBe(false);
    expect(renderPart).not.toHaveBeenCalled();
    renderPart.mockRestore();

    const localReportId = `report_${"d".repeat(32)}`;
    const partialIncidentId = `incident_${"e".repeat(32)}`;
    await renderer.renderHistory([{
      role: "user",
      message_id: "user-partial-receipt-guard",
      content: "Private prompt canary",
    }, {
      role: "assistant",
      message_id: "assistant-partial-receipt-guard",
      content: "Private answer canary",
      terminalOutcome: "failed",
      terminalReportId: localReportId,
      terminalIncidentId: partialIncidentId,
      terminalFailureCode: "agent_turn_failed",
      terminalRetryable: true,
    }]);
    expect(parent.querySelector(".systemsculpt-agent-part.is-error")).toBeNull();
    renderer.unload();
  });

  it("keeps unsupported active parts and missing disclosure state harmless", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const internals = renderer as unknown as {
      renderActivePart(
        part: AgentPart,
        key: string,
        suppressToolError?: boolean,
        insertionParent?: HTMLElement,
      ): Promise<HTMLElement>;
      renderPart(node: HTMLElement, part: AgentPart): Promise<boolean>;
      renderReasoning(
        node: HTMLElement,
        summary: string,
        streaming: boolean,
        preservedOpen?: boolean,
      ): Promise<void>;
      updateReasoning(
        node: HTMLElement,
        part: Extract<AgentPart, { kind: "reasoning" }>,
      ): Promise<boolean>;
      updateIncidentDisclosureOpen(element: HTMLElement, open: boolean): void;
      setHistoricalHydrationStatus(state: { status: string }, status: string): void;
      enhanceCodeBlocks(parent: HTMLElement): void;
    };

    const orphan = await internals.renderActivePart({
      id: "text-orphan-guard",
      kind: "text",
      messageId: "assistant-orphan-guard",
      state: "complete",
      markdown: "Orphan rendering guard",
      order: 0,
    }, "text-orphan-guard");
    expect(orphan.isConnected).toBe(false);

    const unsupported = parent.createDiv();
    await expect(internals.renderPart(unsupported, {
      kind: "unsupported",
    } as unknown as AgentPart)).resolves.toBe(true);

    const streamingReasoning: Extract<AgentPart, { kind: "reasoning" }> = {
      id: "reasoning-open-guard",
      kind: "reasoning",
      messageId: "assistant-reasoning-open-guard",
      state: "streaming",
      summary: "Updated private reasoning canary",
      order: 1,
    };
    expect(await internals.updateReasoning(parent.createDiv(), streamingReasoning)).toBe(false);
    const reasoningNode = parent.createDiv();
    await internals.renderReasoning(
      reasoningNode,
      "Initial private reasoning canary",
      false,
      true,
    );
    expect(reasoningNode.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
    expect(await internals.updateReasoning(reasoningNode, streamingReasoning)).toBe(true);
    expect(reasoningNode.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-icon")
      ?.dataset.iconState).toBe("streaming");

    internals.updateIncidentDisclosureOpen(document.createElement("details"), true);
    const hydrationState = { status: "cold" };
    internals.setHistoricalHydrationStatus(hydrationState, "cold");
    expect(hydrationState.status).toBe("cold");

    const codeHost = parent.createDiv();
    codeHost.createEl("pre");
    const enhanced = codeHost.createEl("pre");
    enhanced.createEl("code", { text: "private-code-canary" });
    enhanced.createEl("button", { cls: "systemsculpt-agent-code-copy" });
    internals.enhanceCodeBlocks(codeHost);
    expect(codeHost.querySelectorAll(".systemsculpt-agent-code-copy")).toHaveLength(1);

    renderer.unload();
    const inactive: AgentConversationSnapshot = {
      runId: "run-disabled-render-guard",
      turnId: "turn-disabled-render-guard",
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    };
    await expect(renderer.renderActive(
      inactive,
      presentation("responding", true, "Working", inactive),
    )).resolves.toBeUndefined();
  });

  it("keeps one loader node across live lifecycle changes and removes it at terminal", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const parts = [{
      id: "reasoning-icon",
      kind: "reasoning" as const,
      messageId: "assistant-icon",
      state: "complete" as const,
      summary: "Checked the request",
      order: 0,
    }];
    const running: AgentConversationSnapshot = {
      runId: "run-icon",
      turnId: "user-icon",
      status: "running",
      phase: "thinking",
      statusLabel: "Thinking",
      messages: [{
        id: "assistant-icon",
        role: "assistant",
        partIds: ["reasoning-icon"],
      }],
      parts,
    };
    await renderer.renderActive(
      running,
      presentation("reasoning", true, "Thinking", running),
    );
    const status = parent.querySelector<HTMLElement>(".systemsculpt-agent-tail-status")!;
    const icon = status.querySelector<HTMLElement>(".systemsculpt-agent-tail-status-icon")!;
    expect(setIcon).toHaveBeenCalledWith(icon, "loader-circle");
    (setIcon as jest.Mock).mockClear();

    const responding: AgentConversationSnapshot = {
      ...running,
      phase: "working",
      parts: [{
        ...parts[0],
        summary: "Checked the request and the current note",
      }],
    };
    await renderer.renderActive(
      responding,
      presentation("responding", true, "Thinking", responding),
    );

    expect(parent.querySelector(".systemsculpt-agent-tail-status")).toBe(status);
    expect(parent.querySelector(".systemsculpt-agent-tail-status-icon")).toBe(icon);
    expect((setIcon as jest.Mock).mock.calls.filter(([element]) => element === icon))
      .toHaveLength(0);
    expect(icon.classList).toContain("is-animated");
    expect(status.parentElement?.lastElementChild).toBe(status);

    const terminal: AgentConversationSnapshot = {
      ...responding,
      status: "completed",
    };
    await renderer.renderActive(
      terminal,
      presentation("completed", false, "Done", terminal),
    );

    expect(parent.querySelector(".systemsculpt-agent-tail-status")).toBeNull();
    expect(status.isConnected).toBe(false);
    renderer.unload();
  });

  it("rebases delayed elapsed samples without replacing or rewinding Working text", async () => {
    jest.useFakeTimers();
    let now = 0;
    const performanceNow = jest.spyOn(window.performance, "now").mockImplementation(() => now);
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const snapshot = (elapsedMs: number): AgentConversationSnapshot => ({
      runId: "run-delayed-elapsed",
      turnId: "user-delayed-elapsed",
      status: "running",
      phase: "working",
      elapsedMs,
      messages: [],
      parts: [],
    });

    try {
      const first = snapshot(2_500);
      await renderer.renderActive(
        first,
        presentation("responding", true, "Working", first),
      );
      const label = parent.querySelector<HTMLElement>(
        ".systemsculpt-agent-tail-status-label",
      )!;
      const textNode = label.firstChild;
      expect(textNode?.nodeValue).toBe("Working for 2s");

      now = 1_000;
      jest.advanceTimersByTime(1_000);
      expect(label.firstChild).toBe(textNode);
      expect(textNode?.nodeValue).toBe("Working for 3s");

      const delayed = snapshot(1_000);
      await renderer.renderActive(
        delayed,
        presentation("responding", true, "Working", delayed),
      );
      expect(label.firstChild).toBe(textNode);
      expect(textNode?.nodeValue).toBe("Working for 3s");

      now = 2_000;
      jest.advanceTimersByTime(1_000);
      expect(label.firstChild).toBe(textNode);
      expect(textNode?.nodeValue).toBe("Working for 4s");
    } finally {
      renderer.unload();
      performanceNow.mockRestore();
    }
  });

  it("skips an interval write when the visible Working duration has not changed", async () => {
    jest.useFakeTimers();
    let now = 0;
    const performanceNow = jest.spyOn(window.performance, "now").mockImplementation(() => now);
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const running: AgentConversationSnapshot = {
      runId: "run-no-op-duration",
      turnId: "user-no-op-duration",
      status: "running",
      phase: "working",
      elapsedMs: 1_500,
      messages: [],
      parts: [],
    };

    try {
      await renderer.renderActive(
        running,
        presentation("responding", true, "Working", running),
      );
      const label = parent.querySelector<HTMLElement>(
        ".systemsculpt-agent-tail-status-label",
      )!;
      const textNode = label.firstChild;
      const setTextNode = jest.spyOn(
        renderer as unknown as {
          setTextNode(element: HTMLElement | null, text: string): void;
        },
        "setTextNode",
      );

      jest.advanceTimersByTime(1_000);
      expect(setTextNode).not.toHaveBeenCalled();
      expect(label.firstChild).toBe(textNode);
      expect(textNode?.nodeValue).toBe("Working for 1s");

      now = 1_000;
      jest.advanceTimersByTime(1_000);
      expect(setTextNode).toHaveBeenCalledTimes(1);
      expect(label.firstChild).toBe(textNode);
      expect(textNode?.nodeValue).toBe("Working for 2s");
    } finally {
      renderer.unload();
      performanceNow.mockRestore();
    }
  });

  it("uses live-region semantics only for static terminal tail statuses", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const running: AgentConversationSnapshot = {
      runId: "run-tail-semantics",
      turnId: "user-tail-semantics",
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    };

    await renderer.renderActive(
      running,
      presentation("responding", true, "Working", running),
    );
    const status = parent.querySelector<HTMLElement>(".systemsculpt-agent-tail-status")!;
    expect(status.hasAttribute("role")).toBe(false);
    expect(status.hasAttribute("aria-live")).toBe(false);
    expect(status.hasAttribute("aria-atomic")).toBe(false);

    const stopped: AgentConversationSnapshot = {
      ...running,
      status: "cancelled",
      phase: "complete",
    };
    await renderer.renderActive(
      stopped,
      presentation("cancelled", false, "Stopped", stopped),
    );
    expect(parent.querySelector(".systemsculpt-agent-tail-status")).toBe(status);
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");

    const failed: AgentConversationSnapshot = {
      ...running,
      status: "failed",
      phase: "complete",
    };
    await renderer.renderActive(
      failed,
      presentation("failed", false, "Failed", failed),
    );
    expect(parent.querySelector(".systemsculpt-agent-tail-status")).toBe(status);
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.getAttribute("aria-live")).toBe("assertive");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    renderer.unload();
  });

  it("drops an asynchronous history render after unload instead of writing stale DOM", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const render = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, markdown, staging) => {
        await renderGate;
        staging.setText(String(markdown));
      },
    );

    const pending = renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-stale-render",
      content: "This must never appear after unload.",
    }]);
    await Promise.resolve();
    renderer.unload();
    releaseRender();
    await pending;

    expect(parent.textContent).not.toContain("This must never appear after unload.");
    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-disabled-render",
      content: "Rendering stays disabled until load.",
    }]);
    expect(render).toHaveBeenCalledTimes(1);
    render.mockRestore();
  });

  it("hydrates only the opened restored Worked body and reuses it after reopening", async () => {
    const parent = document.body.createDiv();
    const finishLayoutMutation = jest.fn();
    const beginLayoutMutation = jest.fn(() => finishLayoutMutation);
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      beginLayoutMutation,
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const markdownRender = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, markdown, staging) => {
        staging.setText(String(markdown));
      },
    );
    const tool = (id: string, messageId: string, path: string, timestamp: number): ToolCall => ({
      id,
      messageId,
      request: {
        id,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ paths: [path] }) },
      },
      state: "completed",
      result: { success: true, data: { summary: `Read ${path}` } },
      timestamp,
    });
    const firstTool = tool("call-cold-one", "assistant-cold-one", "One.md", 2);
    const secondTool = tool("call-cold-two", "assistant-cold-one", "Two.md", 4);
    const thirdTool = tool("call-cold-three", "assistant-cold-two", "Three.md", 2);

    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-cold-one",
      content: "Final one",
      messageParts: [{
        id: "reasoning-cold-one",
        type: "reasoning",
        timestamp: 1,
        data: "Private plan one",
      }, {
        id: "tool-cold-one",
        type: "tool_call",
        timestamp: 2,
        data: firstTool,
      }, {
        id: "work-markdown-cold-one",
        type: "content",
        timestamp: 3,
        data: "Intermediate **one**",
      }, {
        id: "tool-cold-two",
        type: "tool_call",
        timestamp: 4,
        data: secondTool,
      }, {
        id: "answer-cold-one",
        type: "content",
        timestamp: 5,
        data: "Final one",
      }],
    }, {
      role: "user",
      message_id: "user-cold-boundary",
      content: "Next",
    }, {
      role: "assistant",
      message_id: "assistant-cold-two",
      content: "Final two",
      messageParts: [{
        id: "tool-cold-three",
        type: "tool_call",
        timestamp: 2,
        data: thirdTool,
      }, {
        id: "answer-cold-two",
        type: "content",
        timestamp: 3,
        data: "Final two",
      }],
    }]);

    const worked = Array.from(parent.querySelectorAll<HTMLDetailsElement>(
      ".systemsculpt-agent-history details[data-agent-turn-fold]",
    ));
    expect(worked).toHaveLength(2);
    expect(worked.every((details) => !details.open)).toBe(true);
    expect(worked.map((details) => details.querySelector(
      ":scope > .systemsculpt-agent-activity-body",
    )?.childElementCount)).toEqual([0, 0]);
    expect(parent.querySelectorAll(".systemsculpt-agent-history .systemsculpt-agent-part.is-tool"))
      .toHaveLength(0);
    expect(markdownRender.mock.calls.map(([, markdown]) => markdown)).toEqual([
      "Final one",
      "Next",
      "Final two",
    ]);

    const firstWorked = worked[0]!;
    const firstSummary = firstWorked.querySelector<HTMLElement>(":scope > summary")!;
    const firstBody = firstWorked.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-body",
    )!;
    const hydrationState = (renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalActivityHydrationStates.get(firstWorked)!;
    firstWorked.open = true;
    firstWorked.dispatchEvent(new Event("toggle"));
    await hydrationState.hydration;

    expect(beginLayoutMutation).toHaveBeenCalledWith(firstSummary, firstBody);
    expect(finishLayoutMutation).toHaveBeenCalledTimes(1);
    expect(firstBody.querySelectorAll(":scope > .systemsculpt-agent-part.is-tool"))
      .toHaveLength(1);
    const firstOverflow = firstBody.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )!;
    expect(firstOverflow.getAttribute("aria-expanded")).toBe("false");
    expect(firstOverflow.nextElementSibling?.classList)
      .toContain("systemsculpt-agent-activity-overflow-body");
    expect(firstOverflow.nextElementSibling?.hasAttribute("hidden")).toBe(true);
    expect(firstBody.querySelector('[data-part-key="reasoning-cold-one"]')).toBeNull();
    expect(Array.from(firstBody.querySelectorAll<HTMLElement>(
      ":scope > [data-agent-activity-row]",
    )).map((row) => row.dataset.partKey)).toEqual([
      "tool:call-cold-two",
    ]);
    expect(firstBody.querySelectorAll("details.systemsculpt-agent-tool[open]"))
      .toHaveLength(0);
    expect(firstBody.querySelectorAll("details.systemsculpt-agent-reasoning-details[open]"))
      .toHaveLength(0);
    expect(worked[1]!.querySelector(
      ":scope > .systemsculpt-agent-activity-body",
    )?.childElementCount).toBe(0);
    expect(markdownRender.mock.calls.map(([, markdown]) => markdown)).toContain(
      "Intermediate **one**",
    );

    const children = Array.from(firstBody.children);
    const callsAfterHydration = markdownRender.mock.calls.length;
    firstWorked.open = false;
    firstWorked.dispatchEvent(new Event("toggle"));
    firstWorked.open = true;
    firstWorked.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    expect(Array.from(firstBody.children)).toEqual(children);
    expect(markdownRender).toHaveBeenCalledTimes(callsAfterHydration);
    renderer.unload();
    markdownRender.mockRestore();
  });

  it("hydrates historical overflow once in chronology with closed nested drawers", async () => {
    const parent = document.body.createDiv();
    const finishLayoutMutation = jest.fn();
    const beginLayoutMutation = jest.fn(() => finishLayoutMutation);
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      beginLayoutMutation,
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const markdownRender = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, markdown, staging) => {
        staging.setText(String(markdown));
      },
    );
    const tool = (id: string, timestamp: number): ToolCall => ({
      id,
      messageId: "assistant-lazy-overflow",
      request: {
        id,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ paths: [`${id}.md`] }) },
      },
      state: "completed",
      result: { success: true, data: { summary: `Read ${id}.md` } },
      timestamp,
    });
    const firstTool = tool("call-lazy-one", 2);
    const latestTool = tool("call-lazy-two", 3);

    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-lazy-overflow",
      content: "Visible final answer",
      messageParts: [{
        id: "reasoning-lazy-overflow",
        type: "reasoning",
        timestamp: 1,
        data: "Older reasoning",
      }, {
        id: "tool-lazy-one",
        type: "tool_call",
        timestamp: 2,
        data: firstTool,
      }, {
        id: "tool-lazy-two",
        type: "tool_call",
        timestamp: 3,
        data: latestTool,
      }, {
        id: "answer-lazy-overflow",
        type: "content",
        timestamp: 4,
        data: "Visible final answer",
      }],
    }]);
    const worked = parent.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const workedHydration = (renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalActivityHydrationStates.get(worked)!;
    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await workedHydration.hydration;

    const body = worked.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-body",
    )!;
    const overflow = body.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )!;
    const overflowStates = (renderer as unknown as {
      historicalOverflowHydrationStates: Map<
        HTMLButtonElement,
        { hydration: Promise<void> | null; status: string }
      >;
    }).historicalOverflowHydrationStates;
    expect(body.querySelector('[data-part-key="reasoning-lazy-overflow"]')).toBeNull();
    expect(body.querySelector('[data-part-key="tool:call-lazy-one"]')).toBeNull();
    expect(body.querySelector('[data-part-key="tool:call-lazy-two"]')).not.toBeNull();
    expect(parent.querySelector('[data-part-key="answer-lazy-overflow"]')?.closest(
      "details[data-agent-turn-fold]",
    )).toBeNull();

    const internals = renderer as unknown as {
      historicalOverflowHydrationStates: Map<
        HTMLButtonElement,
        { hydration: Promise<void> | null; status: string }
      >;
      renderHistoricalPart(parent: HTMLElement, part: MessagePart): Promise<void>;
    };
    const originalRenderHistoricalPart = internals.renderHistoricalPart.bind(renderer);
    let releaseFirstAttempt!: () => void;
    let markFirstAttemptStarted!: () => void;
    const firstAttemptGate = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const firstAttemptStarted = new Promise<void>((resolve) => {
      markFirstAttemptStarted = resolve;
    });
    let failedOnce = false;
    const historicalPartRender = jest.spyOn(internals, "renderHistoricalPart").mockImplementation(
      async (staging, part) => {
        if (!failedOnce && part.id === "reasoning-lazy-overflow") {
          failedOnce = true;
          markFirstAttemptStarted();
          await firstAttemptGate;
          throw new Error("Transient historical render failure");
        }
        await originalRenderHistoricalPart(staging, part);
      },
    );

    overflow.click();
    await firstAttemptStarted;
    const firstHydration = overflowStates.get(overflow)?.hydration!;
    overflow.click();
    overflow.click();
    expect(overflowStates.get(overflow)?.hydration).toBe(firstHydration);
    releaseFirstAttempt();
    await expect(firstHydration).rejects.toThrow("Transient historical render failure");
    await Promise.resolve();
    expect(overflowStates.get(overflow)?.status).toBe("cold");
    expect(body.querySelector('[data-part-key="reasoning-lazy-overflow"]')).toBeNull();
    expect(body.querySelector('[data-part-key="tool:call-lazy-one"]')).toBeNull();

    overflow.click();
    overflow.click();
    const retryHydration = overflowStates.get(overflow)?.hydration!;
    expect(retryHydration).not.toBe(firstHydration);
    await retryHydration;
    await Promise.resolve();
    const drawer = overflow.nextElementSibling as HTMLElement;
    const rows = Array.from(drawer.querySelectorAll<HTMLElement>(
      ":scope > [data-agent-activity-row]",
    ));
    expect(rows.map((row) => row.dataset.partKey)).toEqual([
      "reasoning-lazy-overflow",
      "tool:call-lazy-one",
      "tool:call-lazy-two",
    ]);
    expect(drawer.querySelectorAll("details.systemsculpt-agent-reasoning-details[open]"))
      .toHaveLength(0);
    expect(drawer.querySelectorAll("details.systemsculpt-agent-tool[open]"))
      .toHaveLength(0);
    expect(beginLayoutMutation).toHaveBeenLastCalledWith(overflow, drawer);
    expect(finishLayoutMutation).toHaveBeenCalledTimes(6);
    expect(overflowStates.get(overflow)?.status).toBe("hydrated");
    const olderNodes = rows.slice(0, 2);
    const callsAfterFirstExpansion = markdownRender.mock.calls.length;

    overflow.click();
    expect(olderNodes.every((node) => !node.isConnected)).toBe(true);
    overflow.click();
    await Promise.resolve();
    expect(Array.from(drawer.querySelectorAll<HTMLElement>(
      ":scope > [data-agent-activity-row]",
    )).slice(0, 2)).toEqual(olderNodes);
    expect(markdownRender).toHaveBeenCalledTimes(callsAfterFirstExpansion);
    historicalPartRender.mockRestore();
    renderer.unload();
    markdownRender.mockRestore();
  });

  it("drops stale historical overflow hydration on unload", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const markdownRender = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, markdown, staging) => {
        staging.setText(String(markdown));
      },
    );
    const tool = (id: string, timestamp: number): ToolCall => ({
      id,
      messageId: "assistant-lazy-unload",
      request: {
        id,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ paths: [`${id}.md`] }) },
      },
      state: "completed",
      result: { success: true, data: { summary: `Read ${id}.md` } },
      timestamp,
    });
    const latestTool = tool("call-lazy-unload-two", 2);
    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-lazy-unload",
      content: "Final answer",
      messageParts: [{
        id: "reasoning-lazy-unload",
        type: "reasoning",
        timestamp: 1,
        data: "Older reasoning",
      }, {
        id: "tool-lazy-unload-two",
        type: "tool_call",
        timestamp: 2,
        data: latestTool,
      }, {
        id: "answer-lazy-unload",
        type: "content",
        timestamp: 3,
        data: "Final answer",
      }],
    }]);
    const worked = parent.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const workedHydration = (renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalActivityHydrationStates.get(worked)!;
    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await workedHydration.hydration;
    const overflow = worked.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )!;
    const overflowStates = (renderer as unknown as {
      historicalOverflowHydrationStates: Map<
        HTMLButtonElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalOverflowHydrationStates;
    overflow.click();
    const hydration = overflowStates.get(overflow)?.hydration!;

    renderer.unload();
    await hydration;

    expect(worked.querySelector('[data-part-key="reasoning-lazy-unload"]')).toBeNull();
    expect((renderer as unknown as {
      liveMarkdown: { states: Map<HTMLElement, unknown> };
    }).liveMarkdown.states.size).toBe(0);
    expect(overflowStates.size).toBe(0);
    markdownRender.mockRestore();
  });

  it("rejects an older overflow hydration when history is corrected", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const tool = (id: string, timestamp: number): ToolCall => ({
      id,
      messageId: "assistant-lazy-stale",
      request: {
        id,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ paths: [`${id}.md`] }) },
      },
      state: "completed",
      result: { success: true, data: { summary: `Read ${id}.md` } },
      timestamp,
    });
    const firstTool = tool("call-lazy-stale-one", 2);
    const latestTool = tool("call-lazy-stale-two", 3);
    const initial: ChatMessage[] = [{
      role: "assistant",
      message_id: "assistant-lazy-stale",
      content: "Initial final answer",
      messageParts: [{
        id: "reasoning-lazy-stale",
        type: "reasoning",
        timestamp: 1,
        data: "Older reasoning",
      }, {
        id: "tool-lazy-stale-one",
        type: "tool_call",
        timestamp: 2,
        data: firstTool,
      }, {
        id: "tool-lazy-stale-two",
        type: "tool_call",
        timestamp: 3,
        data: latestTool,
      }, {
        id: "answer-lazy-stale",
        type: "content",
        timestamp: 4,
        data: "Initial final answer",
      }],
    }];
    await renderer.renderHistory(initial);
    const worked = parent.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const internals = renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
      historicalOverflowHydrationStates: Map<
        HTMLButtonElement,
        { hydration: Promise<void> | null; status: string }
      >;
      renderHistoricalPart(parent: HTMLElement, part: MessagePart): Promise<void>;
    };
    const workedHydration = internals.historicalActivityHydrationStates.get(worked)!;
    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await workedHydration.hydration;
    const overflow = worked.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )!;
    const originalRenderHistoricalPart = internals.renderHistoricalPart.bind(renderer);
    let releaseFirstPart!: () => void;
    let markFirstPartStarted!: () => void;
    const firstPartGate = new Promise<void>((resolve) => {
      releaseFirstPart = resolve;
    });
    const firstPartStarted = new Promise<void>((resolve) => {
      markFirstPartStarted = resolve;
    });
    let blockFirstPart = true;
    const historicalPartRender = jest.spyOn(internals, "renderHistoricalPart").mockImplementation(
      async (staging, part) => {
        if (blockFirstPart && part.id === "reasoning-lazy-stale") {
          blockFirstPart = false;
          markFirstPartStarted();
          await firstPartGate;
        }
        await originalRenderHistoricalPart(staging, part);
      },
    );

    overflow.click();
    await firstPartStarted;
    const staleHydration = internals.historicalOverflowHydrationStates.get(overflow)?.hydration!;
    overflow.click();
    const corrected = [{
      ...initial[0]!,
      content: "Corrected final answer",
      messageParts: initial[0]!.messageParts!.map((part) =>
        part.id === "answer-lazy-stale"
          ? { ...part, data: "Corrected final answer" }
          : { ...part }),
    }];
    await renderer.renderHistory(corrected);
    releaseFirstPart();
    await staleHydration;

    const currentWorked = parent.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    )!;
    const currentOverflow = currentWorked.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )!;
    expect(currentWorked).not.toBe(worked);
    expect(currentOverflow.getAttribute("aria-expanded")).toBe("false");
    expect(currentWorked.querySelector('[data-part-key="reasoning-lazy-stale"]')).toBeNull();
    expect(currentWorked.querySelector('[data-part-key="tool:call-lazy-stale-one"]')).toBeNull();
    expect(parent.textContent).toContain("Corrected final answer");
    expect(parent.textContent).not.toContain("Initial final answer");
    expect(internals.historicalOverflowHydrationStates.has(overflow)).toBe(false);
    expect(internals.historicalOverflowHydrationStates.get(currentOverflow)?.status).toBe("cold");
    historicalPartRender.mockRestore();
    renderer.unload();
  });

  it("finishes pending overflow hydration across an unchanged history refresh", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const tool = (id: string, timestamp: number): ToolCall => ({
      id,
      messageId: "assistant-lazy-refresh",
      request: {
        id,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ paths: [`${id}.md`] }) },
      },
      state: "completed",
      result: { success: true, data: { summary: `Read ${id}.md` } },
      timestamp,
    });
    const history: ChatMessage[] = [{
      role: "assistant",
      message_id: "assistant-lazy-refresh",
      content: "Final answer",
      messageParts: [{
        id: "reasoning-lazy-refresh",
        type: "reasoning",
        timestamp: 1,
        data: "Older reasoning",
      }, {
        id: "tool-lazy-refresh-one",
        type: "tool_call",
        timestamp: 2,
        data: tool("call-lazy-refresh-one", 2),
      }, {
        id: "tool-lazy-refresh-two",
        type: "tool_call",
        timestamp: 3,
        data: tool("call-lazy-refresh-two", 3),
      }, {
        id: "answer-lazy-refresh",
        type: "content",
        timestamp: 4,
        data: "Final answer",
      }],
    }];
    await renderer.renderHistory(history);
    const worked = parent.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const internals = renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
      historicalOverflowHydrationStates: Map<
        HTMLButtonElement,
        { hydration: Promise<void> | null; status: string }
      >;
      renderHistoricalPart(parent: HTMLElement, part: MessagePart): Promise<void>;
    };
    const workedHydration = internals.historicalActivityHydrationStates.get(worked)!;
    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await workedHydration.hydration;
    const overflow = worked.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )!;
    const originalRenderHistoricalPart = internals.renderHistoricalPart.bind(renderer);
    let releaseFirstPart!: () => void;
    let markFirstPartStarted!: () => void;
    const firstPartGate = new Promise<void>((resolve) => {
      releaseFirstPart = resolve;
    });
    const firstPartStarted = new Promise<void>((resolve) => {
      markFirstPartStarted = resolve;
    });
    const historicalPartRender = jest.spyOn(internals, "renderHistoricalPart").mockImplementation(
      async (staging, part) => {
        if (part.id === "reasoning-lazy-refresh") {
          markFirstPartStarted();
          await firstPartGate;
        }
        await originalRenderHistoricalPart(staging, part);
      },
    );

    overflow.click();
    await firstPartStarted;
    const hydration = internals.historicalOverflowHydrationStates.get(overflow)?.hydration!;
    await renderer.renderHistory(history);
    expect(parent.querySelector("button[data-agent-activity-overflow]")).toBe(overflow);
    releaseFirstPart();
    await hydration;

    expect(internals.historicalOverflowHydrationStates.get(overflow)?.status).toBe("hydrated");
    expect(Array.from(worked.querySelectorAll<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-body > .systemsculpt-agent-activity-overflow-body > [data-agent-activity-row]",
    )).map((row) => row.dataset.partKey)).toEqual([
      "reasoning-lazy-refresh",
      "tool:call-lazy-refresh-one",
      "tool:call-lazy-refresh-two",
    ]);
    historicalPartRender.mockRestore();
    renderer.unload();
  });

  it("preserves open restored activity and exact keyed nodes across a late correction", async () => {
    const parent = document.body.createDiv();
    const finishLayoutMutation = jest.fn();
    const beginLayoutMutation = jest.fn(() => finishLayoutMutation);
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      beginLayoutMutation,
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const markdownRender = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, markdown, staging) => {
        staging.setText(String(markdown));
      },
    );
    const tool = (id: string, path: string, timestamp: number): ToolCall => ({
      id,
      messageId: "assistant-late-correction",
      request: {
        id,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ paths: [path] }) },
      },
      state: "completed",
      result: { success: true, data: { summary: `Read ${path}` } },
      timestamp,
    });
    const firstTool = tool("call-late-one", "One.md", 2);
    const secondTool = tool("call-late-two", "Two.md", 3);
    const initial: ChatMessage[] = [{
      role: "assistant",
      message_id: "assistant-late-correction",
      content: "Initial answer",
      messageParts: [{
        id: "reasoning-late-correction",
        type: "reasoning",
        timestamp: 1,
        data: "Stable reasoning detail",
      }, {
        id: "tool-late-one",
        type: "tool_call",
        timestamp: 2,
        data: firstTool,
      }, {
        id: "tool-late-two",
        type: "tool_call",
        timestamp: 3,
        data: secondTool,
      }, {
        id: "answer-late-correction",
        type: "content",
        timestamp: 4,
        data: "Initial answer",
      }],
    }];

    await renderer.renderHistory(initial);
    const worked = parent.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    )!;
    const hydrationState = (renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalActivityHydrationStates.get(worked)!;
    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await hydrationState.hydration;
    const overflow = parent.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow-key]",
    )!;
    overflow.click();
    await (renderer as unknown as {
      historicalOverflowHydrationStates: Map<
        HTMLButtonElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalOverflowHydrationStates.get(overflow)?.hydration;
    const reasoningPart = parent.querySelector<HTMLElement>(
      '[data-part-key="reasoning-late-correction"]',
    )!;
    const reasoning = reasoningPart.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-reasoning-details",
    )!;
    reasoning.open = true;
    reasoning.dispatchEvent(new Event("toggle"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const toolPart = parent.querySelector<HTMLElement>(
      '[data-part-key="tool:call-late-one"]',
    )!;
    const toolDetails = toolPart.querySelector<HTMLDetailsElement>(
      "details.systemsculpt-agent-tool",
    )!;
    const toolSummary = toolDetails.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-header",
    )!;
    toolDetails.open = true;
    toolSummary.focus();
    const reasoningText = reasoning.querySelector<HTMLElement>(
      ".systemsculpt-agent-reasoning-body",
    )!.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(reasoningText);
    selection.removeAllRanges();
    selection.addRange(range);

    beginLayoutMutation.mockClear();
    finishLayoutMutation.mockClear();
    await renderer.renderHistory([{
      ...initial[0]!,
      content: "Corrected answer",
      messageParts: initial[0]!.messageParts!.map((part) =>
        part.id === "answer-late-correction"
          ? { ...part, data: "Corrected answer" }
          : { ...part }),
    }]);

    const correctedWorked = parent.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    )!;
    const correctedWorkedBody = correctedWorked.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-body",
    )!;
    const correctedOverflow = parent.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow-key]",
    )!;
    expect(beginLayoutMutation).toHaveBeenCalledTimes(1);
    expect(beginLayoutMutation).toHaveBeenCalledWith(undefined, correctedWorkedBody);
    expect(finishLayoutMutation).toHaveBeenCalledTimes(1);
    expect(correctedWorked).not.toBe(worked);
    expect(correctedWorked.open).toBe(true);
    expect(correctedOverflow).not.toBe(overflow);
    expect(correctedOverflow.dataset.agentActivityOverflowKey)
      .toBe("overflow:reasoning-late-correction");
    expect(correctedOverflow.getAttribute("aria-expanded")).toBe("true");
    expect(parent.querySelector('[data-part-key="reasoning-late-correction"]'))
      .toBe(reasoningPart);
    expect(reasoning.open).toBe(true);
    expect(parent.querySelector('[data-part-key="tool:call-late-one"]')).toBe(toolPart);
    expect(toolDetails.open).toBe(true);
    expect(document.activeElement).toBe(toolSummary);
    expect(selection.toString()).toBe("Stable reasoning detail");
    expect(parent.textContent).toContain("Corrected answer");
    expect(parent.textContent).not.toContain("Initial answer");

    selection.removeAllRanges();
    correctedOverflow.focus();
    await renderer.renderHistory([{
      ...initial[0]!,
      content: "Second corrected answer",
      messageParts: initial[0]!.messageParts!.map((part) =>
        part.id === "answer-late-correction"
          ? { ...part, data: "Second corrected answer" }
          : { ...part }),
    }]);
    const focusedOverflow = parent.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow-key]",
    )!;
    expect(focusedOverflow).not.toBe(correctedOverflow);
    expect(focusedOverflow.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(focusedOverflow);

    const focusedWorked = parent.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    )!;
    focusedWorked.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-header",
    )!.focus();
    await renderer.renderHistory([{
      ...initial[0]!,
      content: "Third corrected answer",
      messageParts: initial[0]!.messageParts!.map((part) =>
        part.id === "answer-late-correction"
          ? { ...part, data: "Third corrected answer" }
          : { ...part }),
    }]);
    const replacementWorked = parent.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    )!;
    const replacementWorkedHeader = replacementWorked.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-header",
    )!;
    expect(replacementWorked).not.toBe(focusedWorked);
    expect(document.activeElement).toBe(replacementWorkedHeader);

    const currentToolPart = parent.querySelector<HTMLElement>(
      '[data-part-key="tool:call-late-one"]',
    )!;
    const currentToolHeader = currentToolPart.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-header",
    )!;
    currentToolHeader.focus();
    await renderer.renderHistory([{
      ...initial[0]!,
      content: "Activity corrected answer",
      messageParts: initial[0]!.messageParts!.map((part) => {
        if (part.id === "reasoning-late-correction") {
          return { ...part, data: "Corrected reasoning detail" };
        }
        if (part.type === "tool_call" && part.data.id === "call-late-one") {
          return {
            ...part,
            data: {
              ...part.data,
              result: {
                success: true,
                data: { summary: "Read One.md after correction" },
              },
            },
          };
        }
        if (part.id === "answer-late-correction") {
          return { ...part, data: "Activity corrected answer" };
        }
        return { ...part };
      }),
    }]);
    const changedToolPart = parent.querySelector<HTMLElement>(
      '[data-part-key="tool:call-late-one"]',
    )!;
    const changedToolHeader = changedToolPart.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-header",
    )!;
    const changedReasoning = parent.querySelector<HTMLDetailsElement>(
      '[data-part-key="reasoning-late-correction"] .systemsculpt-agent-reasoning-details',
    )!;
    expect(changedToolPart).not.toBe(currentToolPart);
    expect(changedToolPart.querySelector("details.systemsculpt-agent-tool")?.hasAttribute("open"))
      .toBe(true);
    expect(changedReasoning.open).toBe(true);
    expect(changedReasoning.textContent).toContain("Corrected reasoning detail");
    expect(document.activeElement).toBe(changedToolHeader);

    await renderer.renderHistory([{
      ...initial[0]!,
      content: "Removed reasoning answer",
      messageParts: initial[0]!.messageParts!
        .filter((part) => part.id !== "reasoning-late-correction")
        .map((part) => part.id === "answer-late-correction"
          ? { ...part, data: "Removed reasoning answer" }
          : { ...part }),
    }]);
    expect(parent.querySelector('[data-part-key="reasoning-late-correction"]')).toBeNull();
    expect(parent.textContent).toContain("Removed reasoning answer");

    const cold = [{
      ...initial[0]!,
      message_id: "assistant-cold-correction",
      content: "Cold initial",
      messageParts: initial[0]!.messageParts!.map((part, index) => ({
        ...part,
        id: `${part.id}-cold`,
        timestamp: index + 1,
        ...(part.type === "tool_call" ? {
          data: {
            ...part.data,
            id: `${part.data.id}-cold`,
            messageId: "assistant-cold-correction",
            request: { ...part.data.request, id: `${part.data.id}-cold` },
          },
        } : {}),
      })),
    }] satisfies ChatMessage[];
    await renderer.renderHistory(cold);
    const coldWorked = parent.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    )!;
    expect(coldWorked.open).toBe(false);
    expect(coldWorked.querySelector(
      ":scope > .systemsculpt-agent-activity-body",
    )?.childElementCount).toBe(0);
    await renderer.renderHistory([{
      ...cold[0],
      content: "Cold corrected",
      messageParts: cold[0].messageParts!.map((part) =>
        part.type === "content" && part.id.startsWith("answer-late-correction")
          ? { ...part, data: "Cold corrected" }
          : { ...part }),
    }]);
    const correctedColdWorked = parent.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    )!;
    expect(correctedColdWorked).not.toBe(coldWorked);
    expect(correctedColdWorked.open).toBe(false);
    expect(correctedColdWorked.querySelector(
      ":scope > .systemsculpt-agent-activity-body",
    )?.childElementCount).toBe(0);
    renderer.unload();
    markdownRender.mockRestore();
  });

  it("safely handles missing keyed nodes while transferring late history state", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    type RowState = Readonly<{
      fingerprint: string;
      node: HTMLElement;
      partFingerprints: ReadonlyMap<string, string>;
    }>;
    type Replacement = Readonly<{
      previous: RowState;
      next: RowState;
      disclosure: Readonly<{
        workedOpen: boolean;
        hydrateWorked: boolean;
        overflowOpen: ReadonlyMap<string, boolean>;
        reasoningOpen: ReadonlyMap<string, boolean>;
        toolOpen: ReadonlyMap<string, boolean>;
      }>;
    }>;
    const internals = renderer as unknown as {
      activityOverflowStates: WeakMap<
        HTMLButtonElement,
        { body: HTMLElement; icon: HTMLElement; label: HTMLElement; latestNode: HTMLElement | null; previousNodes: HTMLElement[] }
      >;
      captureHistoricalDisclosureState(row: HTMLElement): unknown;
      prepareHistoricalRowReplacement(replacement: Replacement): Promise<void>;
      commitHistoricalRowReplacement(replacement: Replacement): void;
      moveExactHistoricalPart(
        previousRow: HTMLElement,
        nextRow: HTMLElement,
        previousPart: HTMLElement,
        nextPart: HTMLElement,
      ): void;
      resolveHistoricalFocus(row: HTMLElement, locator: unknown): HTMLElement | null;
    };

    const previousRow = document.createElement("div");
    const worked = previousRow.createEl("details", { attr: { "data-agent-turn-fold": "" } });
    worked.createEl("summary", { attr: { "data-focus-key": "activity-summary" } });
    const workedBody = worked.createDiv({ cls: "systemsculpt-agent-activity-body" });
    workedBody.createDiv({ text: "Already hydrated" });
    workedBody.createEl("button", { attr: { "data-agent-activity-overflow": "" } });
    const mappedOverflow = workedBody.createEl("button", {
      attr: { "data-agent-activity-overflow": "" },
    });
    internals.activityOverflowStates.set(mappedOverflow, {
      body: workedBody.createDiv(),
      icon: mappedOverflow.createSpan(),
      label: mappedOverflow.createSpan(),
      latestNode: null,
      previousNodes: [],
    });
    const previousPart = workedBody.createDiv({ attr: { "data-part-key": "stable-part" } });

    const disclosure = internals.captureHistoricalDisclosureState(previousRow) as {
      hydrateWorked: boolean;
    };
    expect(disclosure.hydrateWorked).toBe(true);

    const nextRow = document.createElement("div");
    nextRow.createEl("button", { attr: { "data-agent-activity-overflow": "" } });
    const detachedNextPart = document.createElement("div");
    detachedNextPart.dataset.partKey = "stable-part";
    const replacement: Replacement = {
      previous: {
        fingerprint: "before",
        node: previousRow,
        partFingerprints: new Map([["stable-part", "same"]]),
      },
      next: {
        fingerprint: "after",
        node: nextRow,
        partFingerprints: new Map([["stable-part", "same"]]),
      },
      disclosure: {
        workedOpen: false,
        hydrateWorked: false,
        overflowOpen: new Map(),
        reasoningOpen: new Map([["closed-reasoning", false], ["missing-reasoning", true]]),
        toolOpen: new Map([["missing-tool", true]]),
      },
    };
    await internals.prepareHistoricalRowReplacement(replacement);
    internals.commitHistoricalRowReplacement(replacement);
    internals.moveExactHistoricalPart(
      previousRow,
      nextRow,
      previousPart,
      detachedNextPart,
    );
    expect(previousPart.isConnected).toBe(false);

    const focusRow = document.createElement("div");
    const focusPart = focusRow.createDiv({ attr: { "data-part-key": "focus-part" } });
    focusPart.createEl("button", { attr: { "data-focus-key": "known-control" } });
    expect(internals.resolveHistoricalFocus(focusRow, {
      kind: "part",
      key: "missing-part",
      focusKey: null,
    })).toBeNull();
    expect(internals.resolveHistoricalFocus(focusRow, {
      kind: "part",
      key: "focus-part",
      focusKey: null,
    })).toBe(focusPart);
    expect(internals.resolveHistoricalFocus(focusRow, {
      kind: "part",
      key: "focus-part",
      focusKey: "missing-control",
    })).toBe(focusPart);
    renderer.unload();
  });

  it("keeps empty renderer guard paths inert", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const internals = renderer as unknown as {
      activityOverflowStates: WeakMap<
        HTMLButtonElement,
        { body: HTMLElement; icon: HTMLElement; label: HTMLElement; latestNode: HTMLElement | null; previousNodes: HTMLElement[] }
      >;
      applyActivityOverflowLayout(element: HTMLButtonElement): void;
      captureHistoricalDisclosureState(row: HTMLElement): {
        workedOpen: boolean;
        overflowOpen: ReadonlyMap<string, boolean>;
      };
      disposeHistoricalOverflowHydration(element: HTMLButtonElement): void;
      setTextNode(element: HTMLElement | null, text: string): void;
      updateActivityOverflow(element: HTMLButtonElement, hiddenCount: number): void;
    };

    renderer.focusInlineMessageEdit();
    renderer.showCompletedRenderFallback();
    renderer.showCompletedRenderFallback();
    internals.setTextNode(null, "ignored");
    expect(internals.captureHistoricalDisclosureState(document.createElement("div")).workedOpen)
      .toBe(false);
    internals.disposeHistoricalOverflowHydration(document.createElement("button"));

    const untrackedOverflow = document.createElement("button");
    internals.updateActivityOverflow(untrackedOverflow, 2);
    expect(untrackedOverflow.dataset.hiddenCount).toBe("2");

    const disclosureRow = document.createElement("div");
    disclosureRow.createEl("button", {
      attr: { "data-agent-activity-overflow-key": "" },
    });
    expect(internals.captureHistoricalDisclosureState(disclosureRow).overflowOpen.size).toBe(0);

    const overflow = document.createElement("button");
    internals.activityOverflowStates.set(overflow, {
      body: document.createElement("div"),
      icon: document.createElement("span"),
      label: document.createElement("span"),
      latestNode: null,
      previousNodes: [],
    });
    internals.applyActivityOverflowLayout(overflow);

    renderer.setInlineMessageEdit({
      messageId: "missing-edit-message",
      text: "Missing",
      laterMessageCount: 0,
      hasAttachments: false,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: false,
    });
    await renderer.renderHistory([{
      role: "system",
      message_id: "system-not-rendered",
      content: "Internal context",
    }]);
    expect(parent.textContent).not.toContain("Internal context");
    const unanchored: AgentConversationSnapshot = {
      runId: "run-unanchored-guard",
      turnId: null,
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    };
    await renderer.renderActive(
      unanchored,
      presentation("responding", true, "Working", unanchored),
    );
    expect(parent.querySelector(".systemsculpt-agent-turn.is-active")?.hasAttribute("data-turn-id"))
      .toBe(false);
    renderer.unload();
  });

  it("drops a pending restored Worked hydration after unload", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    let releaseHiddenRender!: () => void;
    let markHiddenRenderStarted!: () => void;
    const hiddenRenderGate = new Promise<void>((resolve) => {
      releaseHiddenRender = resolve;
    });
    const hiddenRenderStarted = new Promise<void>((resolve) => {
      markHiddenRenderStarted = resolve;
    });
    const markdownRender = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, markdown, staging) => {
        if (markdown === "Hidden work") {
          markHiddenRenderStarted();
          await hiddenRenderGate;
        }
        staging.setText(String(markdown));
      },
    );
    const tool: ToolCall = {
      id: "call-cold-unload",
      messageId: "assistant-cold-unload",
      request: {
        id: "call-cold-unload",
        type: "function",
        function: { name: "read", arguments: '{"paths":["Hidden.md"]}' },
      },
      state: "completed",
      result: { success: true, data: { summary: "Read Hidden.md" } },
      timestamp: 3,
    };
    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-cold-unload",
      content: "Final answer",
      messageParts: [{
        id: "reasoning-cold-unload",
        type: "reasoning",
        timestamp: 1,
        data: "Private plan",
      }, {
        id: "work-cold-unload",
        type: "content",
        timestamp: 2,
        data: "Hidden work",
      }, {
        id: "tool-cold-unload",
        type: "tool_call",
        timestamp: 3,
        data: tool,
      }, {
        id: "answer-cold-unload",
        type: "content",
        timestamp: 4,
        data: "Final answer",
      }],
    }]);
    const worked = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-history details[data-agent-turn-fold]",
    )!;
    const body = worked.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-body",
    )!;
    const hydrationState = (renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalActivityHydrationStates.get(worked)!;
    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await hiddenRenderStarted;
    const hydration = hydrationState.hydration!;
    expect(renderer.captureIncidentSnapshot().pendingHydrationCount).toBe(1);
    expect((renderer as unknown as {
      hydrateHistoricalActivity(state: object): Promise<void>;
    }).hydrateHistoricalActivity(hydrationState)).toBe(hydration);

    renderer.unload();
    expect(renderer.captureIncidentSnapshot().pendingHydrationCount).toBe(0);
    releaseHiddenRender();
    await hydration;

    expect(body.childElementCount).toBe(0);
    expect(body.textContent).not.toContain("Hidden work");
    expect((renderer as unknown as {
      liveMarkdown: { states: Map<HTMLElement, unknown> };
    }).liveMarkdown.states.size).toBe(0);
    expect((renderer as unknown as {
      historicalActivityHydrationStates: Map<HTMLDetailsElement, unknown>;
    }).historicalActivityHydrationStates.size).toBe(0);
    markdownRender.mockRestore();
  });

  it("keeps a restored Worked body cold after hydration fails and retries cleanly", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    let failHiddenWork = true;
    const markdownRender = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, markdown, staging) => {
        if (markdown === "Hidden work" && failHiddenWork) {
          failHiddenWork = false;
          throw new Error("hidden render failed");
        }
        staging.setText(String(markdown));
      },
    );
    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-hydration-retry",
      content: "Visible answer",
      messageParts: [{
        id: "reasoning-hydration-retry",
        type: "reasoning",
        timestamp: 1,
        data: "Private plan",
      }, {
        id: "work-hydration-retry",
        type: "content",
        timestamp: 2,
        data: "Hidden work",
      }, {
        id: "tool-hydration-retry",
        type: "tool_call",
        timestamp: 3,
        data: {
          id: "call-hydration-retry",
          messageId: "assistant-hydration-retry",
          request: {
            id: "call-hydration-retry",
            type: "function",
            function: { name: "read", arguments: '{"paths":["Plan.md"]}' },
          },
          state: "completed",
          result: { success: true, data: { summary: "Read Plan.md" } },
          timestamp: 3,
        },
      }, {
        id: "answer-hydration-retry",
        type: "content",
        timestamp: 4,
        data: "Visible answer",
      }],
    }]);
    const worked = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-history details[data-agent-turn-fold]",
    )!;
    const body = worked.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-body",
    )!;
    const state = (renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { status: string; hydration: Promise<void> | null; staging: HTMLElement | null }
      >;
    }).historicalActivityHydrationStates.get(worked)!;

    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await expect(state.hydration).rejects.toThrow("hidden render failed");
    expect(state.status).toBe("cold");
    expect(state.staging).toBeNull();
    expect(body.childElementCount).toBe(0);

    worked.dispatchEvent(new Event("toggle"));
    await state.hydration;
    expect(state.status).toBe("hydrated");
    expect(body.textContent).toContain("Hidden work");
    renderer.unload();
    markdownRender.mockRestore();
  });

  it("renders a static Stopped tail for a restored cancelled turn", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    await renderer.renderHistory([
      {
        role: "user",
        message_id: "user-cancel-restored",
        content: "Stream a long response",
      },
      {
        role: "assistant",
        message_id: "assistant-cancel-restored",
        content: "PARTIAL-STREAM-START",
        terminalOutcome: "cancelled",
      },
      { role: "user", message_id: "user-cancel-follow-up", content: "Continue" },
      { role: "assistant", message_id: "assistant-cancel-complete", content: "Done." },
      { role: "user", message_id: "user-cancel-work-timed", content: "Stop this too" },
      {
        role: "assistant",
        message_id: "assistant-cancel-work-timed",
        content: "Partial timed answer",
        responseDurationMs: 45_000,
        terminalOutcome: "cancelled",
        messageParts: [{
          id: "reasoning-cancel-work-timed",
          type: "reasoning",
          timestamp: 1,
          data: "Timed cancelled work",
        }, {
          id: "answer-cancel-work-timed",
          type: "content",
          timestamp: 2,
          data: "Partial timed answer",
        }],
      },
      { role: "user", message_id: "user-cancel-work-untimed", content: "And this" },
      {
        role: "assistant",
        message_id: "assistant-cancel-work-untimed",
        content: "Partial untimed answer",
        terminalOutcome: "cancelled",
        messageParts: [{
          id: "reasoning-cancel-work-untimed",
          type: "reasoning",
          timestamp: 1,
          data: "Untimed cancelled work",
        }, {
          id: "answer-cancel-work-untimed",
          type: "content",
          timestamp: 2,
          data: "Partial untimed answer",
        }],
      },
    ]);

    const tails = parent.querySelectorAll(".systemsculpt-agent-tail-status.is-cancelled");
    expect(tails).toHaveLength(1);
    const tail = tails[0]!;
    expect(tail.textContent).toBe("Stopped");
    expect(tail.getAttribute("role")).toBe("status");
    expect(tail.getAttribute("aria-live")).toBe("polite");
    expect(tail.getAttribute("aria-atomic")).toBe("true");
    expect(tail.closest(".systemsculpt-agent-turn")?.getAttribute("data-message-id"))
      .toBe("assistant-cancel-restored");
    expect(setIcon).toHaveBeenCalledWith(expect.anything(), "circle-stop");
    expect(Array.from(parent.querySelectorAll<HTMLElement>(
      ".systemsculpt-agent-activity-label",
    )).map((label) => label.textContent)).toEqual([
      "You stopped after 45s",
      "You stopped this response",
    ]);
    renderer.unload();
  });

  it("restores one failed receipt card with retry and report copy actions", async () => {
    const parent = document.body.createDiv();
    const copyIncidentReport = jest.fn()
      .mockRejectedValueOnce(new Error("clipboard unavailable"))
      .mockResolvedValue(true);
    const retryFailedTurn = jest.fn();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onCopyIncidentReport: copyIncidentReport,
      onRetryFailedTurn: retryFailedTurn,
    });
    renderer.load();
    const incidentId = `incident_${"a".repeat(32)}`;
    const runId = `run_${"b".repeat(32)}`;
    const history: readonly ChatMessage[] = [{
      role: "user",
      message_id: "user-failed-restored",
      content: "Inspect the vault.",
    }, {
      role: "assistant",
      message_id: "assistant-failed-restored",
      content: "Partial response",
      terminalOutcome: "failed",
      terminalIncidentId: incidentId,
      terminalFailureCode: "agent_turn_failed",
      terminalRetryable: true,
      terminalServerRunId: runId,
    }];

    await renderer.renderHistory(history);

    const cards = parent.querySelectorAll(".systemsculpt-agent-part.is-error");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain(`Report ID: ${incidentId}`);
    const retry = parent.querySelector<HTMLButtonElement>(
      '[data-testid="chat.turn.retry-failed"]',
    )!;
    const copy = parent.querySelector<HTMLButtonElement>(
      '[data-testid="chat.turn.copy-incident-report"]',
    )!;
    retry.click();
    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(retryFailedTurn).toHaveBeenCalledWith("user-failed-restored");
    expect(copyIncidentReport).toHaveBeenCalledWith(incidentId);
    expect(copy.textContent).toContain("Try again");
    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copyIncidentReport).toHaveBeenCalledTimes(2);
    expect(copy.textContent).toContain("Copied");

    const activeFailure: AgentConversationSnapshot = {
      runId,
      turnId: "user-failed-restored",
      status: "failed",
      phase: "complete",
      messages: [{
        id: "assistant-failed-restored",
        role: "assistant",
        partIds: ["error:user-failed-restored"],
      }],
      parts: [{
        id: "error:user-failed-restored",
        order: 1,
        kind: "error",
        retryable: true,
        retryMessageId: "user-failed-restored",
        error: {
          code: "agent_turn_failed",
          message: "SystemSculpt could not complete the response.",
          retryable: true,
          incidentId,
        },
      }],
    };
    await renderer.renderActive(
      activeFailure,
      presentation("failed", false, "", activeFailure),
    );
    expect(parent.querySelectorAll(".systemsculpt-agent-part.is-error")).toHaveLength(1);
    expect(parent.querySelector(".systemsculpt-agent-active-run")?.childElementCount).toBe(0);
    renderer.unload();
  });

  it("shows a compact preparing state and blocks duplicate local-report copies", async () => {
    const parent = document.body.createDiv();
    let resolveCopy!: (value: "memory_fallback") => void;
    const pendingCopy = new Promise<"memory_fallback">((resolve) => {
      resolveCopy = resolve;
    });
    const copyIncidentReport = jest.fn(() => pendingCopy);
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onCopyIncidentReport: copyIncidentReport,
    });
    renderer.load();
    const reportId = `report_${"c".repeat(32)}`;
    await renderer.renderHistory([{
      role: "user",
      message_id: "user-local-report",
      content: "Submitted prompt",
    }, {
      role: "assistant",
      message_id: `failure-${reportId}`,
      content: "",
      terminalOutcome: "failed",
      terminalReportId: reportId,
      terminalFailureCode: "response_start_failed",
      terminalRetryable: true,
    }]);

    expect(parent.textContent).toContain(`Report ID: ${reportId}`);
    const copy = parent.querySelector<HTMLButtonElement>(
      '[data-testid="chat.turn.copy-incident-report"]',
    )!;
    copy.click();
    expect(copy.disabled).toBe(true);
    expect(copy.getAttribute("aria-busy")).toBe("true");
    expect(copy.textContent).toContain("Preparing…");
    copy.click();
    expect(copyIncidentReport).toHaveBeenCalledTimes(1);

    resolveCopy("memory_fallback");
    await pendingCopy;
    await Promise.resolve();
    expect(copy.disabled).toBe(false);
    expect(copy.hasAttribute("aria-busy")).toBe(false);
    expect(copy.textContent).toContain("Copied for this session");
    expect(copyIncidentReport).toHaveBeenCalledWith(reportId);
    renderer.unload();
  });

  it("settles cancelled activity into one stable 45s drawer", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const reasoning: Extract<AgentPart, { kind: "reasoning" }> = {
      id: "reasoning-cancel-settlement",
      kind: "reasoning",
      messageId: "assistant-cancel-settlement",
      state: "complete",
      summary: "Checked the vault before cancellation.",
      order: 1,
    };
    const stopped: AgentConversationSnapshot = {
      runId: "run-cancel-settlement",
      turnId: "user-cancel-settlement",
      status: "cancelled",
      phase: "complete",
      elapsedMs: 45_000,
      messages: [{
        id: "assistant-cancel-settlement",
        role: "assistant",
        partIds: [reasoning.id],
      }],
      parts: [reasoning],
    };
    const history: readonly ChatMessage[] = [{
      role: "user",
      message_id: "user-cancel-settlement",
      content: "Check the vault.",
    }, {
      role: "assistant",
      message_id: "assistant-cancel-settlement",
      content: null,
      responseDurationMs: 45_000,
      terminalOutcome: "cancelled",
      messageParts: [{
        id: reasoning.id,
        type: "reasoning",
        timestamp: reasoning.order,
        data: reasoning.summary,
      }],
    }];

    await renderer.renderActive(
      stopped,
      presentation("cancelled", false, "Stopped", stopped),
    );
    expect(parent.querySelector(".systemsculpt-agent-tail-status.is-cancelled")?.textContent)
      .toBe("Stopped");

    await renderer.renderHistory(history);
    await renderer.renderActive(
      stopped,
      presentation("cancelled", false, "Stopped", stopped),
    );

    const drawer = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-history details[data-agent-turn-fold]",
    )!;
    expect(drawer.open).toBe(false);
    expect(drawer.querySelector(".systemsculpt-agent-activity-label")?.textContent)
      .toBe("You stopped after 45s");
    expect(parent.querySelectorAll(".systemsculpt-agent-activity-label")).toHaveLength(1);
    expect(parent.querySelector(".systemsculpt-agent-tail-status.is-cancelled")).toBeNull();

    await renderer.renderHistory(history);
    await renderer.renderActive(
      stopped,
      presentation("cancelled", false, "Stopped", stopped),
    );

    expect(parent.querySelector(".systemsculpt-agent-history details[data-agent-turn-fold]"))
      .toBe(drawer);
    expect(drawer.querySelector(".systemsculpt-agent-activity-label")?.textContent)
      .toBe("You stopped after 45s");
    expect(parent.querySelector(".systemsculpt-agent-tail-status.is-cancelled")).toBeNull();
    renderer.unload();
  });

  it("keeps the live Stopped fallback when cancellation has no durable assistant", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const stopped: AgentConversationSnapshot = {
      runId: "run-empty-cancellation",
      turnId: "user-empty-cancellation",
      status: "cancelled",
      phase: "complete",
      elapsedMs: 2_000,
      messages: [],
      parts: [],
    };

    await renderer.renderHistory([{
      role: "user",
      message_id: "user-empty-cancellation",
      content: "Stop immediately.",
    }]);
    await renderer.renderActive(
      stopped,
      presentation("cancelled", false, "Stopped", stopped),
    );

    expect(parent.querySelector(".systemsculpt-agent-tail-status.is-cancelled")?.textContent)
      .toBe("Stopped");
    expect(parent.querySelector(".systemsculpt-agent-history details[data-agent-turn-fold]"))
      .toBeNull();
    renderer.unload();
  });

  it("does not let an older durable cancellation suppress a new Stopped fallback", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    await renderer.renderHistory([{
      role: "user",
      message_id: "user-older-cancellation",
      content: "Check the old request.",
    }, {
      role: "assistant",
      message_id: "assistant-older-cancellation",
      content: null,
      responseDurationMs: 3_000,
      terminalOutcome: "cancelled",
      messageParts: [{
        id: "reasoning-older-cancellation",
        type: "reasoning",
        timestamp: 1,
        data: "Old cancelled activity.",
      }],
    }, {
      role: "user",
      message_id: "user-new-cancellation",
      content: "Stop the new request.",
    }]);
    const stopped: AgentConversationSnapshot = {
      runId: "run-new-cancellation",
      turnId: "user-new-cancellation",
      status: "cancelled",
      phase: "complete",
      elapsedMs: 1_000,
      messages: [{
        id: "assistant-new-cancellation",
        role: "assistant",
        partIds: [],
      }],
      parts: [],
    };

    await renderer.renderActive(
      stopped,
      presentation("cancelled", false, "Stopped", stopped),
    );

    expect(parent.querySelector(".systemsculpt-agent-tail-status.is-cancelled")?.textContent)
      .toBe("Stopped");
    expect(parent.querySelector(".systemsculpt-agent-history .systemsculpt-agent-activity-label")
      ?.textContent).toBe("You stopped after 3.0s");
    renderer.unload();
  });

  it("keeps hover labels on controls and disclosures instead of passive transcript content", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onCopyText: jest.fn(() => true),
    });
    renderer.load();

    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-passive-label",
      content: "A completed answer.",
    }]);

    const running: AgentConversationSnapshot = {
      runId: "run-passive-label",
      turnId: "turn-passive-label",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-live-passive-label",
        role: "assistant",
        partIds: ["text-live-passive-label"],
      }],
      parts: [{
        id: "text-live-passive-label",
        kind: "text",
        messageId: "assistant-live-passive-label",
        state: "streaming",
        markdown: "A live answer.",
        order: 0,
      }],
    };
    await renderer.renderActive(
      running,
      presentation("responding", true, "Working", running),
    );

    expect(renderer.element.getAttribute("role")).toBe("log");
    expect(renderer.element.hasAttribute("aria-label")).toBe(false);
    expect(renderer.element.hasAttribute("title")).toBe(false);
    for (const turn of parent.querySelectorAll<HTMLElement>(".systemsculpt-agent-turn")) {
      expect(turn.hasAttribute("aria-label")).toBe(false);
      expect(turn.hasAttribute("title")).toBe(false);
    }
    const tail = parent.querySelector<HTMLElement>(".systemsculpt-agent-tail-status")!;
    expect(tail.textContent).toContain("Working");
    expect(tail.hasAttribute("aria-label")).toBe(false);
    expect(tail.hasAttribute("title")).toBe(false);
    expect(parent.querySelector<HTMLButtonElement>(".systemsculpt-agent-message-copy")
      ?.getAttribute("aria-label")).toBe("Copy response");

    const staticTool = parent.createDiv();
    await (renderer as unknown as {
      renderTool(node: HTMLElement, part: AgentPart): Promise<void>;
    }).renderTool(staticTool, {
      id: "static-server-action",
      order: 0,
      kind: "tool",
      messageId: "assistant-static-server-action",
      callId: "call-static-server-action",
      name: "unknown_server_action",
      location: "server",
      input: {},
      state: "running",
    });
    const staticHeader = staticTool.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-header",
    )!;
    expect(staticHeader.tagName).toBe("SUMMARY");
    expect(staticHeader.closest("details")?.classList.contains("is-disclosure")).toBe(false);
    expect(staticHeader.hasAttribute("aria-label")).toBe(false);
    expect(staticHeader.hasAttribute("title")).toBe(false);

    const searchTool = parent.createDiv();
    await (renderer as unknown as {
      renderTool(node: HTMLElement, part: AgentPart): Promise<void>;
    }).renderTool(searchTool, {
      id: "search-disclosure",
      order: 0,
      kind: "tool",
      messageId: "assistant-search-disclosure",
      callId: "call-search-disclosure",
      name: "web_search",
      location: "server",
      input: { query: "Obsidian" },
      state: "succeeded",
      output: { data: { query: "Obsidian" } },
    });
    const searchSummary = searchTool.querySelector<HTMLElement>(
      "summary.systemsculpt-agent-tool-header",
    )!;
    expect(searchSummary.hasAttribute("aria-label")).toBe(false);
    expect(searchSummary.hasAttribute("title")).toBe(false);
    expect(searchSummary.getAttribute("aria-description")).toBe("Done");
    renderer.unload();
  });

  it("keeps tool identity on the left and renders state and disclosure marks on the right", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const node = parent.createDiv();
    const renderTool = (renderer as unknown as {
      renderTool(node: HTMLElement, part: AgentPart): Promise<boolean>;
    }).renderTool.bind(renderer);
    const running: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-row-grammar",
      order: 0,
      kind: "tool",
      messageId: "assistant-row-grammar",
      callId: "call-row-grammar",
      name: "read",
      location: "vault",
      input: { paths: ["Projects/Plan.md"] },
      state: "running",
    };

    await renderTool(node, running);

    const header = node.querySelector<HTMLElement>(".systemsculpt-agent-tool-header")!;
    const actionIcon = header.querySelector<HTMLElement>(".systemsculpt-agent-tool-icon")!;
    const label = header.querySelector<HTMLElement>(".systemsculpt-agent-tool-label")!;
    const summary = header.querySelector<HTMLElement>(".systemsculpt-agent-tool-summary")!;
    const stateIcon = header.querySelector<HTMLElement>(".systemsculpt-agent-tool-state-icon")!;
    const disclosure = header.querySelector<HTMLElement>(".systemsculpt-agent-tool-disclosure")!;
    const copy = header.querySelector<HTMLElement>(".systemsculpt-agent-tool-copy")!;
    const controls = header.querySelector<HTMLElement>(".systemsculpt-agent-tool-controls")!;
    const details = node.querySelector<HTMLDetailsElement>("details.systemsculpt-agent-tool")!;
    expect(Array.from(header.children)).toEqual([actionIcon, copy, controls]);
    expect(Array.from(copy.children)).toEqual([label, summary]);
    expect(Array.from(controls.children)).toEqual([disclosure, stateIcon]);
    expect(setIcon).toHaveBeenCalledWith(actionIcon, "file-text");
    expect(setIcon).toHaveBeenCalledWith(disclosure, "chevron-down");
    expect(setIcon).toHaveBeenCalledWith(stateIcon, "minus");
    expect(actionIcon.classList).not.toContain("is-animated");
    expect(stateIcon.classList).not.toContain("is-animated");
    expect(header.querySelector(".systemsculpt-agent-tool-state")).toBeNull();
    expect(details.open).toBe(false);
    expect(actionIcon.hasAttribute("title")).toBe(false);
    expect(stateIcon.hasAttribute("title")).toBe(false);

    await renderTool(node, {
      ...running,
      state: "succeeded",
      output: { summary: "Read Projects/Plan.md" },
    });

    expect(header.querySelector(".systemsculpt-agent-tool-icon")).toBe(actionIcon);
    expect(header.querySelector(".systemsculpt-agent-tool-state-icon")).toBe(stateIcon);
    expect(actionIcon.dataset.iconName).toBe("file-text");
    expect(stateIcon.dataset.iconState).toBe("check");
    expect(setIcon).toHaveBeenCalledWith(stateIcon, "check");
    expect(stateIcon.classList).not.toContain("is-animated");
    expect(summary.textContent).toBe("Read Projects/Plan.md");
    expect(details.open).toBe(false);
    renderer.unload();
  });

  it("reuses one tool shell while replacing approval and removing obsolete details", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const node = parent.createDiv();
    const renderTool = (renderer as unknown as {
      renderTool(node: HTMLElement, part: AgentPart): boolean;
    }).renderTool.bind(renderer);
    const approvalTool: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-lifecycle",
      order: 0,
      kind: "tool",
      messageId: "assistant-tool-lifecycle",
      callId: "call-tool-lifecycle",
      name: "read",
      location: "vault",
      input: { paths: ["Projects/Plan.md"] },
      state: "approval-required",
      approvalId: "approval-first",
    };

    renderTool(node, approvalTool);
    const shell = node.querySelector<HTMLDetailsElement>("details.systemsculpt-agent-tool")!;
    const header = shell.querySelector<HTMLElement>(".systemsculpt-agent-tool-header")!;
    const disclosure = header.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-disclosure",
    )!;
    const summary = header.querySelector<HTMLElement>(".systemsculpt-agent-tool-summary")!;
    const firstApproval = node.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-approval",
    )!;
    disclosure.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
    expect(shell.classList).toContain("is-disclosure");
    expect(summary.textContent).toBe("Projects/Plan.md");
    expect(disclosure.hasChildNodes()).toBe(true);
    expect(firstApproval.isConnected).toBe(true);

    shell.open = true;
    const disclosedClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    header.dispatchEvent(disclosedClick);
    expect(disclosedClick.defaultPrevented).toBe(false);

    renderTool(node, { ...approvalTool, approvalId: "approval-second" });
    const secondApproval = node.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-approval",
    )!;
    expect(secondApproval).not.toBe(firstApproval);
    expect(firstApproval.isConnected).toBe(false);
    expect(secondApproval.isConnected).toBe(true);

    renderTool(node, {
      ...approvalTool,
      name: "trash",
      approvalId: "approval-trash",
    });
    const trashApproval = node.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-approval",
    )!;
    expect(trashApproval).not.toBe(secondApproval);
    expect(trashApproval.querySelector('[data-testid="chat.approval.allow-for-chat"]'))
      .toBeNull();

    shell.open = true;
    renderTool(node, {
      ...approvalTool,
      name: "unknown_server_action",
      location: "server",
      input: {},
      state: "succeeded",
      approvalId: undefined,
    });

    expect(node.querySelector("details.systemsculpt-agent-tool")).toBe(shell);
    expect(shell.open).toBe(false);
    expect(shell.classList).not.toContain("is-disclosure");
    expect(disclosure.hasChildNodes()).toBe(false);
    expect(disclosure.dataset.iconName).toBeUndefined();
    expect(summary.textContent).toBe("");
    expect(summary.hidden).toBe(true);
    expect(header.querySelector(".systemsculpt-agent-tool-state")).toBeNull();
    expect(node.querySelector(":scope > .systemsculpt-agent-approval")).toBeNull();
    const plainClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    header.dispatchEvent(plainClick);
    expect(plainClick.defaultPrevented).toBe(true);
    renderer.unload();
  });

  it("reuses the committed display fingerprint for an unchanged active tool", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    let artifactSerializations = 0;
    const artifact = {
      id: "artifact-fingerprint",
      kind: "vault_file" as const,
      title: "Plan.md",
      path: "Projects/Plan.md",
      toJSON: () => {
        artifactSerializations += 1;
        return {
          id: "artifact-fingerprint",
          kind: "vault_file",
          title: "Plan.md",
          path: "Projects/Plan.md",
        };
      },
    };
    const tool: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-fingerprint",
      kind: "tool",
      messageId: "assistant-fingerprint",
      callId: "call-fingerprint",
      name: "write",
      location: "vault",
      input: { path: "Projects/Plan.md", content: "# Plan" },
      state: "succeeded",
      output: { artifacts: [artifact] },
      order: 0,
    };
    const snapshot = (parts: readonly AgentPart[]): AgentConversationSnapshot => ({
      runId: "run-fingerprint",
      turnId: "user-fingerprint",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-fingerprint",
        role: "assistant",
        partIds: parts.map((part) => part.id),
      }],
      parts,
    });
    const render = async (parts: readonly AgentPart[]): Promise<void> => {
      const next = snapshot(parts);
      await renderer.renderActive(next, presentation("responding", true, "Working", next));
    };

    await render([tool]);
    const toolNode = parent.querySelector<HTMLElement>(
      '[data-part-key="tool:call-fingerprint"]',
    )!;
    const support = toolNode.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-support",
    )!;
    artifactSerializations = 0;

    await render([{ ...tool }]);

    expect(artifactSerializations).toBe(1);
    expect(parent.querySelector('[data-part-key="tool:call-fingerprint"]')).toBe(toolNode);
    expect(toolNode.querySelector(".systemsculpt-agent-tool-support")).toBe(support);
    const internals = renderer as unknown as {
      activeToolDisplayFingerprints: Map<string, string>;
    };
    expect(internals.activeToolDisplayFingerprints.has("tool:call-fingerprint")).toBe(true);

    await render([]);
    expect(internals.activeToolDisplayFingerprints.size).toBe(0);
    await render([tool]);
    renderer.clearActive();
    expect(internals.activeToolDisplayFingerprints.size).toBe(0);
    renderer.unload();
  });

  it("keeps full reasoning content hidden until its drawer opens", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const reasoning: Extract<AgentPart, { kind: "reasoning" }> = {
      id: "reasoning-preview",
      kind: "reasoning",
      messageId: "assistant-reasoning-preview",
      state: "streaming",
      summary: "# Inspecting vault structure\n\nFull **reasoning** detail stays here.",
      order: 0,
    };
    const snapshot: AgentConversationSnapshot = {
      runId: "run-reasoning-preview",
      turnId: "user-reasoning-preview",
      status: "running",
      phase: "thinking",
      messages: [{
        id: "assistant-reasoning-preview",
        role: "assistant",
        partIds: [reasoning.id],
      }],
      parts: [reasoning],
    };

    await renderer.renderActive(
      snapshot,
      presentation("reasoning", true, "Working", snapshot),
    );

    const details = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-reasoning-details",
    )!;
    const header = details.querySelector<HTMLElement>(
      ".systemsculpt-agent-reasoning-header",
    )!;
    expect(details.open).toBe(false);
    expect(header.textContent).toBe("Reasoning...");
    expect(header.hasAttribute("aria-label")).toBe(false);
    expect(header.hasAttribute("title")).toBe(false);
    expect(details.querySelector(".systemsculpt-agent-reasoning-preview")).toBeNull();
    expect(details.textContent).not.toContain("Inspecting vault structure");
    const body = details.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-body")!;
    expect(body.textContent).toBe("");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(body.textContent).toContain("Full **reasoning** detail stays here.");
    renderer.unload();
  });

  it("expands previous activity in order, updates the open group, and removes it when no longer needed", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const tools: Array<Extract<AgentPart, { kind: "tool" }>> = [
      ["tool-overflow-one", "call-overflow-one", "One.md"],
      ["tool-overflow-two", "call-overflow-two", "Two.md"],
      ["tool-overflow-three", "call-overflow-three", "Three.md"],
    ].map(([id, callId, path], order) => ({
      id,
      kind: "tool",
      messageId: "assistant-overflow",
      callId,
      name: "read",
      location: "vault",
      input: { paths: [path] },
      state: "succeeded",
      output: { data: { files: [{ path, content: "ok" }] } },
      order,
    }));
    const snapshot = (parts: readonly AgentPart[]): AgentConversationSnapshot => ({
      runId: "run-overflow",
      turnId: "user-overflow",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-overflow",
        role: "assistant",
        partIds: parts.map((part) => part.id),
      }],
      parts,
    });
    const render = async (parts: readonly AgentPart[]): Promise<void> => {
      const next = snapshot(parts);
      await renderer.renderActive(next, presentation("responding", true, "Working", next));
    };

    await render(tools);
    const body = parent.querySelector<HTMLElement>(
      ".systemsculpt-agent-active-run .systemsculpt-agent-turn-body",
    )!;
    const overflow = body.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )!;
    const rows = () => Array.from(body.querySelectorAll<HTMLElement>(
      "[data-agent-activity-row]",
    )).map((row) => row.dataset.partKey);
    expect(rows()).toEqual(["tool:call-overflow-three"]);
    expect(overflow.getAttribute("aria-expanded")).toBe("false");
    expect(overflow.querySelector<HTMLElement>(
      ".systemsculpt-agent-activity-overflow-icon",
    )?.dataset.iconName).toBe("file-text");
    expect(overflow.lastElementChild?.classList)
      .toContain("systemsculpt-agent-activity-overflow-disclosure");
    const drawer = overflow.nextElementSibling as HTMLElement;
    expect(overflow.getAttribute("aria-controls")).toBe(drawer.id);

    overflow.click();
    expect(rows()).toEqual([
      "tool:call-overflow-one",
      "tool:call-overflow-two",
      "tool:call-overflow-three",
    ]);
    expect(drawer.lastElementChild?.getAttribute("data-part-key"))
      .toBe("tool:call-overflow-three");
    expect(overflow.querySelector(".systemsculpt-agent-activity-overflow-label")?.textContent)
      .toBe("Read 1 file + 2 other tool calls");

    drawer.insertBefore(drawer.lastElementChild!, drawer.firstElementChild);
    (renderer as unknown as {
      applyActivityOverflowLayout(element: HTMLButtonElement): void;
    }).applyActivityOverflowLayout(overflow);
    expect(drawer.lastElementChild?.getAttribute("data-part-key"))
      .toBe("tool:call-overflow-three");

    overflow.focus();
    await render([tools[0]!, tools[2]!]);
    expect(body.querySelector("button[data-agent-activity-overflow]")).toBe(overflow);
    expect(rows()).toEqual(["tool:call-overflow-one", "tool:call-overflow-three"]);
    expect(overflow.dataset.hiddenCount).toBe("1");
    expect(overflow.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(overflow);

    const finalReasoning: AgentPart = {
      id: "reasoning-overflow-final",
      kind: "reasoning",
      messageId: "assistant-overflow",
      state: "complete",
      summary: "Finished checking the files.",
      order: 4,
    };
    await render([tools[0]!, finalReasoning]);
    expect(overflow.querySelector(".systemsculpt-agent-activity-overflow-label")?.textContent)
      .toBe("Reasoned + 1 other tool call");
    expect(overflow.querySelector<HTMLElement>(
      ".systemsculpt-agent-activity-overflow-icon",
    )?.dataset.iconName).toBe("sparkles");
    expect(overflow.lastElementChild?.classList)
      .toContain("systemsculpt-agent-activity-overflow-disclosure");

    await render([tools[2]!]);
    expect(body.querySelector("button[data-agent-activity-overflow]")).toBeNull();
    expect(rows()).toEqual(["tool:call-overflow-three"]);
    expect(() => {
      overflow.click();
      (renderer as unknown as {
        setActivityOverflowItems(
          element: HTMLButtonElement,
          latestNode: HTMLElement | null,
          previousNodes: readonly HTMLElement[],
        ): void;
      }).setActivityOverflowItems(overflow, null, []);
    }).not.toThrow();
    renderer.unload();
  });

  it("releases Markdown owned by a reasoning row hidden behind historical overflow", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();

    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-overflow-markdown",
      content: "Done.",
      messageParts: [{
        id: "reasoning-overflow-old",
        type: "reasoning",
        timestamp: 1,
        data: "Older reasoning detail",
      }, {
        id: "reasoning-overflow-latest",
        type: "reasoning",
        timestamp: 2,
        data: "Latest reasoning detail",
      }, {
        id: "answer-overflow-markdown",
        type: "content",
        timestamp: 3,
        data: "Done.",
      }],
    }]);

    const worked = parent.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    )!;
    const hydrationState = (renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalActivityHydrationStates.get(worked)!;
    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await hydrationState.hydration;
    const overflow = parent.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )!;
    overflow.click();
    await (renderer as unknown as {
      historicalOverflowHydrationStates: Map<
        HTMLButtonElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalOverflowHydrationStates.get(overflow)?.hydration;
    const older = parent.querySelector<HTMLElement>(
      '[data-part-key="reasoning-overflow-old"]',
    )!;
    const reasoning = older.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-reasoning-details",
    )!;
    reasoning.open = true;
    reasoning.dispatchEvent(new Event("toggle"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const liveMarkdown = (renderer as unknown as {
      liveMarkdown: { states: Map<HTMLElement, unknown> };
    }).liveMarkdown;
    expect(liveMarkdown.states.size).toBe(2);

    overflow.click();
    expect(older.isConnected).toBe(false);
    await renderer.renderHistory([]);
    expect(liveMarkdown.states.size).toBe(0);
    renderer.unload();
  });

  it("adopts running activity into a new closed Worked fold with the final answer outside", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const toolCall = {
      id: "call-adopt-work",
      messageId: "assistant-adopt-work",
      request: {
        id: "call-adopt-work",
        type: "function" as const,
        function: { name: "read", arguments: '{"paths":["Plan.md"]}' },
      },
      state: "completed" as const,
      result: {
        success: true,
        data: { files: [{ path: "Plan.md", content: "# Plan" }] },
      },
      timestamp: 2,
    };
    const parts: readonly AgentPart[] = [{
      id: "reasoning-adopt-work",
      kind: "reasoning",
      messageId: "assistant-adopt-work",
      state: "complete",
      summary: "Checked the plan before answering.",
      order: 1,
    }, {
      id: "tool-adopt-work",
      kind: "tool",
      messageId: "assistant-adopt-work",
      callId: toolCall.id,
      name: "read",
      location: "vault",
      input: { paths: ["Plan.md"] },
      state: "succeeded",
      output: toolCall.result,
      order: 2,
    }, {
      id: "answer-adopt-work",
      kind: "text",
      messageId: "assistant-adopt-work",
      state: "complete",
      markdown: "The plan is ready.",
      order: 3,
    }];
    const running: AgentConversationSnapshot = {
      runId: "run-adopt-work",
      turnId: "user-adopt-work",
      status: "running",
      phase: "working",
      elapsedMs: 62_000,
      messages: [{
        id: "assistant-adopt-work",
        role: "assistant",
        partIds: parts.map((part) => part.id),
      }],
      parts,
    };
    await renderer.renderActive(
      running,
      presentation("responding", true, "Working", running),
    );
    const liveReasoning = (renderer as unknown as {
      activeNodes: Map<string, HTMLElement>;
    }).activeNodes.get("reasoning-adopt-work")!;
    const liveTool = parent.querySelector<HTMLElement>(
      '[data-part-key="tool:call-adopt-work"]',
    )!;
    const liveAnswer = parent.querySelector<HTMLElement>(
      '[data-part-key="answer-adopt-work"]',
    )!;

    await renderer.settleHistory([{
      role: "user",
      message_id: "user-adopt-work",
      content: "Check the plan.",
    }, {
      role: "assistant",
      message_id: "assistant-adopt-work",
      content: "The plan is ready.",
      responseDurationMs: 62_000,
      tool_calls: [toolCall],
      messageParts: [{
        id: "reasoning-adopt-work",
        type: "reasoning",
        timestamp: 1,
        data: "Checked the plan before answering.",
      }, {
        id: "tool-adopt-work",
        type: "tool_call",
        timestamp: 2,
        data: toolCall,
      }, {
        id: "answer-adopt-work",
        type: "content",
        timestamp: 3,
        data: "The plan is ready.",
      }],
    }], "user-adopt-work");

    const row = parent.querySelector<HTMLElement>(
      '.systemsculpt-agent-history [data-message-id="assistant-adopt-work"]',
    )!;
    const worked = row.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    expect(worked.open).toBe(false);
    expect(worked.querySelector(".systemsculpt-agent-activity-label")?.textContent)
      .toBe("Worked for 1m 2s");
    const overflow = worked.querySelector<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )!;
    expect(overflow.getAttribute("aria-expanded")).toBe("false");
    expect(liveReasoning.isConnected).toBe(false);
    expect(worked.contains(liveTool)).toBe(true);
    expect(worked.contains(liveAnswer)).toBe(false);
    expect(row.querySelector('[data-part-key="answer-adopt-work"]')).toBe(liveAnswer);
    overflow.click();
    expect(overflow.getAttribute("aria-expanded")).toBe("true");
    expect(worked.contains(liveReasoning)).toBe(true);
    expect(worked.contains(liveTool)).toBe(true);
    expect(Array.from(worked.querySelectorAll<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-body > .systemsculpt-agent-activity-overflow-body > [data-agent-activity-row]",
    ))).toEqual([liveReasoning, liveTool]);
    expect(overflow.nextElementSibling?.lastElementChild).toBe(liveTool);
    expect(parent.querySelector(".systemsculpt-agent-active-run")?.childElementCount).toBe(0);
    renderer.unload();
  });

  it("keeps the completed activity fold stable while updating its duration and focus", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const reasoning: Extract<AgentPart, { kind: "reasoning" }> = {
      id: "reasoning-completed-fold",
      kind: "reasoning",
      messageId: "assistant-completed-fold",
      state: "complete",
      summary: "Checked the final result.",
      order: 0,
    };
    const snapshot = (
      status: AgentConversationSnapshot["status"],
      elapsedMs: number,
    ): AgentConversationSnapshot => ({
      runId: "run-completed-fold",
      turnId: "user-completed-fold",
      status,
      phase: status === "completed" ? "complete" : "working",
      elapsedMs,
      messages: [{
        id: "assistant-completed-fold",
        role: "assistant",
        partIds: [reasoning.id],
      }],
      parts: [reasoning],
    });
    const running = snapshot("running", 30_000);
    await renderer.renderActive(
      running,
      presentation("reasoning", true, "Working", running),
    );
    parent.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-header")!.focus();

    const completed = snapshot("completed", 31_000);
    await renderer.renderActive(
      completed,
      presentation("completed", false, "Done", completed),
    );
    const worked = parent.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const workedHeader = worked.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-header",
    )!;
    expect(worked.open).toBe(false);
    expect(document.activeElement).toBe(workedHeader);
    expect(worked.querySelector(".systemsculpt-agent-activity-label")?.textContent)
      .toBe("Worked for 31s");

    const refreshed = snapshot("completed", 45_000);
    await renderer.renderActive(
      refreshed,
      presentation("completed", false, "Done", refreshed),
    );
    expect(parent.querySelector("details[data-agent-turn-fold]")).toBe(worked);
    expect(worked.querySelector(".systemsculpt-agent-activity-label")?.textContent)
      .toBe("Worked for 45s");
    renderer.unload();
  });

  it("normalizes incomplete durable tool records without exposing unsafe payloads", () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    const normalize = (renderer as unknown as {
      historicalToolPart(tool: ToolCall): Extract<AgentPart, { kind: "tool" }>;
    }).historicalToolPart.bind(renderer);
    const base = (id: string): ToolCall => ({
      id,
      messageId: "assistant-durable-tools",
      request: {
        id,
        type: "function",
        function: { name: "write", arguments: '{"path":"Plan.md"}' },
      },
      state: "completed",
      timestamp: 1,
    });

    const successful = normalize({
      ...base("durable-success"),
      result: {
        success: true,
        data: { summary: "Created Plan.md", path: "Plan.md" },
      },
    });
    expect(successful.state).toBe("succeeded");
    expect(successful.output?.artifacts?.[0]?.path).toBe("Plan.md");

    const partial = normalize({
      ...base("durable-partial"),
      state: "failed",
      request: {
        id: "durable-partial",
        type: "function",
        function: { name: "multi_edit", arguments: '{"edits":[]}' },
      },
      result: {
        success: false,
        data: {
          results: [{ path: "Good.md", success: true }, { path: "Bad.md", success: false }],
        },
        error: { code: "", message: "" },
      },
    });
    expect(partial.state).toBe("failed");
    expect(partial.error).toEqual({
      code: "TOOL_EXECUTION_FAILED",
      message: "The tool failed.",
    });
    expect(partial.output?.artifacts?.map((artifact) => artifact.path)).toEqual(["Good.md"]);

    const running = normalize({
      ...base("durable-running"),
      request: {
        id: "durable-running",
        type: "function",
        function: { name: "", arguments: "{}" },
      },
      state: "executing",
    });
    expect(running).toMatchObject({
      name: "unknown_tool",
      location: "vault",
      input: {},
      state: "running",
    });
    expect(running.output).toBeUndefined();

    const malformed = normalize({
      ...base("durable-malformed"),
      executedOn: "server",
      request: {
        id: "durable-malformed",
        type: "function",
        function: { name: "write", arguments: "{" },
      },
      state: "failed",
      result: {
        success: false,
        error: {
          code: "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN",
          message: "Outcome is not known.",
        },
      },
    });
    expect(malformed).toMatchObject({
      location: "server",
      input: "{",
      state: "outcome-unknown",
    });

    const uncertain = normalize({
      ...base("durable-uncertain"),
      state: "failed",
      result: {
        success: false,
        error: { code: "TOOL_OUTCOME_UNKNOWN", message: "Unknown" },
      },
    });
    expect(uncertain.state).toBe("outcome-unknown");

    const failedResult = normalize({
      ...base("durable-failed-result"),
      result: { success: false },
    });
    expect(failedResult.state).toBe("failed");
  });

  it("settles durable activity without a mounted live row and keeps sources outside Work", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const toolCall: ToolCall = {
      id: "call-fallback-settle",
      messageId: "assistant-fallback-settle-2",
      request: {
        id: "call-fallback-settle",
        type: "function",
        function: { name: "custom_action", arguments: "{}" },
      },
      state: "completed",
      result: { success: true, data: { summary: "Custom action complete" } },
      timestamp: 1,
    };

    await renderer.settleHistory([{
      role: "user",
      message_id: "user-fallback-settle",
      content: "Finish this turn.",
    }, {
      role: "assistant",
      message_id: "assistant-fallback-settle-1",
      content: null,
    }, {
      role: "assistant",
      message_id: "assistant-fallback-settle-2",
      content: "Finished.\n\n### Sources\n\n- Reference",
      tool_calls: [toolCall],
      messageParts: [{
        id: "tool-fallback-settle",
        type: "tool_call",
        timestamp: 1,
        data: toolCall,
      }, {
        id: "answer-fallback-settle",
        type: "content",
        timestamp: 2,
        data: "Finished.",
      }, {
        id: "sources:fallback-settle",
        type: "content",
        timestamp: 3,
        data: "### Sources\n\n- Reference",
      }],
    }], "user-fallback-settle");

    const row = parent.querySelector<HTMLElement>(
      '.systemsculpt-agent-history [data-message-id="assistant-fallback-settle-1"]',
    )!;
    const worked = row.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    expect(worked.open).toBe(false);
    expect(worked.textContent).not.toContain("Custom action complete");
    const hydrationState = (renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalActivityHydrationStates.get(worked)!;
    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await hydrationState.hydration;
    expect(worked.textContent).toContain("Custom action complete");
    expect(worked.textContent).not.toContain("### Sources");
    expect(row.textContent).toContain("### Sources");
    expect(parent.querySelector(".systemsculpt-agent-active-run")?.childElementCount).toBe(0);
    renderer.unload();
  });

  it("keeps a durable final answer outside Worked before a late tool and blank content", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const lateTool: ToolCall = {
      id: "call-late-blank-history",
      messageId: "assistant-late-blank-history-2",
      request: {
        id: "call-late-blank-history",
        type: "function",
        function: { name: "read", arguments: '{"paths":["Plan.md"]}' },
      },
      state: "completed",
      result: { success: true, data: { summary: "Read Plan.md" } },
      timestamp: 2,
    };

    await renderer.renderHistory([{
      role: "user",
      message_id: "user-late-blank-history",
      content: "Finish after checking the plan.",
    }, {
      role: "assistant",
      message_id: "assistant-late-blank-history-1",
      content: "Final answer",
      messageParts: [{
        id: "answer-late-blank-history",
        type: "content",
        timestamp: 1,
        data: "Final answer",
      }],
    }, {
      role: "assistant",
      message_id: "assistant-late-blank-history-2",
      content: "### Sources\n\n- [Reference](<https://example.com/reference>)",
      tool_calls: [lateTool],
      messageParts: [{
        id: "tool-late-blank-history",
        type: "tool_call",
        timestamp: 2,
        data: lateTool,
      }, {
        id: "blank-late-blank-history",
        type: "content",
        timestamp: 3,
        data: "   ",
      }, {
        id: "sources:late-blank-history",
        type: "content",
        timestamp: 4,
        data: "### Sources\n\n- [Reference](<https://example.com/reference>)",
      }],
    }]);

    const row = parent.querySelector<HTMLElement>(
      '[data-message-id="assistant-late-blank-history-1"]',
    )!;
    const worked = row.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const answer = row.querySelector<HTMLElement>(
      '[data-part-key="answer-late-blank-history"]',
    )!;
    const sources = row.querySelector<HTMLElement>(
      '[data-part-key="sources:late-blank-history"]',
    )!;
    expect(worked.open).toBe(false);
    expect(worked.contains(answer)).toBe(false);
    expect(worked.contains(sources)).toBe(false);
    expect(answer.textContent).toBe("Final answer");
    expect(sources.textContent).toContain("Sources");
    expect(row.querySelector('[data-part-key="blank-late-blank-history"]')).toBeNull();

    const hydrationState = (renderer as unknown as {
      historicalActivityHydrationStates: Map<
        HTMLDetailsElement,
        { hydration: Promise<void> | null }
      >;
    }).historicalActivityHydrationStates.get(worked)!;
    worked.open = true;
    worked.dispatchEvent(new Event("toggle"));
    await hydrationState.hydration;
    expect(worked.querySelector('[data-part-key="tool:call-late-blank-history"]'))
      .not.toBeNull();
    expect(worked.contains(answer)).toBe(false);
    renderer.unload();
  });

  it("keeps a live final answer outside Worked before a late tool and blank content", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const snapshot: AgentConversationSnapshot = {
      runId: "run-late-blank-live",
      turnId: "user-late-blank-live",
      status: "completed",
      phase: "complete",
      messages: [{
        id: "assistant-late-blank-live-1",
        role: "assistant",
        partIds: ["answer-late-blank-live"],
      }, {
        id: "assistant-late-blank-live-2",
        role: "assistant",
        partIds: [
          "tool-late-blank-live",
          "blank-late-blank-live",
          "sources:late-blank-live",
        ],
      }],
      parts: [{
        id: "answer-late-blank-live",
        kind: "text",
        messageId: "assistant-late-blank-live-1",
        state: "complete",
        markdown: "Final answer",
        order: 1,
      }, {
        id: "tool-late-blank-live",
        kind: "tool",
        messageId: "assistant-late-blank-live-2",
        callId: "call-late-blank-live",
        name: "read",
        location: "vault",
        input: { paths: ["Plan.md"] },
        state: "succeeded",
        order: 2,
      }, {
        id: "blank-late-blank-live",
        kind: "text",
        messageId: "assistant-late-blank-live-2",
        state: "complete",
        markdown: "   ",
        order: 3,
      }, {
        id: "sources:late-blank-live",
        kind: "text",
        messageId: "assistant-late-blank-live-2",
        state: "complete",
        markdown: "### Sources\n\n- [Reference](<https://example.com/reference>)",
        order: 4,
      }],
    };

    await renderer.renderActive(
      snapshot,
      presentation("completed", false, "Done", snapshot),
    );

    const worked = parent.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const answer = parent.querySelector<HTMLElement>(
      '[data-part-key="answer-late-blank-live"]',
    )!;
    const tool = parent.querySelector<HTMLElement>(
      '[data-part-key="tool:call-late-blank-live"]',
    )!;
    const sources = parent.querySelector<HTMLElement>(
      '[data-part-key="sources:late-blank-live"]',
    )!;
    expect(worked.open).toBe(false);
    expect(worked.contains(answer)).toBe(false);
    expect(worked.contains(tool)).toBe(true);
    expect(worked.contains(sources)).toBe(false);
    expect(answer.textContent).toBe("Final answer");
    expect(sources.textContent).toContain("Sources");
    renderer.unload();
  });

  it("ignores trailing blank reasoning when placing a durable final answer", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const toolCall: ToolCall = {
      id: "call-blank-reasoning-history",
      messageId: "assistant-blank-reasoning-history",
      request: {
        id: "call-blank-reasoning-history",
        type: "function",
        function: { name: "read", arguments: '{"paths":["Plan.md"]}' },
      },
      state: "completed",
      result: { success: true, data: { summary: "Read Plan.md" } },
      timestamp: 1,
    };

    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-blank-reasoning-history",
      content: "Final answer",
      messageParts: [{
        id: "tool-blank-reasoning-history",
        type: "tool_call",
        timestamp: 1,
        data: toolCall,
      }, {
        id: "answer-blank-reasoning-history",
        type: "content",
        timestamp: 2,
        data: "Final answer",
      }, {
        id: "reasoning-blank-reasoning-history",
        type: "reasoning",
        timestamp: 3,
        data: "   ",
      }],
    }]);

    const row = parent.querySelector<HTMLElement>(
      '[data-message-id="assistant-blank-reasoning-history"]',
    )!;
    const worked = row.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const answer = row.querySelector<HTMLElement>(
      '[data-part-key="answer-blank-reasoning-history"]',
    )!;
    expect(worked).not.toBeNull();
    expect(worked.contains(answer)).toBe(false);
    expect(answer.textContent).toBe("Final answer");
    expect(row.querySelector('[data-part-key="reasoning-blank-reasoning-history"]'))
      .toBeNull();
    renderer.unload();
  });

  it("ignores trailing blank reasoning when placing a live final answer", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const snapshot: AgentConversationSnapshot = {
      runId: "run-blank-reasoning-live",
      turnId: "user-blank-reasoning-live",
      status: "completed",
      phase: "complete",
      messages: [{
        id: "assistant-blank-reasoning-live",
        role: "assistant",
        partIds: [
          "tool-blank-reasoning-live",
          "answer-blank-reasoning-live",
          "reasoning-blank-reasoning-live",
        ],
      }],
      parts: [{
        id: "tool-blank-reasoning-live",
        kind: "tool",
        messageId: "assistant-blank-reasoning-live",
        callId: "call-blank-reasoning-live",
        name: "read",
        location: "vault",
        input: { paths: ["Plan.md"] },
        state: "succeeded",
        order: 1,
      }, {
        id: "answer-blank-reasoning-live",
        kind: "text",
        messageId: "assistant-blank-reasoning-live",
        state: "complete",
        markdown: "Final answer",
        order: 2,
      }, {
        id: "reasoning-blank-reasoning-live",
        kind: "reasoning",
        messageId: "assistant-blank-reasoning-live",
        state: "complete",
        summary: "   ",
        order: 3,
      }],
    };

    await renderer.renderActive(
      snapshot,
      presentation("completed", false, "Done", snapshot),
    );

    const worked = parent.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]")!;
    const answer = parent.querySelector<HTMLElement>(
      '[data-part-key="answer-blank-reasoning-live"]',
    )!;
    expect(worked).not.toBeNull();
    expect(worked.contains(answer)).toBe(false);
    expect(answer.textContent).toBe("Final answer");
    expect(parent.querySelector('[data-part-key="reasoning-blank-reasoning-live"]'))
      .toBeNull();
    renderer.unload();
  });

  it("keeps an unchanged terminal error row stable and exposes only its support id", async () => {
    const parent = document.body.createDiv();
    const onRetryFailedTurn = jest.fn();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onRetryFailedTurn,
    });
    renderer.load();
    const error: Extract<AgentPart, { kind: "error" }> = {
      id: "terminal-error-stable",
      kind: "error",
      order: 0,
      error: {
        code: "request_failed",
        message: "Private upstream details",
        incidentId: "incident_11111111111111111111111111111111",
      },
      retryable: true,
      retryMessageId: "user-terminal-error",
    };
    const snapshot = (part: Extract<AgentPart, { kind: "error" }>): AgentConversationSnapshot => ({
      runId: "run-terminal-error",
      turnId: "user-terminal-error",
      status: "failed",
      phase: "complete",
      messages: [],
      parts: [part],
    });
    const first = snapshot(error);
    await renderer.renderActive(
      first,
      presentation("failed", false, "Failed", first),
    );
    const row = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-error")!;
    expect(row.textContent).toContain("incident_11111111111111111111111111111111");
    expect(row.textContent).not.toContain("Private upstream details");

    const repeated = snapshot({ ...error, error: { ...error.error } });
    await renderer.renderActive(
      repeated,
      presentation("failed", false, "Failed", repeated),
    );
    expect(parent.querySelector(".systemsculpt-agent-part.is-error")).toBe(row);
    row.querySelector<HTMLButtonElement>(".systemsculpt-agent-error-retry")!.click();
    expect(onRetryFailedTurn).toHaveBeenCalledWith("user-terminal-error");
    renderer.unload();
  });

  it("carries open reasoning state and focus to durable history", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const reasoning: Extract<AgentPart, { kind: "reasoning" }> = {
      id: "reasoning-transfer",
      kind: "reasoning",
      messageId: "assistant-transfer",
      state: "complete",
      summary: "Inspect the durable answer.",
      order: 0,
    };
    const running: AgentConversationSnapshot = {
      runId: "run-transfer",
      turnId: "user-transfer",
      status: "running",
      phase: "thinking",
      messages: [{
        id: "assistant-transfer",
        role: "assistant",
        partIds: [reasoning.id],
      }],
      parts: [reasoning],
    };
    await renderer.renderActive(
      running,
      presentation("reasoning", true, "Working", running),
    );
    const liveDetails = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-active-run .systemsculpt-agent-reasoning-details",
    )!;
    const liveHeader = liveDetails.querySelector<HTMLElement>(
      ".systemsculpt-agent-reasoning-header",
    )!;
    liveDetails.open = true;
    liveDetails.dispatchEvent(new Event("toggle"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    liveHeader.focus();

    await renderer.renderHistory([{
      role: "user",
      message_id: "user-transfer",
      content: "Inspect this.",
    }, {
      role: "assistant",
      message_id: "assistant-transfer",
      content: "",
      messageParts: [{
        id: reasoning.id,
        type: "reasoning",
        timestamp: 0,
        data: reasoning.summary,
      }],
    }]);

    const durableDetails = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-history .systemsculpt-agent-reasoning-details",
    )!;
    const durableHeader = durableDetails.querySelector<HTMLElement>(
      ".systemsculpt-agent-reasoning-header",
    )!;
    expect(durableDetails).not.toBe(liveDetails);
    expect(durableDetails.open).toBe(true);
    expect(document.activeElement).toBe(durableHeader);
    renderer.unload();
  });

  it("retries a failed reasoning disclosure and clears an empty summary", async () => {
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const summary = [
      "```text",
      "private detail",
      "```",
      `# ${"A".repeat(120)}`,
    ].join("\n");
    const snapshot = (nextSummary: string): AgentConversationSnapshot => ({
      runId: "run-reasoning-retry",
      turnId: "user-reasoning-retry",
      status: "running",
      phase: "thinking",
      messages: [{
        id: "assistant-reasoning-retry",
        role: "assistant",
        partIds: ["reasoning-retry"],
      }],
      parts: [{
        id: "reasoning-retry",
        kind: "reasoning",
        messageId: "assistant-reasoning-retry",
        state: "complete",
        summary: nextSummary,
        order: 0,
      }],
    });
    const initial = snapshot(summary);
    await renderer.renderActive(
      initial,
      presentation("reasoning", true, "Working", initial),
    );
    const details = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-reasoning-details",
    )!;
    const body = details.querySelector<HTMLElement>(
      ".systemsculpt-agent-reasoning-body",
    )!;
    expect(details.querySelector(".systemsculpt-agent-reasoning-preview")).toBeNull();
    expect(details.querySelector(".systemsculpt-agent-reasoning-header")?.textContent)
      .toBe("Reasoned");
    const settle = jest.spyOn((renderer as unknown as {
      liveMarkdown: { settle(node: HTMLElement, markdown: string): Promise<void> };
    }).liveMarkdown, "settle").mockRejectedValueOnce(new Error("render failed"));

    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settle).toHaveBeenCalledTimes(1);

    const empty = snapshot("");
    await renderer.renderActive(
      empty,
      presentation("reasoning", true, "Working", empty),
    );
    expect(details.open).toBe(true);
    expect(body.textContent).toBe("");

    details.querySelector(".systemsculpt-agent-reasoning-header")?.remove();
    const repairedSnapshot = snapshot("Recovered summary");
    await renderer.renderActive(
      repairedSnapshot,
      presentation("reasoning", true, "Working", repairedSnapshot),
    );
    const repairedDetails = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-reasoning-details",
    )!;
    expect(repairedDetails).not.toBe(details);

    const rendererInternals = renderer as unknown as {
      reasoningDisclosureStates: WeakMap<HTMLDetailsElement, unknown>;
    };
    rendererInternals.reasoningDisclosureStates.delete(repairedDetails);
    repairedDetails.dispatchEvent(new Event("toggle"));
    const rebuiltSnapshot = snapshot("Recovered summary again");
    await renderer.renderActive(
      rebuiltSnapshot,
      presentation("reasoning", true, "Working", rebuiltSnapshot),
    );
    const rebuiltDetails = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-reasoning-details",
    )!;
    expect(rebuiltDetails).not.toBe(repairedDetails);

    let finishSettle!: () => void;
    settle.mockImplementationOnce(async () => new Promise<void>((resolve) => {
      finishSettle = resolve;
    }));
    rebuiltDetails.open = true;
    rebuiltDetails.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    rebuiltDetails.open = false;
    rebuiltDetails.dispatchEvent(new Event("toggle"));
    finishSettle();
    await Promise.resolve();
    await Promise.resolve();
    renderer.unload();
  });

  it("stops the live Working timer when its status row is detached", async () => {
    jest.useFakeTimers();
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const running: AgentConversationSnapshot = {
      runId: "run-detached-timer",
      turnId: "user-detached-timer",
      status: "running",
      phase: "working",
      elapsedMs: 1_000,
      messages: [],
      parts: [],
    };
    await renderer.renderActive(
      running,
      presentation("responding", true, "Working", running),
    );
    const status = parent.querySelector<HTMLElement>(".systemsculpt-agent-tail-status")!;
    expect((renderer as unknown as { activeWorkingTimer: number | null }).activeWorkingTimer)
      .not.toBeNull();
    status.remove();
    jest.advanceTimersByTime(1_000);
    expect((renderer as unknown as { activeWorkingTimer: number | null }).activeWorkingTimer)
      .toBeNull();
    renderer.unload();
  });

  it("commits approval controls before asynchronously hydrating one stable preview", async () => {
    const parent = document.body.createDiv();
    const app = new App();
    const finishLayoutMutation = jest.fn();
    const beginLayoutMutation = jest.fn(() => finishLayoutMutation);
    const renderer = new AgentConversationRenderer(parent, {
      app,
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      beginLayoutMutation,
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const baseTool: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-atomic-approval",
      kind: "tool",
      messageId: "assistant-atomic-approval",
      callId: "call-atomic-approval",
      name: "write",
      location: "vault",
      input: { path: "Projects/Plan.md", content: "# Plan" },
      state: "running",
      order: 0,
    };
    const snapshot = (
      tool: Extract<AgentPart, { kind: "tool" }>,
      status: AgentConversationSnapshot["status"] = "running",
    ): AgentConversationSnapshot => ({
      runId: "run-atomic-approval",
      turnId: "user-atomic-approval",
      status,
      phase: status === "waiting" ? "waiting" : "working",
      ...(status === "waiting" ? { waitingReason: "approval" as const } : {}),
      messages: [{
        id: "assistant-atomic-approval",
        role: "assistant",
        partIds: [tool.id],
      }],
      parts: [tool],
    });

    await renderer.renderActive(
      snapshot(baseTool),
      presentation("responding", true, "Working", snapshot(baseTool)),
    );
    const toolNode = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-tool")!;
    const shell = toolNode.querySelector<HTMLDetailsElement>(".systemsculpt-agent-tool")!;
    const header = toolNode.querySelector<HTMLElement>(".systemsculpt-agent-tool-header")!;
    const support = toolNode.querySelector<HTMLElement>(".systemsculpt-agent-tool-support")!;
    const supportContent = support.firstElementChild;
    shell.open = true;
    header.focus();

    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    (app.vault.getAbstractFileByPath as jest.Mock)
      .mockReturnValue(new TFile({ path: "Projects/Plan.md" }));
    (app.vault.read as jest.Mock).mockImplementation(async () => {
      await previewGate;
      return "# Existing plan";
    });
    const approvalTool: Extract<AgentPart, { kind: "tool" }> = {
      ...baseTool,
      state: "approval-required",
      approvalId: "approval-atomic",
    };
    const waiting = snapshot(approvalTool, "waiting");
    const pending = renderer.renderActive(
      waiting,
      presentation("awaiting-approval", true, "Needs approval", waiting),
    );
    await pending;
    expect(app.vault.read).toHaveBeenCalledTimes(1);

    expect(parent.querySelector(".systemsculpt-agent-part.is-tool")).toBe(toolNode);
    expect(toolNode.classList).toContain("is-approval-required");
    expect(toolNode.querySelector(".systemsculpt-agent-tool")).toBe(shell);
    expect(toolNode.querySelector(".systemsculpt-agent-tool-header")).toBe(header);
    expect(toolNode.querySelector(".systemsculpt-agent-tool-support")).toBe(support);
    const approval = toolNode.querySelector<HTMLElement>(".systemsculpt-agent-approval")!;
    const preview = approval.querySelector<HTMLElement>(
      ".systemsculpt-agent-approval-preview",
    )!;
    expect(approval.textContent).toContain("Allow this change in your vault?");
    expect(approval.querySelector('[data-testid="chat.approval.deny"]')).not.toBeNull();
    expect(approval.querySelector('[data-testid="chat.approval.allow-once"]')).not.toBeNull();
    expect(approval.querySelector('[data-testid="chat.approval.allow-for-chat"]')).not.toBeNull();
    expect(preview.hidden).toBe(true);
    expect(preview.childElementCount).toBe(0);
    expect(shell.open).toBe(true);
    expect(document.activeElement).toBe(header);

    const reordered = { ...approvalTool, order: 1 };
    const reorderedSnapshot = snapshot(reordered, "waiting");
    await renderer.renderActive(
      reorderedSnapshot,
      presentation("awaiting-approval", true, "Needs approval", reorderedSnapshot),
    );
    expect(toolNode.querySelector(".systemsculpt-agent-approval")).toBe(approval);
    expect(approval.querySelector(".systemsculpt-agent-approval-preview")).toBe(preview);
    expect(support.firstElementChild).toBe(supportContent);
    expect(app.vault.read).toHaveBeenCalledTimes(1);

    const hydration = (renderer as unknown as {
      toolApprovalPreviewHydrationStates: WeakMap<
        HTMLElement,
        { hydration: Promise<void> | null }
      >;
    }).toolApprovalPreviewHydrationStates.get(toolNode)!.hydration!;
    releasePreview();
    await hydration;

    expect(toolNode.querySelector(".systemsculpt-agent-tool")).toBe(shell);
    expect(toolNode.querySelector(".systemsculpt-agent-tool-header")).toBe(header);
    expect(toolNode.querySelector(".systemsculpt-agent-tool-support")).toBe(support);
    expect(toolNode.querySelector(".systemsculpt-agent-approval")).toBe(approval);
    expect(approval.querySelector(".systemsculpt-agent-approval-preview")).toBe(preview);
    expect(preview.hidden).toBe(false);
    expect(preview.querySelector(".systemsculpt-inline-diff")).not.toBeNull();
    expect(beginLayoutMutation).toHaveBeenCalledWith(undefined, preview);
    expect(finishLayoutMutation).toHaveBeenCalledTimes(1);
    expect(shell.open).toBe(true);
    expect(document.activeElement).toBe(header);
    renderer.unload();
  });

  it("hydrates a first-frame approval preview after its controls connect", async () => {
    const parent = document.body.createDiv();
    const app = new App();
    const renderer = new AgentConversationRenderer(parent, {
      app,
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const connectedAtHydrationStart: boolean[] = [];
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(() => {
      const node = parent.querySelector<HTMLElement>(
        '[data-part-key="tool:call-first-frame-approval"]',
      );
      connectedAtHydrationStart.push(Boolean(
        node?.isConnected
        && node.querySelector(".systemsculpt-agent-approval")?.isConnected,
      ));
      return new TFile({ path: "Projects/Plan.md" });
    });
    (app.vault.read as jest.Mock).mockResolvedValue("# Existing plan");
    const tool: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-first-frame-approval",
      kind: "tool",
      messageId: "assistant-first-frame-approval",
      callId: "call-first-frame-approval",
      name: "write",
      location: "vault",
      input: { path: "Projects/Plan.md", content: "# Plan" },
      state: "approval-required",
      approvalId: "approval-first-frame",
      order: 0,
    };
    const snapshot: AgentConversationSnapshot = {
      runId: "run-first-frame-approval",
      turnId: "user-first-frame-approval",
      status: "waiting",
      phase: "waiting",
      waitingReason: "approval",
      messages: [{ id: tool.messageId, role: "assistant", partIds: [tool.id] }],
      parts: [tool],
    };

    await renderer.renderActive(
      snapshot,
      presentation("awaiting-approval", true, "Needs approval", snapshot),
    );
    const node = parent.querySelector<HTMLElement>(
      '[data-part-key="tool:call-first-frame-approval"]',
    )!;
    const hydration = (renderer as unknown as {
      toolApprovalPreviewHydrationStates: WeakMap<
        HTMLElement,
        { hydration: Promise<void> | null }
      >;
    }).toolApprovalPreviewHydrationStates.get(node)!.hydration!;
    await hydration;

    const preview = node.querySelector<HTMLElement>(
      ".systemsculpt-agent-approval-preview",
    )!;
    expect(connectedAtHydrationStart).toEqual([true]);
    expect(preview.hidden).toBe(false);
    expect(preview.querySelector(".systemsculpt-inline-diff")).not.toBeNull();
    renderer.unload();
  });

  it("discards a stale approval preview after a newer tool state commits", async () => {
    const parent = document.body.createDiv();
    const app = new App();
    const renderer = new AgentConversationRenderer(parent, {
      app,
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const approvalTool: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-stale-approval",
      kind: "tool",
      messageId: "assistant-stale-approval",
      callId: "call-stale-approval",
      name: "write",
      location: "vault",
      input: { path: "Projects/Plan.md", content: "# Plan" },
      state: "approval-required",
      approvalId: "approval-stale",
      order: 0,
    };
    const snapshot = (tool: Extract<AgentPart, { kind: "tool" }>): AgentConversationSnapshot => ({
      runId: "run-stale-approval",
      turnId: "user-stale-approval",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-stale-approval",
        role: "assistant",
        partIds: [tool.id],
      }],
      parts: [tool],
    });
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    (app.vault.getAbstractFileByPath as jest.Mock)
      .mockReturnValue(new TFile({ path: "Projects/Plan.md" }));
    (app.vault.read as jest.Mock).mockImplementation(async () => {
      await previewGate;
      return "# Existing plan";
    });

    await renderer.renderActive(
      snapshot(approvalTool),
      presentation("awaiting-approval", true, "Needs approval", snapshot(approvalTool)),
    );
    expect(app.vault.read).toHaveBeenCalledTimes(1);
    const committed = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-tool")!;
    const staleApproval = committed.querySelector<HTMLElement>(
      ".systemsculpt-agent-approval",
    )!;
    const stalePreview = staleApproval.querySelector<HTMLElement>(
      ".systemsculpt-agent-approval-preview",
    )!;
    const staleHydration = (renderer as unknown as {
      toolApprovalPreviewHydrationStates: WeakMap<
        HTMLElement,
        { hydration: Promise<void> | null }
      >;
    }).toolApprovalPreviewHydrationStates.get(committed)!.hydration!;
    expect(stalePreview.hidden).toBe(true);

    const succeededTool: Extract<AgentPart, { kind: "tool" }> = {
      ...approvalTool,
      state: "succeeded",
      approvalId: undefined,
      output: { summary: "Created Plan.md" },
    };
    await renderer.renderActive(
      snapshot(succeededTool),
      presentation("responding", true, "Working", snapshot(succeededTool)),
    );
    expect(parent.querySelector(".systemsculpt-agent-part.is-tool")).toBe(committed);
    expect(committed.classList).toContain("is-succeeded");
    expect(committed.querySelector(".systemsculpt-agent-approval")).toBeNull();

    releasePreview();
    await staleHydration;

    expect(parent.querySelector(".systemsculpt-agent-part.is-tool")).toBe(committed);
    expect(committed.classList).toContain("is-succeeded");
    expect(committed.querySelector(".systemsculpt-agent-approval")).toBeNull();
    expect(committed.querySelector(".systemsculpt-inline-diff")).toBeNull();
    expect(stalePreview.hidden).toBe(true);
    expect(stalePreview.childElementCount).toBe(0);
    renderer.unload();
  });

  it.each(["clear", "conversation", "unload"] as const)(
    "drops a pending approval preview after %s",
    async (retirement) => {
      const parent = document.body.createDiv();
      const app = new App();
      const beginLayoutMutation = jest.fn();
      const renderer = new AgentConversationRenderer(parent, {
        app,
        sourcePath: () => "SystemSculpt/Chats/chat.md",
        beginLayoutMutation,
        onApprove: jest.fn(),
        onOpenArtifact: jest.fn(),
        onCopyArtifactPath: jest.fn(),
      });
      renderer.load();
      let releasePreview!: () => void;
      const previewGate = new Promise<void>((resolve) => {
        releasePreview = resolve;
      });
      (app.vault.getAbstractFileByPath as jest.Mock)
        .mockReturnValue(new TFile({ path: "Projects/Plan.md" }));
      (app.vault.read as jest.Mock).mockImplementation(async () => {
        await previewGate;
        return "# Existing plan";
      });
      const approvalTool: Extract<AgentPart, { kind: "tool" }> = {
        id: `tool-preview-${retirement}`,
        kind: "tool",
        messageId: `assistant-preview-${retirement}`,
        callId: `call-preview-${retirement}`,
        name: "write",
        location: "vault",
        input: { path: "Projects/Plan.md", content: "# Plan" },
        state: "approval-required",
        approvalId: `approval-preview-${retirement}`,
        order: 0,
      };
      const snapshot: AgentConversationSnapshot = {
        runId: `run-preview-${retirement}`,
        turnId: `turn-preview-${retirement}`,
        status: "waiting",
        phase: "waiting",
        waitingReason: "approval",
        messages: [{
          id: approvalTool.messageId,
          role: "assistant",
          partIds: [approvalTool.id],
        }],
        parts: [approvalTool],
      };
      await renderer.renderActive(
        snapshot,
        presentation("awaiting-approval", true, "Needs approval", snapshot),
      );
      const node = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-tool")!;
      const preview = node.querySelector<HTMLElement>(
        ".systemsculpt-agent-approval-preview",
      )!;
      const hydration = (renderer as unknown as {
        toolApprovalPreviewHydrationStates: WeakMap<
          HTMLElement,
          { hydration: Promise<void> | null }
        >;
      }).toolApprovalPreviewHydrationStates.get(node)!.hydration!;

      if (retirement === "clear") {
        renderer.clearActive();
      } else if (retirement === "conversation") {
        const next: AgentConversationSnapshot = {
          runId: "run-preview-next",
          turnId: "turn-preview-next",
          status: "running",
          phase: "working",
          messages: [],
          parts: [],
        };
        await renderer.renderActive(
          next,
          presentation("responding", true, "Working", next),
        );
      } else {
        renderer.unload();
      }
      releasePreview();
      await hydration;

      expect(preview.hidden).toBe(true);
      expect(preview.childElementCount).toBe(0);
      expect(beginLayoutMutation).not.toHaveBeenCalled();
      if (retirement !== "unload") renderer.unload();
    },
  );

  it("guards approval preview hydration before and during its layout commit", async () => {
    const parent = document.body.createDiv();
    const app = new App();
    const renderer = new AgentConversationRenderer(parent, {
      app,
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      beginLayoutMutation: (_control, preview) => {
        preview?.closest(".systemsculpt-agent-approval")?.remove();
        return jest.fn();
      },
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const internals = renderer as unknown as {
      prepareToolApprovalPreviewHydration(
        node: HTMLElement,
        approval: HTMLElement,
        fingerprint: string,
        toolCall: object,
      ): void;
      startToolApprovalPreviewHydration(node: HTMLElement): Promise<void> | null;
      toolApprovalPreviewHydrationStates: WeakMap<
        HTMLElement,
        { hydration: Promise<void> | null }
      >;
    };
    const nodeWithoutPreview = parent.createDiv();
    const approvalWithoutPreview = nodeWithoutPreview.createDiv();
    internals.prepareToolApprovalPreviewHydration(
      nodeWithoutPreview,
      approvalWithoutPreview,
      "missing-preview",
      {},
    );
    expect(internals.startToolApprovalPreviewHydration(nodeWithoutPreview)).toBeNull();

    (app.vault.getAbstractFileByPath as jest.Mock)
      .mockReturnValue(new TFile({ path: "Projects/Plan.md" }));
    (app.vault.read as jest.Mock).mockResolvedValue("# Existing plan");
    const tool: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-preview-layout-guard",
      kind: "tool",
      messageId: "assistant-preview-layout-guard",
      callId: "call-preview-layout-guard",
      name: "write",
      location: "vault",
      input: { path: "Projects/Plan.md", content: "# Plan" },
      state: "approval-required",
      approvalId: "approval-preview-layout-guard",
      order: 0,
    };
    const snapshot: AgentConversationSnapshot = {
      runId: "run-preview-layout-guard",
      turnId: "turn-preview-layout-guard",
      status: "waiting",
      phase: "waiting",
      waitingReason: "approval",
      messages: [{ id: tool.messageId, role: "assistant", partIds: [tool.id] }],
      parts: [tool],
    };
    await renderer.renderActive(
      snapshot,
      presentation("awaiting-approval", true, "Needs approval", snapshot),
    );
    const node = parent.querySelector<HTMLElement>('[data-part-key="tool:call-preview-layout-guard"]')!;
    const preview = node.querySelector<HTMLElement>(".systemsculpt-agent-approval-preview")!;
    const hydration = internals.toolApprovalPreviewHydrationStates.get(node)!.hydration!;
    await hydration;

    expect(preview.isConnected).toBe(false);
    expect(preview.childElementCount).toBe(0);
    renderer.unload();
  });

  it("clears copy feedback and ignores stale asynchronous copy results", async () => {
    jest.useFakeTimers();
    const onCopyText = jest.fn(async () => true);
    const onCopyArtifactPath = jest.fn(async () => true);
    const parent = document.body.createDiv();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath,
      onCopyText,
    });
    renderer.load();
    const internals = renderer as unknown as {
      copyMessage(
        button: HTMLButtonElement,
        text: string,
        subject: "message" | "response",
      ): Promise<void>;
      copyArtifactPath(button: HTMLButtonElement, artifact: object): Promise<void>;
    };

    const messageButton = parent.createEl("button");
    await internals.copyMessage(messageButton, "Copy this", "message");
    expect(messageButton.classList).toContain("is-copied");
    jest.advanceTimersByTime(1_800);
    expect(messageButton.classList).not.toContain("is-copied");
    await internals.copyMessage(messageButton, "Copy this again", "message");
    messageButton.remove();
    jest.advanceTimersByTime(1_800);

    const artifact = {
      id: "artifact-copy-feedback",
      kind: "vault_file",
      title: "Plan.md",
      path: "Plan.md",
    };
    const pathButton = parent.createEl("button");
    await internals.copyArtifactPath(pathButton, artifact);
    expect(pathButton.classList).toContain("is-copied");
    jest.advanceTimersByTime(1_800);
    expect(pathButton.classList).not.toContain("is-copied");
    expect(pathButton.getAttribute("aria-label")).toBe("Copy path");
    await internals.copyArtifactPath(pathButton, artifact);
    pathButton.remove();
    jest.advanceTimersByTime(1_800);

    onCopyArtifactPath.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const failedPathButton = parent.createEl("button");
    await internals.copyArtifactPath(failedPathButton, artifact);
    expect(failedPathButton.classList).toContain("is-copy-failed");
    jest.advanceTimersByTime(3_000);
    expect(failedPathButton.classList).not.toContain("is-copy-failed");

    let releaseMessageCopy!: (copied: boolean) => void;
    onCopyText.mockImplementationOnce(async () => new Promise<boolean>((resolve) => {
      releaseMessageCopy = resolve;
    }));
    const detachedMessageButton = parent.createEl("button");
    const staleMessageCopy = internals.copyMessage(
      detachedMessageButton,
      "Detached copy",
      "response",
    );
    detachedMessageButton.remove();
    releaseMessageCopy(true);
    await staleMessageCopy;
    expect(detachedMessageButton.classList).not.toContain("is-copied");

    let releasePathCopy!: (copied: boolean) => void;
    onCopyArtifactPath.mockImplementationOnce(async () => new Promise<boolean>((resolve) => {
      releasePathCopy = resolve;
    }));
    const supersededPathButton = parent.createEl("button");
    const stalePathCopy = internals.copyArtifactPath(supersededPathButton, artifact);
    supersededPathButton.dataset.copyAttempt = "superseded";
    releasePathCopy(true);
    await stalePathCopy;
    expect(supersededPathButton.classList).not.toContain("is-copied");
    renderer.unload();
  });

  it("falls back to cancelling an inline edit when Escape keyup is lost", async () => {
    jest.useFakeTimers();
    const parent = document.body.createDiv();
    const onCancelMessageEdit = jest.fn();
    const renderer = new AgentConversationRenderer(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onCancelMessageEdit,
    });
    renderer.load();
    renderer.setInlineMessageEdit({
      messageId: "user-keyup-fallback",
      text: "Original request",
      laterMessageCount: 2,
      hasAttachments: false,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: true,
    });
    await renderer.renderHistory([{
      role: "user",
      message_id: "user-keyup-fallback",
      content: "Original request",
    }]);
    const input = parent.querySelector<HTMLTextAreaElement>(
      ".systemsculpt-agent-message-editor-input",
    )!;

    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    expect(onCancelMessageEdit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    expect(onCancelMessageEdit).toHaveBeenCalledTimes(1);
    expect(onCancelMessageEdit).toHaveBeenCalledWith("user-keyup-fallback");
    renderer.unload();
  });
});
