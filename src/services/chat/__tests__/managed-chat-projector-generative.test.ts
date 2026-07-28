import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import {
  projectManagedMessages,
  type ManagedPreparedMessage,
} from "../AcceptedChatRequestSnapshot";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function assertProviderReadyTranscript(messages: readonly ManagedPreparedMessage[]): void {
  expect(messages.length).toBeGreaterThan(0);
  const pending = new Map<string, string>();
  const declared = new Set<string>();

  messages.forEach((message, index) => {
    const row = message as Record<string, any>;
    expect(["user", "assistant", "tool"]).toContain(row.role);
    if (row.role !== "tool") {
      expect(pending.size).toBe(0);
    }

    if (row.role === "user") {
      expect(typeof row.content === "string" || Array.isArray(row.content)).toBe(true);
      return;
    }

    if (row.role === "assistant") {
      expect(typeof row.content === "string").toBe(true);
      const calls = row.tool_calls;
      expect(row.content.length > 0 || (Array.isArray(calls) && calls.length > 0)).toBe(true);
      if (typeof calls === "undefined") return;
      expect(Array.isArray(calls)).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.type).toBe("function");
        expect(typeof call.id).toBe("string");
        expect(call.id.length).toBeGreaterThan(0);
        expect(declared.has(call.id)).toBe(false);
        expect(typeof call.function?.name).toBe("string");
        expect(call.function.name.length).toBeGreaterThan(0);
        const input = JSON.parse(call.function.arguments);
        expect(input).not.toBeNull();
        expect(Array.isArray(input)).toBe(false);
        expect(typeof input).toBe("object");
        expect(call.function.name).not.toBe("web_search");
        declared.add(call.id);
        pending.set(call.id, call.function.name);
      }
      return;
    }

    expect(typeof row.tool_call_id).toBe("string");
    expect(pending.get(row.tool_call_id)).toBe(row.name);
    expect(typeof row.content).toBe("string");
    pending.delete(row.tool_call_id);
    expect(index).toBeGreaterThan(0);
  });

  expect(pending.size).toBe(0);
  expect(["user", "tool"]).toContain(messages.at(-1)?.role);
}

function toolCall(input: Readonly<{
  id: string;
  messageId: string;
  name: string;
  seed: number;
  serverMarker: boolean;
}>): ToolCall {
  const success = input.seed % 3 !== 0;
  return {
    id: input.id,
    messageId: input.messageId,
    request: {
      id: input.id,
      type: "function",
      function: {
        name: input.name,
        arguments: JSON.stringify({
          seed: input.seed,
          text: `unicode-${input.seed}-é-中-🙂`,
        }),
      },
    },
    state: success ? "completed" : "failed",
    timestamp: input.seed,
    ...(input.serverMarker ? { executedOn: "server" as const } : {}),
    result: success
      ? { success: true, data: { seed: input.seed, path: `Notes/${input.seed}.md` } }
      : {
          success: false,
          error: { code: "GENERATED_FAILURE", message: `failure-${input.seed}` },
        },
  };
}

describe("managed chat projector generative contract", () => {
  it("keeps 512 seeded persisted tool histories provider-ready", () => {
    for (let seed = 1; seed <= 512; seed += 1) {
      const random = seededRandom(seed);
      const assistantId = `assistant-${seed}`;
      const serverCount = Math.floor(random() * 3);
      let vaultCount = Math.floor(random() * 4);
      if (serverCount === 0 && vaultCount === 0) vaultCount = 1;

      const serverCalls = Array.from({ length: serverCount }, (_, index) =>
        toolCall({
          id: `server-${seed}-${index}`,
          messageId: assistantId,
          name: "web_search",
          seed: seed * 10 + index,
          serverMarker: (seed + index) % 2 === 0,
        }));
      const vaultCalls = Array.from({ length: vaultCount }, (_, index) =>
        toolCall({
          id: `vault-${seed}-${index}`,
          messageId: assistantId,
          name: index % 2 === 0 ? "read" : "search",
          seed: seed * 10 + serverCount + index,
          serverMarker: false,
        }));
      const calls = shuffled([...serverCalls, ...vaultCalls], random);
      const assistant: ChatMessage = {
        role: "assistant",
        content: random() < 0.5 ? "" : `answer-${seed}`,
        message_id: assistantId,
        tool_calls: calls,
      };
      const explicitResults = random() < 0.5
        ? vaultCalls.map<ChatMessage>((call) => ({
            role: "tool",
            content: JSON.stringify(call.result?.success ? call.result.data : call.result?.error),
            message_id: `${assistantId}:explicit:${call.id}`,
            tool_call_id: call.id,
            name: call.request.function.name,
          }))
        : [];
      const durable: ChatMessage[] = [
        {
          role: "user",
          content: `question-${seed}-e\u0301-中-🙂`,
          message_id: `user-${seed}-1`,
        },
        assistant,
        ...explicitResults,
        {
          role: "user",
          content: `follow-up-${seed}`,
          message_id: `user-${seed}-2`,
        },
      ];

      const wire = projectManagedMessages(durable);

      assertProviderReadyTranscript(wire);
      const serialized = JSON.stringify(wire);
      for (const call of serverCalls) expect(serialized).not.toContain(call.id);
      for (const call of vaultCalls) {
        expect(serialized.match(new RegExp(call.id, "g"))).toHaveLength(2);
      }
    }
  });

  it("rejects duplicate client tool-call ids across 128 deterministic histories", () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const assistantId = `assistant-duplicate-${seed}`;
      const original = toolCall({
        id: `duplicate-${seed}`,
        messageId: assistantId,
        name: seed % 2 === 0 ? "read" : "search",
        seed,
        serverMarker: false,
      });
      const duplicate = {
        ...original,
        timestamp: original.timestamp + 1,
        request: {
          ...original.request,
          function: {
            ...original.request.function,
            arguments: JSON.stringify({ duplicate: true, seed }),
          },
        },
      };

      expect(() => projectManagedMessages([{
        role: "assistant",
        content: "",
        message_id: assistantId,
        tool_calls: [original, duplicate],
      }])).toThrow("duplicate client tool-call id");
    }
  });
});
