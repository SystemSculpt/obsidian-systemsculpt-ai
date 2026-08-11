/**
 * Client delta-pipeline micro-benchmark. Not part of the check gates; run
 * manually to compare streaming CPU cost before/after pipeline changes:
 *
 *   node scripts/jest.mjs --config jest.integration.config.cjs \
 *     --runTestsByPath testing/bench/authoritative-session.bench.test.ts
 *
 * Feeds one session snapshot, then DELTA_COUNT assistant_delta frames, then a
 * healing snapshot through AgentSession with a subscribed listener, mirroring
 * the streaming hot path. Reports wall-clock milliseconds as JSON on stdout.
 */
import {
  AgentSession,
  type AgentAuthoritativeEvent,
  type AgentConnectionPort,
  type AgentConnectionState,
} from "../../src/views/chatview/agent/AuthoritativeSession";

type Message = Readonly<{
  id: string;
  role: "user" | "assistant";
  parts: readonly Readonly<{ type: "text"; text: string }>[];
}>;

const CONVERSATION_ID = `conversation_${"b".repeat(32)}`;
const RUN_ID = `run_${"c".repeat(32)}`;
const REQUEST_ID = "request_bench";
const DELTA_COUNT = 3000;
const DELTA_TEXT = "streamings";

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && (candidate.role === "user" || candidate.role === "assistant")
    && Array.isArray(candidate.parts);
}

class BenchConnection implements AgentConnectionPort {
  public state: AgentConnectionState = "open";
  private listener: ((frame: AgentAuthoritativeEvent) => void) | null = null;

  public readonly sendSubmit = async (): Promise<void> => undefined;
  public readonly sendToolResult = async (): Promise<void> => undefined;
  public readonly sendApproval = async (): Promise<void> => undefined;
  public readonly sendCancel = async (): Promise<void> => undefined;

  public addAuthoritativeFrameListener(
    listener: (frame: AgentAuthoritativeEvent) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  public addConnectionStateListener(): () => void {
    return () => undefined;
  }

  public emit(frame: unknown): void {
    this.listener?.(frame as AgentAuthoritativeEvent);
  }
}

function frame(
  kind: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "systemsculpt.agent.event.v1",
    version: 1,
    kind,
    conversation_id: CONVERSATION_ID,
    ...fields,
  };
}

describe("delta pipeline benchmark", () => {
  it("streams a long assistant message through the session", () => {
    const connection = new BenchConnection();
    const protocolErrors: Error[] = [];
    const session = new AgentSession<Message>({
      conversationId: CONVERSATION_ID,
      connection,
      isAuthoritativeMessage: isMessage,
      onProtocolError: (error) => protocolErrors.push(error),
    });
    let publishes = 0;
    let latestLength = 0;
    session.subscribe((snapshot) => {
      publishes += 1;
      const last = snapshot.messages[snapshot.messages.length - 1];
      if (last && last.role === "assistant") {
        latestLength = last.parts[0]?.text.length ?? 0;
      }
    });

    connection.emit(frame("session_snapshot", {
      messages: [{
        id: "user_root",
        role: "user",
        parts: [{ type: "text", text: "benchmark prompt" }],
      }],
      run_state: {
        version: 1,
        cursor: 1,
        state: "running",
        request_id: REQUEST_ID,
        run_id: RUN_ID,
        root_message_id: "user_root",
      },
    }));

    const started = performance.now();
    for (let index = 0; index < DELTA_COUNT; index += 1) {
      connection.emit(frame("assistant_delta", {
        request_id: REQUEST_ID,
        message_id: "assistant_bench",
        part_kind: "text",
        part_ordinal: 0,
        offset: index * DELTA_TEXT.length,
        delta: DELTA_TEXT,
      }));
    }
    const deltasMs = performance.now() - started;

    const healStarted = performance.now();
    connection.emit(frame("assistant_snapshot", {
      request_id: REQUEST_ID,
      message: {
        id: "assistant_bench",
        role: "assistant",
        parts: [{ type: "text", text: DELTA_TEXT.repeat(DELTA_COUNT) }],
      },
    }));
    const healMs = performance.now() - healStarted;

    expect(protocolErrors.map((error) => error.message)).toEqual([]);
    expect(latestLength).toBe(DELTA_COUNT * DELTA_TEXT.length);
    expect(publishes).toBeGreaterThanOrEqual(DELTA_COUNT);
    // eslint-disable-next-line no-console
    console.log(`BENCH_RESULT ${JSON.stringify({
      deltaCount: DELTA_COUNT,
      totalChars: DELTA_COUNT * DELTA_TEXT.length,
      deltasMs: Math.round(deltasMs * 10) / 10,
      perDeltaMicros: Math.round((deltasMs / DELTA_COUNT) * 1000),
      healingSnapshotMs: Math.round(healMs * 10) / 10,
    })}`);
    session.dispose();
  });
});
