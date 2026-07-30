/**
 * @jest-environment node
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketChatTransport } from "agents/chat/react";
import { CHAT_MESSAGE_TYPES } from "agents/chat";
import type { UIMessage, UIMessageChunk } from "ai";
import { ThinAgentMutationJournal } from "../../src/views/chatview/thin/ThinAgentMutationJournal";

type ToolCall = Readonly<{
  id: string;
  name: string;
  input: unknown;
}>;

type EnduranceFixture = Readonly<{
  conversation_id: string;
  agents_package_version: string;
  ai_package_version: string;
  round_count: number;
  readonly_cycle: readonly string[];
  parallel_batches: readonly Readonly<{
    round: number;
    tool_names: readonly string[];
  }>[];
  approved_mutation: Readonly<{
    round: number;
    tool_call_id: string;
    tool_name: string;
    approval_id: string;
    approved: boolean;
    input: unknown;
  }>;
  mutation_replay: Readonly<{
    after_round: number;
    tool_call_id: string;
    expected_execution_count: number;
    different_input_is_conflict: boolean;
  }>;
  reconnect: Readonly<{
    during_continuation_after_round: number;
    expect_pending_frame: boolean;
    retry_same_probe_id: boolean;
  }>;
  native_frame_types: Readonly<Record<string, string>>;
  expected: Readonly<{
    continuation_rounds: number;
    vault_tool_calls: number;
    tool_result_frames: number;
    tool_approval_frames: number;
    unique_resume_probes: number;
    resume_request_frames: number;
    resume_ack_frames: number;
    mutation_executions: number;
    hard_client_continuation_limit: null;
    server_max_steps: string;
  }>;
}>;

type Listener = (event: MessageEvent) => void;

class FakeAgentConnection {
  readonly sent: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  send = (data: string): void => {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  };

  addEventListener = (
    type: string,
    listener: Listener,
    options?: { signal?: AbortSignal },
  ): void => {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    options?.signal?.addEventListener("abort", () => {
      listeners.delete(listener);
    }, { once: true });
  };

  removeEventListener = (type: string, listener: Listener): void => {
    this.listeners.get(type)?.delete(listener);
  };

  message(value: unknown): void {
    const event = new MessageEvent("message", {
      data: JSON.stringify(value),
    });
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
}

class MemoryDataAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing ${path}.`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }
}

const FIXTURE_PATH = resolve(
  "testing/fixtures/agent/thin-agent-v1-endurance.json",
);
const fixtureBytes = readFileSync(FIXTURE_PATH);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as EnduranceFixture;

function packageVersion(name: "agents" | "ai"): string {
  const packageJson = JSON.parse(readFileSync(
    resolve("node_modules", name, "package.json"),
    "utf8",
  )) as { version: string };
  return packageJson.version;
}

function roundId(round: number, index: number): string {
  return `tool_round_${String(round).padStart(2, "0")}_${String(index).padStart(2, "0")}`;
}

function readonlyInput(name: string, round: number): unknown {
  const path = `Endurance/source-${String(round).padStart(2, "0")}.md`;
  switch (name) {
    case "read":
      return { paths: [path] };
    case "find":
      return { patterns: [`source-${round}`] };
    case "list_items":
      return { paths: ["Endurance"], limit: 25 };
    case "search":
      return { patterns: [`endurance-${round}`], patternMode: "literal" };
    case "context":
      return { action: "add", paths: [path] };
    case "open":
      return { files: [{ path }] };
    default:
      throw new Error(`Unsupported deterministic vault tool ${name}.`);
  }
}

function callsForRound(round: number): readonly ToolCall[] {
  if (round === fixture.approved_mutation.round) {
    return [{
      id: fixture.approved_mutation.tool_call_id,
      name: fixture.approved_mutation.tool_name,
      input: fixture.approved_mutation.input,
    }];
  }
  const parallel = fixture.parallel_batches.find((batch) => batch.round === round);
  const names = parallel?.tool_names ?? [
    fixture.readonly_cycle[(round - 1) % fixture.readonly_cycle.length],
  ];
  return names.map((name, index) => ({
    id: roundId(round, index + 1),
    name,
    input: readonlyInput(name, round),
  }));
}

async function readChunks(
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  for (;;) {
    const item = await reader.read();
    if (item.done) return chunks;
    chunks.push(item.value);
  }
}

function nativeToolResult(call: ToolCall, output: unknown): Record<string, unknown> {
  return {
    type: CHAT_MESSAGE_TYPES.TOOL_RESULT,
    toolCallId: call.id,
    toolName: call.name,
    output,
    state: "output-available",
  };
}

describe("thin-agent-v1 native transport endurance", () => {
  it("keeps the mirrored deterministic scenario and dependency semantics pinned", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex"))
      .toBe("adcb4679e489b8138027dadf86524c26b6f33558e51840461c64f5a9b2fdf32f");
    expect(packageVersion("agents")).toBe(fixture.agents_package_version);
    expect(packageVersion("ai")).toBe(fixture.ai_package_version);
    expect(fixture.native_frame_types).toMatchObject({
      initial_request: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
      tool_result: CHAT_MESSAGE_TYPES.TOOL_RESULT,
      tool_approval: CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
      resume_request: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
      resume_pending: CHAT_MESSAGE_TYPES.STREAM_PENDING,
      resume_ready: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
      resume_ack: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK,
      stream_response: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    });
  });

  it("completes forty native continuations with parallel calls and reconnect", async () => {
    const agent = new FakeAgentConnection();
    const activeRequestIds = new Set<string>();
    const transport = new WebSocketChatTransport({
      agent,
      activeRequestIds,
      cancelOnClientAbort: false,
    });
    const userMessage: UIMessage = {
      id: "message_user_endurance",
      role: "user",
      parts: [{ type: "text", text: "Run the deterministic endurance task." }],
    };
    const initialStream = await transport.sendMessages({
      chatId: fixture.conversation_id,
      messages: [userMessage],
      abortSignal: undefined,
      trigger: "submit-message",
    });
    const initialRequest = agent.sent.at(-1);
    expect(initialRequest).toMatchObject({
      type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
      init: { method: "POST" },
    });
    const initialRequestId = String(initialRequest?.id);
    agent.message({
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      id: initialRequestId,
      body: JSON.stringify({
        type: "text-delta",
        id: "text_endurance",
        delta: "Starting.",
      }),
      done: false,
    });
    agent.message({
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      id: initialRequestId,
      body: "",
      done: true,
    });
    await expect(readChunks(initialStream)).resolves.toHaveLength(1);

    const adapter = new MemoryDataAdapter();
    const journal = new ThinAgentMutationJournal(
      adapter,
      ".systemsculpt/agent-mutations.json",
      () => 1_000,
    );
    const uniqueProbeIds = new Set<string>();
    const observedCalls: ToolCall[] = [];
    let mutationExecutions = 0;

    for (let round = 1; round <= fixture.round_count; round += 1) {
      const calls = callsForRound(round);
      observedCalls.push(...calls);
      for (const call of calls) {
        let output: unknown = {
          success: true,
          data: { round, toolCallId: call.id },
        };
        if (call.id === fixture.approved_mutation.tool_call_id) {
          agent.send(JSON.stringify({
            type: CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
            toolCallId: call.id,
            approved: fixture.approved_mutation.approved,
          }));
          const claim = await journal.claim(
            fixture.conversation_id,
            call.id,
            call.name,
            call.input,
          );
          expect(claim).toEqual({ kind: "execute" });
          mutationExecutions += 1;
          await journal.complete(
            fixture.conversation_id,
            call.id,
            call.name,
            call.input,
            output,
          );
        }
        agent.send(JSON.stringify(nativeToolResult(call, output)));
      }

      if (round === fixture.mutation_replay.after_round) {
        const mutation = callsForRound(fixture.approved_mutation.round)[0];
        const replay = await journal.claim(
          fixture.conversation_id,
          mutation.id,
          mutation.name,
          mutation.input,
        );
        expect(replay.kind).toBe("replay");
        if (replay.kind === "replay") {
          agent.send(JSON.stringify(nativeToolResult(mutation, replay.result)));
        }
        if (fixture.mutation_replay.different_input_is_conflict) {
          await expect(journal.claim(
            fixture.conversation_id,
            mutation.id,
            mutation.name,
            { different: true },
          )).resolves.toEqual({ kind: "conflict" });
        }
      }

      transport.expectToolContinuation();
      const continuation = await transport.reconnectToStream({
        chatId: fixture.conversation_id,
      });
      expect(continuation).not.toBeNull();
      const resumeRequest = agent.sent.at(-1);
      expect(resumeRequest).toMatchObject({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
      });
      const probeId = String(resumeRequest?.probeId);
      uniqueProbeIds.add(probeId);

      if (round === fixture.reconnect.during_continuation_after_round) {
        expect(transport.handleStreamPending())
          .toBe(fixture.reconnect.expect_pending_frame);
        expect(transport.retryPendingResume()).toBe(true);
        const retry = agent.sent.at(-1);
        expect(retry).toMatchObject({
          type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
        });
        if (fixture.reconnect.retry_same_probe_id) {
          expect(retry?.probeId).toBe(probeId);
        }
      }

      const continuationId = `continuation_${String(round).padStart(2, "0")}`;
      expect(transport.handleStreamResuming({ id: continuationId })).toBe(true);
      expect(agent.sent.at(-1)).toEqual({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK,
        id: continuationId,
      });
      agent.message({
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: continuationId,
        body: JSON.stringify({
          type: "text-delta",
          id: "text_endurance",
          delta: round === fixture.round_count ? "Done." : ".",
        }),
        done: false,
      });
      agent.message({
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        id: continuationId,
        body: "",
        done: true,
      });
      await expect(readChunks(continuation as ReadableStream<UIMessageChunk>))
        .resolves.toHaveLength(1);
    }

    const frameCount = (type: string): number =>
      agent.sent.filter((frame) => frame.type === type).length;
    expect(observedCalls).toHaveLength(fixture.expected.vault_tool_calls);
    expect(uniqueProbeIds.size).toBe(fixture.expected.unique_resume_probes);
    expect(frameCount(CHAT_MESSAGE_TYPES.TOOL_RESULT))
      .toBe(fixture.expected.tool_result_frames);
    expect(frameCount(CHAT_MESSAGE_TYPES.TOOL_APPROVAL))
      .toBe(fixture.expected.tool_approval_frames);
    expect(frameCount(CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST))
      .toBe(fixture.expected.resume_request_frames);
    expect(frameCount(CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK))
      .toBe(fixture.expected.resume_ack_frames);
    expect(mutationExecutions).toBe(fixture.expected.mutation_executions);
    expect(mutationExecutions).toBe(fixture.mutation_replay.expected_execution_count);
    expect(fixture.round_count).toBe(fixture.expected.continuation_rounds);
    expect(fixture.expected.continuation_rounds).toBeGreaterThan(35);
    expect(fixture.expected.hard_client_continuation_limit).toBeNull();
    expect(new Set(agent.sent.map((frame) => frame.type))).toEqual(new Set([
      CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
      CHAT_MESSAGE_TYPES.TOOL_RESULT,
      CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
      CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST,
      CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK,
    ]));
    expect(activeRequestIds).toEqual(new Set());
  });
});
