/**
 * @jest-environment node
 */

import { MessageType } from "agents/chat";
import { WebSocketChatTransport } from "agents/chat/react";
import type { UIMessage } from "ai";
import { ThinAgentBridge } from "../../src/views/chatview/thin/ThinAgentBridge";
import type {
  ThinAgentLifecycleInput,
} from "../../src/views/chatview/thin/ThinAgentLifecycle";

const CONVERSATION_ID = "conversation_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_ID = "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

class NativeAgent extends EventTarget {
  public readonly sent: Record<string, unknown>[] = [];

  public send = (value: string): boolean => {
    this.sent.push(JSON.parse(value) as Record<string, unknown>);
    return true;
  };

  public message(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify(frame),
    }));
  }

  public close(): void {}
}

class NativeBridgeConnection {
  public cancelCalls = 0;
  public readonly lifecycleEvents: ThinAgentLifecycleInput[] = [];
  private readonly activeRequestIds = new Set<string>();
  private readonly transport: WebSocketChatTransport;

  constructor(
    public readonly agent: NativeAgent,
    private readonly history: UIMessage[],
  ) {
    this.transport = new WebSocketChatTransport({
      agent: agent as any,
      activeRequestIds: this.activeRequestIds,
      cancelOnClientAbort: false,
    });
  }

  public async prepare(): Promise<any> {
    return {
      messages: this.history,
      inputLimits: {
        imageMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        maxContentBlocksPerMessage: 16,
        maxImagesPerTurn: 6,
        maxImageBytes: 6 * 1024 * 1024,
        maxTotalImageBytes: 16 * 1024 * 1024,
        maxTextBytesPerBlock: 1024 * 1024,
        maxTotalTextBytes: 2 * 1024 * 1024,
        maxDocumentBytes: 25 * 1024 * 1024,
      },
    };
  }

  public connect(): void {}
  public whenReady(): Promise<void> { return Promise.resolve(); }
  public chatTransport(): WebSocketChatTransport { return this.transport; }
  public agentClient(): any { return this.agent; }
  public disconnect(): void { this.transport.resetResumeState(); }
  public close(): void { this.transport.resetResumeState(); }
  public recordLifecycle(input: ThinAgentLifecycleInput): void {
    this.lifecycleEvents.push(input);
  }

  public cancel(): boolean {
    this.cancelCalls += 1;
    return this.transport.cancelActiveServerTurn();
  }

  public addMessageListener(listener: (event: MessageEvent) => void): () => void {
    this.agent.addEventListener("message", listener as EventListener);
    return () => this.agent.removeEventListener("message", listener as EventListener);
  }

  public addOpenListener(listener: (event: Event) => void): () => void {
    this.agent.addEventListener("open", listener);
    return () => this.agent.removeEventListener("open", listener);
  }

  public addCloseListener(listener: (event: CloseEvent) => void): () => void {
    this.agent.addEventListener("close", listener as EventListener);
    return () => this.agent.removeEventListener("close", listener as EventListener);
  }

  public handleProtocolFrame(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (frame.type === MessageType.CF_AGENT_STREAM_RESUMING
      && typeof frame.id === "string") {
      return this.transport.handleStreamResuming({ id: frame.id });
    }
    if (frame.type === MessageType.CF_AGENT_STREAM_RESUME_NONE) {
      return this.transport.handleStreamResumeNone({
        ...(typeof frame.probeId === "string" ? { probeId: frame.probeId } : {}),
      });
    }
    if (frame.type === MessageType.CF_AGENT_STREAM_PENDING) {
      return this.transport.handleStreamPending();
    }
    return false;
  }
}

function terminal(rootMessageId: string): Record<string, unknown> {
  return {
    type: "data-systemsculpt-run-terminal",
    data: {
      version: 1,
      run_id: RUN_ID,
      root_message_id: rootMessageId,
      outcome: "succeeded",
      code: "completed",
    },
  };
}

function resumeRequests(agent: NativeAgent): Record<string, unknown>[] {
  return agent.sent.filter((frame) =>
    frame.type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST);
}

function resolveLatestResumeAsIdle(agent: NativeAgent): void {
  const request = resumeRequests(agent).at(-1);
  if (!request || typeof request.probeId !== "string") {
    throw new Error("No native resume probe exists.");
  }
  agent.message({
    type: MessageType.CF_AGENT_STREAM_RESUME_NONE,
    probeId: request.probeId,
  });
}

function emitContinuation(
  agent: NativeAgent,
  requestId: string,
  chunks: readonly Record<string, unknown>[],
): void {
  agent.message({
    type: MessageType.CF_AGENT_STREAM_RESUMING,
    id: requestId,
  });
  chunks.forEach((chunk, index) => {
    agent.message({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      id: requestId,
      body: JSON.stringify(chunk),
      done: index === chunks.length - 1,
      continuation: true,
    });
  });
}

function createNativeBridge(
  history: UIMessage[],
  executeLocalTool: (call: any, signal: AbortSignal) => Promise<any>,
) {
  const agent = new NativeAgent();
  const connection = new NativeBridgeConnection(agent, history);
  const persisted: any[] = [];
  const bridge = new ThinAgentBridge({
    connection: connection as any,
    mutationJournal: {
      claim: async () => ({ kind: "execute" as const }),
      complete: async () => {},
      idle: async () => {},
    } as any,
    executeLocalTool,
    persistAssistant: async (message) => {
      persisted.push(message);
    },
    runId: () => "run-local-native",
    now: () => 1_000,
  });
  return { agent, bridge, connection, persisted };
}

describe("thin-agent-v1 actual package bridge runtime", () => {
  it("rehydrates a pending tool through real AbstractChat and WebSocketChatTransport", async () => {
    const turnId = "user-native-read";
    const history: UIMessage[] = [
      { id: turnId, role: "user", parts: [{ type: "text", text: "Read it" }] },
      {
        id: "assistant-native-read",
        role: "assistant",
        parts: [{
          type: "tool-read",
          toolCallId: "call-native-read",
          state: "input-available",
          input: { paths: ["Native.md"] },
        }],
      },
    ];
    const execute = jest.fn(async () => ({
      success: true,
      data: { content: "Native package result" },
    }));
    const { agent, bridge, persisted } = createNativeBridge(history, execute);

    await bridge.hydrate(CONVERSATION_ID);
    await eventually(() => expect(resumeRequests(agent)).toHaveLength(1));
    resolveLatestResumeAsIdle(agent);
    await eventually(() => expect(execute).toHaveBeenCalledTimes(1));
    await eventually(() => expect(resumeRequests(agent)).toHaveLength(2));
    agent.message({
      type: MessageType.CF_AGENT_MESSAGE_UPDATED,
      message: {
        id: "assistant-native-read",
        role: "assistant",
        parts: [
          {
            type: "tool-read",
            toolCallId: "call-native-read",
            state: "output-available",
            input: { paths: ["Native.md"] },
            output: {
              success: true,
              data: { content: "Native package result" },
            },
          },
          terminal("user-from-an-older-run"),
        ],
      },
    });
    await Promise.resolve();
    expect(persisted).toHaveLength(0);
    expect(bridge.getSnapshot().status).not.toBe("completed");
    emitContinuation(agent, "native-read-continuation", [
      { type: "text-start", id: "native-read-text" },
      {
        type: "text-delta",
        id: "native-read-text",
        delta: "Native bridge completed.",
      },
      { type: "text-end", id: "native-read-text" },
      terminal(turnId),
      { type: "finish", finishReason: "stop" },
    ]);

    await eventually(() => expect(persisted).toHaveLength(1));
    expect(persisted[0]).toMatchObject({
      message_id: "assistant-native-read",
      content: "Native bridge completed.",
    });
  });

  it("rehydrates native approval state and does not mutate before server acknowledgement", async () => {
    const turnId = "user-native-write";
    const history: UIMessage[] = [
      { id: turnId, role: "user", parts: [{ type: "text", text: "Write it" }] },
      {
        id: "assistant-native-write",
        role: "assistant",
        parts: [{
          type: "tool-write",
          toolCallId: "call-native-write",
          state: "approval-requested",
          input: { path: "Native.md", content: "Done" },
          approval: { id: "approval-native-write" },
        }],
      },
    ];
    const execute = jest.fn(async () => ({
      success: true,
      data: { path: "Native.md" },
    }));
    const { agent, bridge, persisted } = createNativeBridge(history, execute);

    await bridge.hydrate(CONVERSATION_ID);
    await eventually(() => expect(resumeRequests(agent)).toHaveLength(1));
    resolveLatestResumeAsIdle(agent);
    await eventually(() => expect(bridge.getSnapshot().waitingReason).toBe("approval"));
    expect(bridge.respondToApproval("approval-native-write", true)).toBe(true);
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    agent.message({
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      body: JSON.stringify({
        type: "tool-approval-response",
        approvalId: "approval-native-write",
        approved: true,
      }),
    });
    await eventually(() => expect(execute).toHaveBeenCalledTimes(1));
    await eventually(() => expect(resumeRequests(agent)).toHaveLength(2));
    emitContinuation(agent, "native-write-continuation", [
      { type: "text-start", id: "native-write-text" },
      { type: "text-delta", id: "native-write-text", delta: "Native write completed." },
      { type: "text-end", id: "native-write-text" },
      terminal(turnId),
      { type: "finish", finishReason: "stop" },
    ]);
    await eventually(() => expect(persisted).toHaveLength(1));
  });

  it("keeps detached recovery active and lets the server continue thrown local failures", async () => {
    const detached = createNativeBridge([
      {
        id: "user-native-detached",
        role: "user",
        parts: [{ type: "text", text: "Detached" }],
      },
    ], async () => ({ success: true }));
    await detached.bridge.hydrate(CONVERSATION_ID);
    await eventually(() => expect(resumeRequests(detached.agent)).toHaveLength(1));
    resolveLatestResumeAsIdle(detached.agent);
    await eventually(() => expect(detached.bridge.getSnapshot()).toMatchObject({
      status: "running",
      turnId: "user-native-detached",
    }));
    expect(detached.connection.cancelCalls).toBe(0);
    await detached.bridge.cancel();
    expect(detached.bridge.getSnapshot().status).toBe("cancelled");

    const throwing = createNativeBridge([
      {
        id: "user-native-throw",
        role: "user",
        parts: [{ type: "text", text: "Read" }],
      },
      {
        id: "assistant-native-throw",
        role: "assistant",
        parts: [{
          type: "tool-read",
          toolCallId: "call-native-throw",
          state: "input-available",
          input: { paths: ["Throw.md"] },
        }],
      },
    ], async () => {
      throw new Error("native vault failure");
    });
    await throwing.bridge.hydrate(CONVERSATION_ID);
    await eventually(() => expect(resumeRequests(throwing.agent)).toHaveLength(1));
    resolveLatestResumeAsIdle(throwing.agent);
    await eventually(() => expect(throwing.agent.sent).toContainEqual({
      type: MessageType.CF_AGENT_TOOL_RESULT,
      toolCallId: "call-native-throw",
      toolName: "read",
      state: "output-error",
      errorText: "native vault failure",
    }));
    await eventually(() => expect(resumeRequests(throwing.agent)).toHaveLength(2));
    expect(throwing.bridge.getSnapshot().status).not.toBe("failed");
    expect(throwing.connection.cancelCalls).toBe(0);

    emitContinuation(throwing.agent, "native-throw-continuation", [
      { type: "text-start", id: "native-throw-text" },
      {
        type: "text-delta",
        id: "native-throw-text",
        delta: "I could not read that file.",
      },
      { type: "text-end", id: "native-throw-text" },
      terminal("user-native-throw"),
      { type: "finish", finishReason: "stop" },
    ]);

    await eventually(() => expect(throwing.persisted).toHaveLength(1));
    expect(throwing.persisted[0]).toMatchObject({
      message_id: "assistant-native-throw",
      content: "I could not read that file.",
    });
    expect(throwing.connection.cancelCalls).toBe(0);
  });
});
