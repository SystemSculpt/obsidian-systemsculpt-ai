import ts from "typescript";
import fs from "fs";
import path from "path";
import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { PlatformRequestClient, type PlatformRequestInput } from "../../../services/PlatformRequestClient";
import { ManagedCapabilityClient } from "../../../services/managed/ManagedCapabilityClient";
import type { AcceptedChatOperation, ManagedAllowedLease } from "../../../services/managed/ManagedTypes";
import { HostedTransportAdapter } from "../../../services/managed/adapters/HostedTransportAdapter";
import { ManagedChatRuntimeAdapter, managedChatOperationKey } from "../turn/ManagedChatRuntimeAdapter";

class QueueClient extends PlatformRequestClient {
  public readonly inputs: PlatformRequestInput[] = [];
  public responses: Response[] = [];
  public gate: Promise<Response> | null = null;
  public override async request(input: PlatformRequestInput): Promise<Response> {
    this.inputs.push(input);
    if (this.gate) return this.gate;
    const response = this.responses.shift();
    if (!response) throw new Error("missing response");
    return response;
  }
}

function streamResponse(parts: readonly Uint8Array[], status = 200, headers: Record<string, string> = {}): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); },
  }), { status, headers });
}

function bytes(text: string): Uint8Array { return new TextEncoder().encode(text); }

function setup() {
  const requestClient = new QueueClient();
  const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "5.11.0", licenseKey: () => "actual-license", requestClient });
  const client = new ManagedCapabilityClient({ admission: null as never, transport });
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = { outcome: "allowed", descriptor, requestContract } as ManagedAllowedLease;
  const message = { role: "user", content: "hello", message_id: "u1" } as const;
  const snapshot = { chatId: "c1", version: 1, messages: [message] } as const;
  const operation = { lease, durableTurnId: "turn-017b-vector", acceptedUserMessage: message, initialDurableSnapshot: snapshot, turnBoundaryId: "b1" } as AcceptedChatOperation;
  return { requestClient, adapter: new ManagedChatRuntimeAdapter(client), operation, snapshot, lease };
}

describe("ManagedChatRuntimeAdapter", () => {
  it("freezes exact operation-key vectors", async () => {
    await expect(managedChatOperationKey("turn-017b-vector", "initial", 0)).resolves.toBe("69c509a7e51c2ff3d502e7d52f14143c4873ff1b9d6c4b9b62099f7ed230a6b7");
    await expect(managedChatOperationKey("turn-017b-vector", "continuation", 1)).resolves.toBe("6343e7adaaf3af46e8a5c623231d20fcde4e3e6fd59592bc456ccb6968b8fd84");
    await expect(managedChatOperationKey("turn-017b-vector", "continuation", 12)).resolves.toBe("7e21ca272f4c6bfe9237b53890bde6c51af1137cb100a5b45722e5a0cf3ae0e4");
  });

  it("sends the exact body and five actual non-empty managed headers", async () => {
    const { adapter, requestClient, operation, snapshot } = setup();
    requestClient.responses.push(streamResponse([bytes('data: {"id":"r1","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')]));
    const result = await adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0, tools: [{ type: "function", function: { name: "search" } }], toolChoice: "auto" });
    expect(result.kind).toBe("success");
    expect(requestClient.inputs).toHaveLength(1);
    expect(requestClient.inputs[0]).toMatchObject({
      url: "https://api.test/api/v1/chat/completions", method: "POST", stream: true,
      headers: {
        "x-license-key": "actual-license", "x-plugin-version": "5.11.0", "x-systemsculpt-contract": "managed-capabilities-v2",
        "x-systemsculpt-capability": "chat_turn", "Idempotency-Key": "69c509a7e51c2ff3d502e7d52f14143c4873ff1b9d6c4b9b62099f7ed230a6b7",
      },
      body: { model: "ai-agent", stream: true, messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "search" } }], tool_choice: "auto" },
    });
    expect(Object.keys(requestClient.inputs[0].body as object)).toEqual(["model", "stream", "messages", "tools", "tool_choice"]);
  });

  it("deduplicates in flight and after settlement until durable terminal, then rejects late callbacks", async () => {
    const { adapter, requestClient, operation, snapshot } = setup();
    let release!: (response: Response) => void;
    requestClient.gate = new Promise((resolve) => { release = resolve; });
    const input = { operation, snapshot, phase: "initial" as const, continuationIndex: 0 };
    const first = adapter.dispatch(input);
    const duplicate = adapter.dispatch(input);
    expect(duplicate).toBe(first);
    await Promise.resolve(); await Promise.resolve();
    release(streamResponse([bytes('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')]));
    const settled = await first;
    expect(await adapter.dispatch(input)).toBe(settled);
    expect(requestClient.inputs).toHaveLength(1);
    expect(adapter.hasRetainedEntries(operation)).toBe(true);
    adapter.notifyDurablyTerminal(operation);
    expect(adapter.hasRetainedEntries(operation)).toBe(false);
    await expect(adapter.dispatch(input)).resolves.toEqual({ kind: "operation_terminal", diagnostic: {} });
    expect(requestClient.inputs).toHaveLength(1);
  });

  it.each([
    [400, "bad", "capability_request"], [401, "bad", "license"], [403, "bad", "license"], [402, "bad", "credits"],
    [426, "bad", "plugin_version"], [429, "bad", "rate_limit"], [503, "bad", "unavailable"], [502, "bad", "transport_failure"],
    [409, "operation_in_progress", "operation_in_progress"], [409, "operation_already_completed", "operation_already_completed"],
    [409, "operation_terminal", "operation_terminal"], [409, "settlement_pending", "settlement_pending"], [409, "other", "transport_failure"],
  ])("normalizes status %s/%s", async (status, code, kind) => {
    const { adapter, requestClient, operation, snapshot } = setup();
    requestClient.responses.push(new Response(JSON.stringify({ code, message: "secret body" }), { status, headers: { "x-request-id": "request-1" } }));
    const result = await adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0 });
    expect(result).toEqual({ kind, diagnostic: { status, code, requestId: "request-1" } });
    expect(JSON.stringify(result)).not.toContain("secret body");
  });

  it("parses every byte split of ASCII and multibyte SSE with CRLF, comments, unsupported fields and multi-data", async () => {
    const wire = ': comment\r\nevent: ignored\r\ndata: {"choices":[{"delta":{"content":"hé"}}],\r\ndata: "usage":{"total_tokens":2}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const encoded = bytes(wire);
    for (let split = 0; split <= encoded.length; split += 1) {
      const { adapter, requestClient, operation, snapshot } = setup();
      requestClient.responses.push(streamResponse([encoded.slice(0, split), encoded.slice(split)]));
      const result = await adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0 });
      expect(result.kind).toBe("success");
    }
  });

  it.each([
    ["data: [DONE]", "unterminated done"], ["data: {}\n\n", "missing done"], ["data:\n\ndata: [DONE]\n\n", "empty data"],
    ["data: {bad}\n\ndata: [DONE]\n\n", "malformed json"], ['data: {"error":{"message":"private"}}\n\ndata: [DONE]\n\n', "in-band error"],
    ["data: [DONE]\n\n ", "trailing whitespace"], ["data: [DONE]\n\n:comment\n", "trailing comment"], ["data: [DONE]\n\ndata: [DONE]\n\n", "duplicate done"],
  ])("rejects %s (%s)", async (wire) => {
    const { adapter, requestClient, operation, snapshot } = setup();
    requestClient.responses.push(streamResponse([bytes(wire)]));
    await expect(adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "transport_failure" });
  });

  it("rejects invalid UTF-8 and treats a completed content-free stream as empty", async () => {
    const invalid = setup();
    invalid.requestClient.responses.push(streamResponse([new Uint8Array([0xff])]));
    await expect(invalid.adapter.dispatch({ operation: invalid.operation, snapshot: invalid.snapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "transport_failure" });
    const empty = setup();
    empty.requestClient.responses.push(streamResponse([bytes(": comment\n\ndata: [DONE]\n\n")]));
    await expect(empty.adapter.dispatch({ operation: empty.operation, snapshot: empty.snapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "empty" });
  });

  it("keeps production sources structurally free of admission, direct network, Node, provider, fallback, retry, any and exported unknown", () => {
    const root = process.cwd();
    const files = ["src/views/chatview/turn/ManagedChatRuntimeAdapter.ts", "src/services/managed/ManagedCapabilityClient.ts"];
    const program = ts.createProgram(files.map((file) => path.join(root, file)), { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
    const checker = program.getTypeChecker();
    expect(checker).toBeDefined();
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      const guardedSource = file.includes("ManagedCapabilityClient")
        ? source.slice(source.indexOf("public managedChatConfigurationReady"), source.indexOf("async acquireChatTurnLease"))
        : source;
      expect(guardedSource).not.toMatch(/\b(acquireLease|withLease|fetch|Buffer|process|streamMessage|NODE_ENV|provider|fallback|retry)\b/);
      expect(guardedSource).not.toMatch(/\bany\b/);
      expect(guardedSource.match(/\bunknown\b/g) ?? []).toHaveLength(0);
    }
  });
});
