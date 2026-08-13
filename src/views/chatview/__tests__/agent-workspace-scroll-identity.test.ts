/**
 * @jest-environment jsdom
 */

import { App, MarkdownRenderer } from "obsidian";
import type { ChatMessage } from "../../../types";
import type { AgentConversationSnapshot } from "../AgentConversation";
import { AgentWorkspace } from "../AgentWorkspace";

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createWorkspace(): Readonly<{
  host: HTMLElement;
  workspace: AgentWorkspace;
}> {
  const host = document.body.createDiv();
  const workspace = new AgentWorkspace(host, {
    app: new App(),
    sourcePath: () => "SystemSculpt/Chats/chat.md",
    onSubmit: jest.fn(),
    onStop: jest.fn(),
    onAttach: jest.fn(),
    onRemoveAttachment: jest.fn(),
    onApprove: jest.fn(),
    onOpenArtifact: jest.fn(),
    onCopyArtifactPath: jest.fn(),
    onNewChat: jest.fn(),
    onOpenHistory: jest.fn(),
    onOpenSettings: jest.fn(),
  });
  workspace.load();
  return { host, workspace };
}

function completedSnapshot(
  turnId: string,
  assistantMessageId: string,
): AgentConversationSnapshot {
  return {
    runId: `run:${turnId}`,
    turnId,
    status: "completed",
    phase: "complete",
    messages: [{
      id: assistantMessageId,
      role: "assistant",
      partIds: [`text:${assistantMessageId}`],
    }],
    parts: [{
      id: `text:${assistantMessageId}`,
      kind: "text",
      messageId: assistantMessageId,
      state: "complete",
      markdown: "Final answer",
      order: 0,
    }],
  };
}

async function startDelayedStreamingCommit(): Promise<Readonly<{
  gate: Deferred;
  host: HTMLElement;
  part: HTMLElement;
  response: HTMLElement;
  workspace: AgentWorkspace;
}>> {
  const animationFrames: FrameRequestCallback[] = [];
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
  const gate = deferred();
  jest.spyOn(MarkdownRenderer, "render").mockImplementation(async (
    _app,
    markdown,
    staging,
  ) => {
    expect(staging.isConnected).toBe(false);
    await gate.promise;
    staging.createEl("p", { text: String(markdown) });
  });
  const { host, workspace } = createWorkspace();
  const completion = workspace.setAgentSnapshot({
    runId: "run-delayed-markdown",
    turnId: "user-delayed-markdown",
    status: "running",
    phase: "working",
    messages: [{
      id: "assistant-delayed-markdown",
      role: "assistant",
      partIds: ["text-delayed-markdown"],
    }],
    parts: [{
      id: "text-delayed-markdown",
      kind: "text",
      messageId: "assistant-delayed-markdown",
      state: "streaming",
      markdown: "Delayed Markdown",
      order: 0,
    }],
  });
  const frame = animationFrames.shift();
  if (!frame) throw new Error("Expected a transcript animation frame.");
  frame(0);
  await completion;
  const response = host.querySelector<HTMLElement>(
    '.systemsculpt-agent-active-run .systemsculpt-agent-turn[data-turn-id="user-delayed-markdown"]',
  );
  const part = response?.querySelector<HTMLElement>(
    '.systemsculpt-agent-part[data-part-key="text-delayed-markdown"]',
  );
  if (!response || !part) throw new Error("Expected the delayed streaming response.");
  return { gate, host, part, response, workspace };
}

describe("AgentWorkspace response scroll identity", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("moves one turn anchor from the active response to its durable response", async () => {
    const { host, workspace } = createWorkspace();
    const turnId = "user-response-identity";
    const assistantMessageId = "assistant-response-identity";
    const user: ChatMessage = {
      role: "user",
      message_id: turnId,
      content: "Answer this.",
    };

    await workspace.setHistory([user]);
    const userRow = host.querySelector<HTMLElement>(
      `.systemsculpt-agent-history .systemsculpt-agent-turn.is-user[data-message-id="${turnId}"]`,
    )!;
    expect(userRow.dataset.agentRowId).toBe(`message:${turnId}`);
    await workspace.setAgentSnapshot(completedSnapshot(turnId, assistantMessageId));

    const activeResponse = host.querySelector<HTMLElement>(
      `.systemsculpt-agent-active-run .systemsculpt-agent-turn[data-turn-id="${turnId}"]`,
    )!;
    expect(activeResponse.dataset.messageId).toBe(turnId);
    expect(activeResponse.dataset.agentRowId).toBe(`response:${turnId}`);
    expect((workspace as any).registeredRows.get(`message:${turnId}`))
      .toBe(userRow);
    expect((workspace as any).registeredRows.get(`response:${turnId}`))
      .toBe(activeResponse);

    await expect(workspace.settleCompletedRun([
      user,
      {
        role: "assistant",
        message_id: assistantMessageId,
        content: "Final answer",
      },
    ])).resolves.toBeUndefined();

    const durableResponse = host.querySelector<HTMLElement>(
      `.systemsculpt-agent-history .systemsculpt-agent-turn.is-assistant[data-turn-id="${turnId}"]`,
    )!;
    expect(durableResponse).toBe(activeResponse);
    expect(durableResponse.dataset.messageId).toBe(assistantMessageId);
    expect(durableResponse.dataset.agentRowId).toBe(`response:${turnId}`);
    expect((workspace as any).registeredRows.get(`message:${turnId}`))
      .toBe(userRow);
    expect((workspace as any).registeredRows.get(`response:${turnId}`))
      .toBe(durableResponse);
    if (durableResponse !== activeResponse) {
      expect(activeResponse.dataset.agentRowId).toBeUndefined();
    }
    workspace.unload();
  });

  it("keeps the live text part mounted when the completed response becomes durable", async () => {
    const { host, workspace } = createWorkspace();
    const turnId = "user-adopt-text";
    const assistantMessageId = "assistant-adopt-text";
    const user: ChatMessage = {
      role: "user",
      message_id: turnId,
      content: "Keep this DOM.",
    };
    const terminal = completedSnapshot(turnId, assistantMessageId);
    await workspace.setHistory([user]);
    await workspace.setAgentSnapshot(terminal);
    const activeResponse = host.querySelector<HTMLElement>(
      `.systemsculpt-agent-active-run .systemsculpt-agent-turn[data-turn-id="${turnId}"]`,
    )!;
    const activeTextPart = activeResponse.querySelector<HTMLElement>(
      `.systemsculpt-agent-part[data-part-key="text:text:${assistantMessageId}"]`,
    ) ?? activeResponse.querySelector<HTMLElement>(".systemsculpt-agent-part.is-text")!;
    const activeTextNode = activeTextPart.firstChild;

    await workspace.settleCompletedRun([
      user,
      {
        role: "assistant",
        message_id: assistantMessageId,
        content: "Final answer",
        messageParts: [{
          id: `text:${assistantMessageId}`,
          type: "content",
          timestamp: 1,
          data: "Final answer",
        }],
      },
    ]);

    const durableResponse = host.querySelector<HTMLElement>(
      `.systemsculpt-agent-history .systemsculpt-agent-turn.is-assistant[data-turn-id="${turnId}"]`,
    )!;
    const durableTextPart = durableResponse.querySelector<HTMLElement>(
      ".systemsculpt-agent-part.is-text",
    )!;
    expect(durableResponse).toBe(activeResponse);
    expect(durableTextPart).toBe(activeTextPart);
    expect(durableTextPart.firstChild).toBe(activeTextNode);
    expect(host.querySelector(".systemsculpt-agent-active-run")?.childElementCount)
      .toBe(0);
    workspace.unload();
  });

  it("keeps a manual reader at the same response offset during settlement", async () => {
    const { host, workspace } = createWorkspace();
    const turnId = "user-response-anchor";
    const assistantMessageId = "assistant-response-anchor";
    const user: ChatMessage = {
      role: "user",
      message_id: turnId,
      content: "Keep my place.",
    };
    await workspace.setHistory([user]);
    await workspace.setAgentSnapshot(completedSnapshot(turnId, assistantMessageId));

    const activeResponse = host.querySelector<HTMLElement>(
      `.systemsculpt-agent-active-run .systemsculpt-agent-turn[data-turn-id="${turnId}"]`,
    )!;
    Object.defineProperties(activeResponse, {
      offsetTop: { configurable: true, get: () => 500 },
      offsetHeight: { configurable: true, get: () => 200 },
    });

    const viewportState = {
      scrollTop: 550,
      scrollHeight: 1_000,
      clientHeight: 400,
    };
    const scrollCalls: ScrollToOptions[] = [];
    Object.defineProperties(workspace.viewport, {
      scrollTop: {
        configurable: true,
        get: () => viewportState.scrollTop,
        set: (value: number) => { viewportState.scrollTop = value; },
      },
      scrollHeight: { configurable: true, get: () => viewportState.scrollHeight },
      clientHeight: { configurable: true, get: () => viewportState.clientHeight },
    });
    workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
      viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
      scrollCalls.push(options);
      workspace.viewport.dispatchEvent(new Event("scroll"));
    }) as typeof workspace.viewport.scrollTo;
    workspace.viewport.dispatchEvent(new Event("scroll"));
    expect((workspace as any).scroller.getMode()).toBe("manual");

    const originalRenderHistory = workspace.renderer.renderHistory.bind(workspace.renderer);
    jest.spyOn(workspace.renderer, "renderHistory").mockImplementation(async (messages) => {
      await originalRenderHistory(messages);
      const durableResponse = host.querySelector<HTMLElement>(
        `.systemsculpt-agent-history .systemsculpt-agent-turn.is-assistant[data-turn-id="${turnId}"]`,
      )!;
      Object.defineProperties(durableResponse, {
        offsetTop: { configurable: true, get: () => 520 },
        offsetHeight: { configurable: true, get: () => 200 },
      });
    });

    await workspace.settleCompletedRun([
      user,
      {
        role: "assistant",
        message_id: assistantMessageId,
        content: "Final answer",
      },
    ]);

    expect(viewportState.scrollTop).toBe(570);
    expect(scrollCalls.at(-1)).toEqual(expect.objectContaining({
      top: 570,
      behavior: "auto",
    }));
    expect((workspace as any).scroller.getMode()).toBe("manual");
    workspace.unload();
  });

  it("restores a manual anchor around a parser commit that finishes after the transcript frame", async () => {
    const { gate, part, response, workspace } = await startDelayedStreamingCommit();
    const viewportState = { scrollTop: 500 };
    const parsed = (): boolean => part.querySelector("p") !== null;
    Object.defineProperties(response, {
      offsetTop: {
        configurable: true,
        get: () => parsed() ? 650 : 500,
      },
      offsetHeight: { configurable: true, get: () => 300 },
    });
    Object.defineProperties(workspace.viewport, {
      scrollTop: {
        configurable: true,
        get: () => viewportState.scrollTop,
        set: (value: number) => { viewportState.scrollTop = value; },
      },
      scrollHeight: {
        configurable: true,
        get: () => parsed() ? 1_550 : 1_400,
      },
      clientHeight: { configurable: true, get: () => 400 },
    });
    workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
      viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
      workspace.viewport.dispatchEvent(new Event("scroll"));
    }) as typeof workspace.viewport.scrollTo;
    workspace.viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -120,
    }));
    workspace.viewport.dispatchEvent(new Event("scroll"));
    expect((workspace as any).scroller.getMode()).toBe("manual");

    const beginLayoutMutation = jest.spyOn(
      (workspace as any).scroller,
      "beginLayoutMutation",
    );
    const parserCommit = (workspace.renderer as any).liveMarkdown.flush(part);
    gate.resolve();
    await parserCommit;

    expect(beginLayoutMutation).toHaveBeenCalledTimes(1);
    expect(part.textContent).toBe("Delayed Markdown");
    expect(viewportState.scrollTop).toBe(650);
    expect((workspace as any).scroller.getMode()).toBe("manual");
    workspace.unload();
  });

  it("does not scan long history for a Markdown commit below a manual reader", async () => {
    const { gate, host, part, response, workspace } = await startDelayedStreamingCommit();
    const historyRoot = host.querySelector<HTMLElement>(".systemsculpt-agent-history")!;
    let historyGeometryReads = 0;
    for (let index = 0; index < 40; index += 1) {
      const row = historyRoot.createDiv({
        cls: "systemsculpt-agent-turn is-user",
        attr: { "data-message-id": `history-markdown-${String(index)}` },
      });
      Object.defineProperties(row, {
        offsetTop: {
          configurable: true,
          get: () => {
            historyGeometryReads += 1;
            return index * 100;
          },
        },
        offsetHeight: {
          configurable: true,
          get: () => {
            historyGeometryReads += 1;
            return 100;
          },
        },
      });
    }
    Object.defineProperties(response, {
      offsetTop: {
        configurable: true,
        get: () => {
          historyGeometryReads += 1;
          return 4_000;
        },
      },
      offsetHeight: {
        configurable: true,
        get: () => {
          historyGeometryReads += 1;
          return 300;
        },
      },
    });
    (workspace as any).syncRows();
    historyGeometryReads = 0;

    const viewportState = {
      scrollTop: 500,
      scrollHeight: 5_000,
      clientHeight: 400,
    };
    Object.defineProperties(workspace.viewport, {
      scrollTop: {
        configurable: true,
        get: () => viewportState.scrollTop,
        set: (value: number) => { viewportState.scrollTop = value; },
      },
      scrollHeight: { configurable: true, get: () => viewportState.scrollHeight },
      clientHeight: { configurable: true, get: () => viewportState.clientHeight },
    });
    workspace.viewport.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 500,
      bottom: 400,
      left: 0,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    });
    part.getBoundingClientRect = () => ({
      x: 0,
      y: 401,
      top: 401,
      right: 500,
      bottom: 421,
      left: 0,
      width: 500,
      height: 20,
      toJSON: () => ({}),
    });
    workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
      viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
      workspace.viewport.dispatchEvent(new Event("scroll"));
    }) as typeof workspace.viewport.scrollTo;
    workspace.viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -120,
    }));
    workspace.viewport.dispatchEvent(new Event("scroll"));
    expect((workspace as any).scroller.getMode()).toBe("manual");

    const beginLayoutMutation = jest.spyOn(
      (workspace as any).scroller,
      "beginLayoutMutation",
    );
    const parserCommit = (workspace.renderer as any).liveMarkdown.flush(part);
    gate.resolve();
    await parserCommit;

    expect(beginLayoutMutation).toHaveBeenCalledTimes(1);
    expect(beginLayoutMutation).toHaveBeenCalledWith(part);
    expect(historyGeometryReads).toBe(0);
    expect(viewportState.scrollTop).toBe(500);
    expect((workspace as any).scroller.getMode()).toBe("manual");
    workspace.unload();
  });

  it("keeps end follow pinned when a parser commit finishes after the transcript frame", async () => {
    const { gate, part, workspace } = await startDelayedStreamingCommit();
    const viewportState = { scrollTop: 1_000 };
    const parsed = (): boolean => part.querySelector("p") !== null;
    Object.defineProperties(workspace.viewport, {
      scrollTop: {
        configurable: true,
        get: () => viewportState.scrollTop,
        set: (value: number) => { viewportState.scrollTop = value; },
      },
      scrollHeight: {
        configurable: true,
        get: () => parsed() ? 1_700 : 1_400,
      },
      clientHeight: { configurable: true, get: () => 400 },
    });
    workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
      viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
      workspace.viewport.dispatchEvent(new Event("scroll"));
    }) as typeof workspace.viewport.scrollTo;
    (workspace as any).scroller.scrollToEnd({ smooth: false });
    expect((workspace as any).scroller.getMode()).toBe("end");

    const beginLayoutMutation = jest.spyOn(
      (workspace as any).scroller,
      "beginLayoutMutation",
    );
    const parserCommit = (workspace.renderer as any).liveMarkdown.flush(part);
    gate.resolve();
    await parserCommit;

    expect(beginLayoutMutation).toHaveBeenCalledTimes(1);
    expect(part.textContent).toBe("Delayed Markdown");
    expect(viewportState.scrollTop).toBe(1_300);
    expect((workspace as any).scroller.getMode()).toBe("end");
    workspace.unload();
  });

  it.each(["click", "enter", "space"] as const)(
    "preserves the activated disclosure when its layout changes by %s",
    (activation) => {
      const animationFrames: FrameRequestCallback[] = [];
      jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });
      jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
      const { workspace } = createWorkspace();
      const disclosureRow = workspace.renderer.element.createDiv({
        cls: "systemsculpt-agent-turn is-assistant",
        attr: {
          "data-message-id": "assistant-disclosure",
          "data-turn-id": "user-disclosure",
        },
      });
      const details = disclosureRow.createEl("details");
      const summary = details.createEl("summary", { text: "Worked" });
      const visibleRow = workspace.renderer.element.createDiv({
        cls: "systemsculpt-agent-turn is-user",
        attr: { "data-message-id": "user-visible" },
      });
      const layout = { visibleTop: 500 };
      Object.defineProperties(disclosureRow, {
        offsetTop: { configurable: true, get: () => 0 },
        offsetHeight: { configurable: true, get: () => 300 },
      });
      Object.defineProperties(visibleRow, {
        offsetTop: { configurable: true, get: () => layout.visibleTop },
        offsetHeight: { configurable: true, get: () => 200 },
      });
      (workspace as any).syncRows();

      const viewportState = {
        scrollTop: 500,
        scrollHeight: 1_400,
        clientHeight: 400,
      };
      Object.defineProperties(workspace.viewport, {
        scrollTop: {
          configurable: true,
          get: () => viewportState.scrollTop,
          set: (value: number) => { viewportState.scrollTop = value; },
        },
        scrollHeight: { configurable: true, get: () => viewportState.scrollHeight },
        clientHeight: { configurable: true, get: () => viewportState.clientHeight },
      });
      workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
        viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
        workspace.viewport.dispatchEvent(new Event("scroll"));
      }) as typeof workspace.viewport.scrollTo;
      summary.getBoundingClientRect = () => {
        const top = 550 - viewportState.scrollTop;
        return {
          x: 0,
          y: top,
          top,
          right: 100,
          bottom: top + 30,
          left: 0,
          width: 100,
          height: 30,
          toJSON: () => ({}),
        };
      };
      workspace.viewport.dispatchEvent(new Event("scroll"));
      expect((workspace as any).scroller.getMode()).toBe("manual");

      if (activation === "click") {
        summary.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          button: 0,
        }));
      } else if (activation === "enter") {
        summary.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
        }));
      } else {
        summary.dispatchEvent(new KeyboardEvent("keyup", {
          bubbles: true,
          key: " ",
        }));
      }
      layout.visibleTop = 650;
      viewportState.scrollHeight = 1_550;
      details.dispatchEvent(new Event("toggle"));
      expect(animationFrames).toHaveLength(1);
      animationFrames[0](0);

      expect(viewportState.scrollTop).toBe(500);
      expect(summary.getBoundingClientRect().top).toBe(50);
      expect((workspace as any).scroller.getMode()).toBe("manual");
      workspace.unload();
    },
  );

  it("keeps an overflow control fixed when it opens at the live edge", () => {
    const { workspace } = createWorkspace();
    const response = workspace.renderer.element.createDiv({
      cls: "systemsculpt-agent-turn is-assistant",
      attr: {
        "data-message-id": "assistant-overflow",
        "data-turn-id": "user-overflow",
      },
    });
    const overflow = (workspace.renderer as any).createActivityOverflow(
      response,
      2,
    ).element as HTMLButtonElement;
    Object.defineProperties(response, {
      offsetTop: { configurable: true, get: () => 400 },
      offsetHeight: { configurable: true, get: () => 500 },
    });
    (workspace as any).syncRows();

    const viewportState = {
      scrollTop: 600,
      clientHeight: 400,
    };
    Object.defineProperties(workspace.viewport, {
      scrollTop: {
        configurable: true,
        get: () => viewportState.scrollTop,
        set: (value: number) => { viewportState.scrollTop = value; },
      },
      scrollHeight: {
        configurable: true,
        get: () => overflow.getAttribute("aria-expanded") === "true" ? 1_400 : 1_000,
      },
      clientHeight: { configurable: true, get: () => viewportState.clientHeight },
    });
    workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
      viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
      workspace.viewport.dispatchEvent(new Event("scroll"));
    }) as typeof workspace.viewport.scrollTo;
    overflow.getBoundingClientRect = () => {
      const top = 850 - viewportState.scrollTop;
      return {
        x: 0,
        y: top,
        top,
        right: 100,
        bottom: top + 30,
        left: 0,
        width: 100,
        height: 30,
        toJSON: () => ({}),
      };
    };

    overflow.click();

    expect(overflow.getAttribute("aria-expanded")).toBe("true");
    expect(viewportState.scrollTop).toBe(600);
    expect(overflow.getBoundingClientRect().top).toBe(250);
    expect((workspace as any).scroller.getMode()).toBe("manual");

    overflow.click();
    expect(overflow.getAttribute("aria-expanded")).toBe("false");
    expect(viewportState.scrollTop).toBe(600);
    expect(overflow.getBoundingClientRect().top).toBe(250);
    workspace.unload();
  });

  it("coalesces a protocol burst into one animation-frame transcript render", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { workspace } = createWorkspace();
    const renderActive = jest.spyOn(workspace.renderer, "renderActive")
      .mockResolvedValue();
    const snapshot = (phase: "submitted" | "thinking" | "working"):
    AgentConversationSnapshot => ({
      runId: "run-frame-burst",
      turnId: "user-frame-burst",
      status: "running",
      phase,
      messages: [],
      parts: [],
    });

    const snapshots = Array.from({ length: 50 }, (_, index) =>
      snapshot(index === 49 ? "working" : index === 0 ? "submitted" : "thinking"));
    const completions = snapshots.map((item) => workspace.setAgentSnapshot(item));

    expect(animationFrames).toHaveLength(1);
    expect(renderActive).not.toHaveBeenCalled();
    animationFrames[0](0);
    await Promise.all(completions);

    expect(renderActive).toHaveBeenCalledTimes(1);
    expect(renderActive).toHaveBeenCalledWith(
      snapshot("working"),
      expect.objectContaining({ busy: true, composerRunning: true }),
    );
    workspace.unload();
  });

  it("corrects the end once after a snapshot and updates its busy state", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { workspace } = createWorkspace();
    const viewportState = {
      scrollTop: 600,
      scrollHeight: 1_000,
      clientHeight: 400,
    };
    const scrollCalls: ScrollToOptions[] = [];
    Object.defineProperties(workspace.viewport, {
      scrollTop: {
        configurable: true,
        get: () => viewportState.scrollTop,
        set: (value: number) => { viewportState.scrollTop = value; },
      },
      scrollHeight: { configurable: true, get: () => viewportState.scrollHeight },
      clientHeight: { configurable: true, get: () => viewportState.clientHeight },
    });
    workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
      viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
      scrollCalls.push(options);
      workspace.viewport.dispatchEvent(new Event("scroll"));
    }) as typeof workspace.viewport.scrollTo;
    jest.spyOn(workspace.renderer, "renderActive").mockImplementation(async () => {
      viewportState.scrollHeight = 1_200;
    });
    const completion = workspace.setAgentSnapshot({
      runId: "run-single-snapshot-correction",
      turnId: "user-single-snapshot-correction",
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    });
    animationFrames.shift()!(0);
    await completion;

    expect(scrollCalls).toEqual([{ top: 800, behavior: "auto" }]);
    expect(workspace.renderer.element.getAttribute("aria-busy")).toBe("true");
    workspace.unload();
  });

  it("corrects the end once during settlement and clears its busy state", async () => {
    const { workspace } = createWorkspace();
    const viewportState = {
      scrollTop: 600,
      scrollHeight: 1_000,
      clientHeight: 400,
    };
    const scrollCalls: ScrollToOptions[] = [];
    Object.defineProperties(workspace.viewport, {
      scrollTop: {
        configurable: true,
        get: () => viewportState.scrollTop,
        set: (value: number) => { viewportState.scrollTop = value; },
      },
      scrollHeight: { configurable: true, get: () => viewportState.scrollHeight },
      clientHeight: { configurable: true, get: () => viewportState.clientHeight },
    });
    workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
      viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
      scrollCalls.push(options);
      workspace.viewport.dispatchEvent(new Event("scroll"));
    }) as typeof workspace.viewport.scrollTo;
    const scroller = (workspace as any).scroller;
    scroller.setStreaming(true);
    jest.spyOn(workspace.renderer, "settleHistory").mockImplementation(async () => {
      viewportState.scrollHeight = 1_300;
    });
    (workspace as any).snapshot = completedSnapshot(
      "user-single-settlement-correction",
      "assistant-single-settlement-correction",
    );

    await workspace.settleCompletedRun([]);

    expect(scrollCalls).toEqual([{ top: 900, behavior: "auto" }]);
    expect(workspace.renderer.element.hasAttribute("aria-busy")).toBe(false);
    workspace.unload();
  });

  it("keeps only the newest pending frame while a visual render is in flight", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { workspace } = createWorkspace();
    let releaseFirstRender!: () => void;
    const firstRenderBlocked = new Promise<void>((resolve) => {
      releaseFirstRender = resolve;
    });
    let markFirstRenderStarted!: () => void;
    const firstRenderStarted = new Promise<void>((resolve) => {
      markFirstRenderStarted = resolve;
    });
    const renderedPhases: string[] = [];
    jest.spyOn(workspace.renderer, "renderActive").mockImplementation(async (snapshot) => {
      renderedPhases.push(snapshot.phase ?? "none");
      if (renderedPhases.length === 1) {
        markFirstRenderStarted();
        await firstRenderBlocked;
      }
    });
    const snapshot = (phase: "submitted" | "thinking" | "working"):
    AgentConversationSnapshot => ({
      runId: "run-in-flight-frame",
      turnId: "user-in-flight-frame",
      status: "running",
      phase,
      messages: [],
      parts: [],
    });

    const firstCompletion = workspace.setAgentSnapshot(snapshot("submitted"));
    animationFrames[0](0);
    await firstRenderStarted;
    const pendingSnapshots = Array.from({ length: 30 }, (_, index) =>
      snapshot(index === 29 ? "working" : "thinking"));
    const pendingCompletions = pendingSnapshots.map((item) =>
      workspace.setAgentSnapshot(item));

    expect(animationFrames).toHaveLength(1);
    expect(renderedPhases).toEqual(["submitted"]);
    releaseFirstRender();
    await firstCompletion;
    for (let index = 0; index < 10 && animationFrames.length < 2; index += 1) {
      await Promise.resolve();
    }
    expect(animationFrames).toHaveLength(2);
    expect(renderedPhases).toEqual(["submitted"]);
    animationFrames[1](16);
    await Promise.all(pendingCompletions);

    expect(renderedPhases).toEqual(["submitted", "working"]);
    workspace.unload();
  });

  it("does not rescan stable history rows for token-only frames", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { workspace } = createWorkspace();
    const syncRows = jest.spyOn(workspace as any, "syncRows");
    const snapshot = (markdown: string): AgentConversationSnapshot => ({
      runId: "run-token-sync",
      turnId: "user-token-sync",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-token-sync",
        role: "assistant",
        partIds: ["text-token-sync"],
      }],
      parts: [{
        id: "text-token-sync",
        kind: "text",
        messageId: "assistant-token-sync",
        state: "streaming",
        markdown,
        order: 0,
      }],
    });

    const first = workspace.setAgentSnapshot(snapshot("One"));
    animationFrames.shift()!(0);
    await first;
    expect(syncRows).toHaveBeenCalledTimes(1);

    const second = workspace.setAgentSnapshot(snapshot("One two"));
    for (let index = 0; index < 10 && animationFrames.length === 0; index += 1) {
      await Promise.resolve();
    }
    animationFrames.shift()!(16);
    await second;
    expect(syncRows).toHaveBeenCalledTimes(1);
    workspace.unload();
  });

  it("does not read long-history geometry for an active snapshot below the viewport", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { host, workspace } = createWorkspace();
    const viewportState = {
      scrollTop: 500,
      scrollHeight: 6_000,
      clientHeight: 400,
    };
    const historyRoot = host.querySelector<HTMLElement>(".systemsculpt-agent-history")!;
    let historyGeometryReads = 0;
    for (let index = 0; index < 50; index += 1) {
      const row = historyRoot.createDiv({
        cls: "systemsculpt-agent-turn is-user",
        attr: { "data-message-id": `history-snapshot-${String(index)}` },
      });
      Object.defineProperties(row, {
        offsetTop: {
          configurable: true,
          get: () => {
            historyGeometryReads += 1;
            return index * 100;
          },
        },
        offsetHeight: {
          configurable: true,
          get: () => {
            historyGeometryReads += 1;
            return 100;
          },
        },
      });
    }
    (workspace as any).syncRows();
    historyGeometryReads = 0;

    Object.defineProperties(workspace.viewport, {
      scrollTop: {
        configurable: true,
        get: () => viewportState.scrollTop,
        set: (value: number) => { viewportState.scrollTop = value; },
      },
      scrollHeight: { configurable: true, get: () => viewportState.scrollHeight },
      clientHeight: { configurable: true, get: () => viewportState.clientHeight },
    });
    workspace.viewport.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 500,
      bottom: 400,
      left: 0,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    });
    const activeRun = host.querySelector<HTMLElement>(".systemsculpt-agent-active-run")!;
    activeRun.getBoundingClientRect = () => ({
      x: 0,
      y: 401,
      top: 401,
      right: 500,
      bottom: 421,
      left: 0,
      width: 500,
      height: 20,
      toJSON: () => ({}),
    });
    workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
      viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
      workspace.viewport.dispatchEvent(new Event("scroll"));
    }) as typeof workspace.viewport.scrollTo;
    workspace.viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -120,
    }));
    workspace.viewport.dispatchEvent(new Event("scroll"));
    expect((workspace as any).scroller.getMode()).toBe("manual");
    jest.spyOn(workspace.renderer, "renderActive").mockResolvedValue();

    const completion = workspace.setAgentSnapshot({
      runId: "run-long-history-fast-path",
      turnId: "user-long-history-fast-path",
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    });
    animationFrames.shift()!(0);
    await completion;

    expect(historyGeometryReads).toBe(0);
    expect(viewportState.scrollTop).toBe(500);
    expect((workspace as any).scroller.getMode()).toBe("manual");
    workspace.unload();
  });

  it("anchors an intersecting active snapshot without reading long-history geometry", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { host, workspace } = createWorkspace();
    const viewportState = {
      scrollTop: 500,
      scrollHeight: 6_000,
      clientHeight: 400,
    };
    const historyRoot = host.querySelector<HTMLElement>(".systemsculpt-agent-history")!;
    let historyGeometryReads = 0;
    for (let index = 0; index < 50; index += 1) {
      const row = historyRoot.createDiv({
        cls: "systemsculpt-agent-turn is-user",
        attr: { "data-message-id": `history-active-${String(index)}` },
      });
      Object.defineProperties(row, {
        offsetTop: {
          configurable: true,
          get: () => {
            historyGeometryReads += 1;
            return index * 100;
          },
        },
        offsetHeight: {
          configurable: true,
          get: () => {
            historyGeometryReads += 1;
            return 100;
          },
        },
      });
    }
    const activeRun = host.querySelector<HTMLElement>(".systemsculpt-agent-active-run")!;
    const response = activeRun.createDiv({
      cls: "systemsculpt-agent-turn is-assistant",
      attr: { "data-turn-id": "user-active-anchor" },
    });
    const part = response.createDiv({
      cls: "systemsculpt-agent-part is-text",
      attr: { "data-part-key": "text-active-anchor" },
    });
    let partTop = 600;
    Object.defineProperties(response, {
      offsetTop: { configurable: true, get: () => 450 },
      offsetHeight: { configurable: true, get: () => 600 },
    });
    part.getBoundingClientRect = () => ({
      x: 0,
      y: partTop - viewportState.scrollTop,
      top: partTop - viewportState.scrollTop,
      right: 500,
      bottom: partTop - viewportState.scrollTop + 80,
      left: 0,
      width: 500,
      height: 80,
      toJSON: () => ({}),
    });
    (workspace as any).syncRows();
    historyGeometryReads = 0;

    Object.defineProperties(workspace.viewport, {
      scrollTop: {
        configurable: true,
        get: () => viewportState.scrollTop,
        set: (value: number) => { viewportState.scrollTop = value; },
      },
      scrollHeight: { configurable: true, get: () => viewportState.scrollHeight },
      clientHeight: { configurable: true, get: () => viewportState.clientHeight },
    });
    workspace.viewport.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      right: 500,
      bottom: 400,
      left: 0,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    });
    activeRun.getBoundingClientRect = () => ({
      x: 0,
      y: 50,
      top: 50,
      right: 500,
      bottom: 350,
      left: 0,
      width: 500,
      height: 300,
      toJSON: () => ({}),
    });
    workspace.viewport.scrollTo = ((options: ScrollToOptions) => {
      viewportState.scrollTop = Number(options.top ?? viewportState.scrollTop);
      workspace.viewport.dispatchEvent(new Event("scroll"));
    }) as typeof workspace.viewport.scrollTo;
    workspace.viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -120,
    }));
    workspace.viewport.dispatchEvent(new Event("scroll"));
    expect((workspace as any).scroller.getMode()).toBe("manual");
    jest.spyOn(workspace.renderer, "renderActive").mockImplementation(async () => {
      partTop = 350;
    });

    const completion = workspace.setAgentSnapshot({
      runId: "run-active-anchor",
      turnId: "user-active-anchor",
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    });
    animationFrames.shift()!(0);
    await completion;

    expect(historyGeometryReads).toBe(0);
    expect(viewportState.scrollTop).toBe(250);
    expect(part.getBoundingClientRect().top).toBe(100);
    expect((workspace as any).scroller.getMode()).toBe("manual");
    workspace.unload();
  });

  it("flushes a terminal frame before settlement without waiting for stale animation timing", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = jest.spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { host, workspace } = createWorkspace();
    const turnId = "user-terminal-frame";
    const assistantMessageId = "assistant-terminal-frame";
    const user: ChatMessage = {
      role: "user",
      message_id: turnId,
      content: "Finish now.",
    };
    await workspace.setHistory([user]);
    workspace.setRunPending(true, turnId);
    const terminal = completedSnapshot(turnId, assistantMessageId);
    const terminalRender = workspace.setAgentSnapshot(terminal);

    expect(animationFrames).toHaveLength(1);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')?.hidden)
      .toBe(false);
    expect(host.querySelector('[aria-label="Send message"]')).toBeNull();

    const settlement = workspace.settleCompletedRun([
      user,
      {
        role: "assistant",
        message_id: assistantMessageId,
        content: "Final answer",
      },
    ]);
    await Promise.all([terminalRender, settlement]);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')?.hidden)
      .toBe(true);
    expect(host.querySelector('[aria-label="Send message"]')).not.toBeNull();
    expect(host.textContent?.match(/Final answer/g)).toHaveLength(1);
    expect(host.querySelector(".systemsculpt-agent-active-run")?.childElementCount)
      .toBe(0);
    workspace.unload();
  });

  it("cancels a queued transcript frame and resolves its waiter on unload", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = jest.spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return 17;
    });
    const { workspace } = createWorkspace();
    const renderActive = jest.spyOn(workspace.renderer, "renderActive");
    const completion = workspace.setAgentSnapshot({
      runId: "run-unload-frame",
      turnId: "user-unload-frame",
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    });

    expect(animationFrames).toHaveLength(1);
    workspace.unload();
    await expect(completion).resolves.toBeUndefined();
    animationFrames[0](0);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);
    expect(renderActive).not.toHaveBeenCalled();
  });

  it("waits for the durable user row before starting end follow", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { workspace } = createWorkspace();
    const notifyTurnStarted = jest.spyOn((workspace as any).scroller, "notifyTurnStarted");
    const turnId = "user-follow-boundary";
    const snapshot: AgentConversationSnapshot = {
      runId: "run-follow-boundary",
      turnId,
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    };

    const activeRender = workspace.setAgentSnapshot(snapshot);
    animationFrames.shift()!(0);
    await activeRender;
    expect((workspace as any).registeredRows.has(`response:${turnId}`)).toBe(true);
    expect((workspace as any).registeredRows.has(`message:${turnId}`)).toBe(false);
    expect(notifyTurnStarted).not.toHaveBeenCalled();

    await workspace.setHistory([{
      role: "user",
      message_id: turnId,
      content: "Start only after this row exists.",
    }]);
    expect((workspace as any).registeredRows.has(`message:${turnId}`)).toBe(true);
    expect((workspace as any).registeredRows.has(`response:${turnId}`)).toBe(true);
    expect(notifyTurnStarted).toHaveBeenCalledTimes(1);
    workspace.unload();
  });

  it("opts an explicit submission into prompt anchoring after both turn rows exist", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { workspace } = createWorkspace();
    const notifyTurnStarted = jest.spyOn((workspace as any).scroller, "notifyTurnStarted");
    const clearSubmittedPromptAnchor = jest.spyOn(
      (workspace as any).scroller,
      "clearSubmittedPromptAnchor",
    );
    const turnId = "user-submitted-prompt-anchor";
    const snapshot: AgentConversationSnapshot = {
      runId: "run-submitted-prompt-anchor",
      turnId,
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    };

    const activeRender = workspace.setAgentSnapshot(snapshot);
    animationFrames.shift()!(0);
    await activeRender;
    workspace.setRunPending(true, turnId, { anchorSubmittedPrompt: true });
    expect(notifyTurnStarted).not.toHaveBeenCalled();

    await workspace.setHistory([{
      role: "user",
      message_id: turnId,
      content: "Keep this prompt near the top.",
    }]);

    expect(notifyTurnStarted).toHaveBeenCalledWith({
      submittedPromptRowId: `message:${turnId}`,
      submittedPromptOffset: 16,
    });

    await workspace.setHistory([]);
    expect(clearSubmittedPromptAnchor).toHaveBeenCalledTimes(1);
    workspace.unload();
  });
});
