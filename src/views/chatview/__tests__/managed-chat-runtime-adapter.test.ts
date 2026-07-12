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
function byteChunks(text: string): Uint8Array[] { return Array.from(bytes(text), (value) => new Uint8Array([value])); }

function setup() {
  const requestClient = new QueueClient();
  const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "5.11.0", licenseKey: () => "actual-license", requestClient });
  const client = new ManagedCapabilityClient({ admission: null as never, transport });
  const descriptor = fixture.capabilities.find((item) => item.alias === "systemsculpt/chat")!;
  const requestContract = descriptor.request_contracts.find((item) => item.capability === "chat_turn")!;
  const lease = Object.freeze({ outcome: "allowed", descriptor, requestContract }) as ManagedAllowedLease;
  const message = { role: "user", content: "hello", message_id: "u1" } as const;
  const snapshot = Object.freeze({ chatId: "c1", version: 1, messages: Object.freeze([message]) });
  const operation = Object.freeze({ lease, durableTurnId: "turn-017b-vector", acceptedUserMessage: message, initialDurableSnapshot: snapshot, turnBoundaryId: "b1" }) as AcceptedChatOperation;
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

  it("fails empty configuration before reading or serializing the snapshot", async () => {
    const requestClient = new QueueClient();
    const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "", licenseKey: () => "key", requestClient });
    const client = new ManagedCapabilityClient({ admission: null as never, transport });
    const base = setup();
    const snapshot = Object.create(null) as { messages: readonly never[] };
    Object.defineProperty(snapshot, "messages", { get() { throw new Error("serialization must not run"); } });
    const result = await new ManagedChatRuntimeAdapter(client).dispatch({ operation: base.operation, snapshot: snapshot as never, phase: "continuation", continuationIndex: 1 });
    expect(result.kind).toBe("transport_failure");
    expect(requestClient.inputs).toHaveLength(0);
  });

  it.each([
    [{ type: "function", function: { name: "" } }, "empty tool name"],
    [{ type: "other", function: { name: "x" } }, "tool type"],
    [{ type: "function", function: { name: "x" }, extra: true }, "tool extras"],
    [{ type: "function", function: { name: "x", extra: true } }, "function extras"],
    [{ type: "function", function: { name: "x", parameters: new Date() } }, "non-JSON schema"],
  ])("rejects malformed closed tools before transport: %s (%s)", async (tool) => {
    const { adapter, requestClient, operation, snapshot } = setup();
    const result = await adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0, tools: [tool] as never });
    expect(result.kind).toBe("transport_failure");
    expect(requestClient.inputs).toHaveLength(0);
  });

  it.each(["invalid", "AUTO", { type: "function" }])("rejects unsupported tool_choice %p before transport", async (toolChoice) => {
    const { adapter, requestClient, operation, snapshot } = setup();
    const result = await adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0, toolChoice: toolChoice as never });
    expect(result.kind).toBe("transport_failure");
    expect(requestClient.inputs).toHaveLength(0);
  });

  it("accepts data URL images and rejects remote URLs or content-block extras", async () => {
    const valid = setup();
    const validSnapshot = { ...valid.snapshot, messages: [{ role: "user", message_id: "u", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] } as never;
    valid.requestClient.responses.push(streamResponse([bytes('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')]));
    await expect(valid.adapter.dispatch({ operation: valid.operation, snapshot: validSnapshot, phase: "continuation", continuationIndex: 1 })).resolves.toMatchObject({ kind: "success" });
    expect(valid.requestClient.inputs[0].body).toMatchObject({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] });
    for (const content of [
      [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }],
      [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } }],
      [{ type: "video", url: "data:video/mp4;base64,AA==" }],
    ]) {
      const invalid = setup();
      const invalidSnapshot = { ...invalid.snapshot, messages: [{ role: "user", message_id: "u", content }] } as never;
      await expect(invalid.adapter.dispatch({ operation: invalid.operation, snapshot: invalidSnapshot, phase: "continuation", continuationIndex: 1 })).resolves.toMatchObject({ kind: "transport_failure" });
      expect(invalid.requestClient.inputs).toHaveLength(0);
    }
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

  it("uses the persisted assistant-message ordinal for multi-tool checkpoints and resists accepted-operation mutation", async () => {
    const state = setup();
    expect(Object.isFrozen(state.operation)).toBe(true);
    expect(Object.isFrozen(state.operation.lease)).toBe(true);
    expect(() => { (state.operation as { durableTurnId: string }).durableTurnId = "mutated"; }).toThrow();
    const toolCall = (id: string) => ({ id, messageId: "a1", state: "completed" as const, timestamp: 1, request: { id, type: "function" as const, function: { name: "tool", arguments: "{}" } } });
    const checkpoint = { chatId: "c1", version: 2, messages: [{ role: "assistant", content: null, message_id: "a1", tool_calls: [toolCall("one"), toolCall("two")] }] } as never;
    state.requestClient.responses.push(streamResponse([bytes('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')]));
    const input = { operation: state.operation, snapshot: checkpoint, phase: "continuation" as const, continuationIndex: 1 };
    const first = state.adapter.dispatch(input);
    expect(state.adapter.dispatch(input)).toBe(first);
    await expect(first).resolves.toMatchObject({ kind: "success" });
    expect(state.requestClient.inputs).toHaveLength(1);
    expect(state.requestClient.inputs[0].headers?.["Idempotency-Key"]).toBe("6343e7adaaf3af46e8a5c623231d20fcde4e3e6fd59592bc456ccb6968b8fd84");
  });

  it("retains multiple settled continuation ordinals independently and isolates exact operation identities", async () => {
    const first = setup();
    first.requestClient.responses.push(
      streamResponse([bytes('data: {"choices":[{"delta":{"content":"one"}}]}\n\ndata: [DONE]\n\n')]),
      streamResponse([bytes('data: {"choices":[{"delta":{"content":"two"}}]}\n\ndata: [DONE]\n\n')]),
    );
    const one = { operation: first.operation, snapshot: first.snapshot, phase: "continuation" as const, continuationIndex: 1 };
    const twelve = { ...one, continuationIndex: 12 };
    const onePromise = first.adapter.dispatch(one);
    const twelvePromise = first.adapter.dispatch(twelve);
    const [oneResult, twelveResult] = await Promise.all([onePromise, twelvePromise]);
    expect(await first.adapter.dispatch(one)).toBe(oneResult);
    expect(await first.adapter.dispatch(twelve)).toBe(twelveResult);
    expect(first.requestClient.inputs).toHaveLength(2);
    expect(new Set(first.requestClient.inputs.map((input) => input.headers?.["Idempotency-Key"]))).toEqual(new Set([
      "6343e7adaaf3af46e8a5c623231d20fcde4e3e6fd59592bc456ccb6968b8fd84",
      "7e21ca272f4c6bfe9237b53890bde6c51af1137cb100a5b45722e5a0cf3ae0e4",
    ]));
    const reconstructed = { ...first.operation } as AcceptedChatOperation;
    first.requestClient.responses.push(streamResponse([bytes('data: {"choices":[{"delta":{"content":"reload"}}]}\n\ndata: [DONE]\n\n')]));
    await expect(first.adapter.dispatch({ ...one, operation: reconstructed })).resolves.toMatchObject({ kind: "success" });
    expect(first.requestClient.inputs).toHaveLength(3);
    first.adapter.notifyDurablyTerminal(first.operation);
    expect(first.adapter.hasRetainedEntries(first.operation)).toBe(false);
    expect(first.adapter.hasRetainedEntries(reconstructed)).toBe(true);
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

  it.each(["operation_in_progress\u0000", "operation_in_progress\n", " operation_in_progress", "operation_in_progress "])("rejects non-exact 409 code before sanitization: %p", async (code) => {
    const { adapter, requestClient, operation, snapshot } = setup();
    requestClient.responses.push(new Response(JSON.stringify({ code }), { status: 409 }));
    await expect(adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "transport_failure" });
  });

  it("normalizes every closed runtime event and fragmented tool arguments", async () => {
    const { adapter, requestClient, operation, snapshot } = setup();
    const wire = [
      'data: {"id":"req","choices":[{"delta":{"role":"assistant","content":"hello","reasoning_content":"think","tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"search","arguments":"{\\\"q\\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"x\\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3,"cost":{"total":0.25}}}\n\n',
      'data: [DONE]\n\n',
    ].join("");
    requestClient.responses.push(streamResponse(byteChunks(wire)));
    await expect(adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0 })).resolves.toEqual({
      kind: "success", diagnostic: { status: 200 }, events: [
        { kind: "request_id", requestId: "req" }, { kind: "content_delta", text: "hello" }, { kind: "reasoning_delta", text: "think" },
        { kind: "tool_call_delta", index: 0, id: "call", name: "search", arguments: '{"q":' },
        { kind: "tool_call_delta", index: 0, arguments: '"x"}' }, { kind: "finish_reason", reason: "tool_calls" },
        { kind: "usage", promptTokens: 1, completionTokens: 2, totalTokens: 3, costTotal: 0.25 },
      ],
    });
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
    ["data: [DONE]", "unterminated done"], ["data: {}\n\ndata: [DONE]\n\n", "empty object"], ["data: {\"id\":\"x\"}\n\ndata: [DONE]\n\n", "missing choices"],
    ["data: {\"choices\":{}}\n\ndata: [DONE]\n\n", "nonarray choices"], ["data: {\"choices\":[{}]}\n\ndata: [DONE]\n\n", "empty choice"],
    ["data: {\"choices\":[{\"delta\":1}]}\n\ndata: [DONE]\n\n", "nonobject delta"], ["data: {\"choices\":[{\"delta\":{\"content\":1}}]}\n\ndata: [DONE]\n\n", "bad content"],
    ["data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0}]}}]}\n\ndata: [DONE]\n\n", "index-only tool"],
    ["data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":1}]}}]}\n\ndata: [DONE]\n\n", "nonobject function"],
    ["data: {\"choices\":[],\"usage\":1}\n\ndata: [DONE]\n\n", "nonobject usage"], ["data: {\"choices\":[],\"usage\":{}}\n\ndata: [DONE]\n\n", "empty usage"],
    ["data: {\"choices\":[]}\n\n", "missing done"], ["data:\n\ndata: [DONE]\n\n", "empty data"],
    ["data: {bad}\n\ndata: [DONE]\n\n", "malformed json"], ['data: {"error":{"message":"private"}}\n\ndata: [DONE]\n\n', "in-band error"],
    ["data: [DONE]\n\n ", "trailing whitespace"], ["data: [DONE]\n\n\n", "trailing blank line"], ["data: [DONE]\n\n:comment\n", "trailing comment"],
    ["data: [DONE]\n\ndata: {\"choices\":[]}\n\n", "trailing JSON"], ["data: [DONE]\n\ndata: [DONE]\n\n", "duplicate done"],
    ["data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\rdata: [DONE]\n\n", "bare CR is content"],
  ])("rejects %s (%s)", async (wire) => {
    const { adapter, requestClient, operation, snapshot } = setup();
    requestClient.responses.push(streamResponse([bytes(wire)]));
    await expect(adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "transport_failure" });
  });

  it.each([
    ['data: {"choices":[]}\n\ndata: [DONE]\n\n', "empty choices"],
    ['data: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n', "empty delta"],
    ['data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n', "role-only delta"],
  ])("treats a valid content-free frame as empty: %s (%s)", async (wire) => {
    const state = setup();
    state.requestClient.responses.push(streamResponse([bytes(wire)]));
    await expect(state.adapter.dispatch({ operation: state.operation, snapshot: state.snapshot, phase: "initial", continuationIndex: 0 })).resolves.toEqual({ kind: "empty", diagnostic: { status: 200 } });
  });

  it("normalizes parser exceptions to transport failure", async () => {
    const state = setup();
    state.requestClient.responses.push(streamResponse([bytes('data: {"choices":[]}\n\ndata: [DONE]\n\n')]));
    const parse = jest.spyOn(JSON, "parse").mockImplementation(() => { throw new Error("parser failure"); });
    await expect(state.adapter.dispatch({ operation: state.operation, snapshot: state.snapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "transport_failure" });
    parse.mockRestore();
  });

  it("aborts a stalled response read without waiting for unsupported server cancellation", async () => {
    const { adapter, requestClient, operation, snapshot } = setup();
    let cancelled = false;
    requestClient.responses.push(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
    const controller = new AbortController();
    const pending = adapter.dispatch({ operation, snapshot, phase: "initial", continuationIndex: 0, signal: controller.signal });
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ kind: "aborted" });
    expect(cancelled).toBe(true);
  });

  it("rejects invalid UTF-8 and treats a completed content-free stream as empty", async () => {
    const invalid = setup();
    invalid.requestClient.responses.push(streamResponse([new Uint8Array([0xff])]));
    await expect(invalid.adapter.dispatch({ operation: invalid.operation, snapshot: invalid.snapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "transport_failure" });
    const empty = setup();
    empty.requestClient.responses.push(streamResponse([bytes(": comment\n\ndata: [DONE]\n\n")]));
    await expect(empty.adapter.dispatch({ operation: empty.operation, snapshot: empty.snapshot, phase: "initial", continuationIndex: 0 })).resolves.toMatchObject({ kind: "empty" });
  });

  it("uses the TypeScript checker and AST to reject unsafe managed Chat flow types and surfaces", () => {
    const root = process.cwd();
    const files = ["src/views/chatview/turn/ManagedChatRuntimeAdapter.ts", "src/services/managed/ManagedCapabilityClient.ts"];
    const program = ts.createProgram(files.map((file) => path.join(root, file)), { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, skipLibCheck: true });
    const checker = program.getTypeChecker();
    const forbidden = /^(acquireLease|withLease|fetch|require|streamMessage|create.*Provider|.*Factory|retry|fallback)$/i;
    const findings: string[] = [];
    const inspect = (node: ts.Node, active: boolean): void => {
      const text = node.getText();
      const inAcceptedClientFlow = active || (ts.isMethodDeclaration(node) && ["beginAcceptedChatDispatch", "streamAcceptedChat"].includes(node.name.getText()));
      const inAdapter = node.getSourceFile().fileName.endsWith("ManagedChatRuntimeAdapter.ts");
      if (inAdapter || inAcceptedClientFlow) {
        if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) findings.push(`explicit unsafe type: ${text}`);
        if (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) {
          const type = checker.getTypeAtLocation(node);
          if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) findings.push(`checker unsafe type: ${text}`);
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const expression = node.expression.getText();
          const name = expression.split(".").pop() ?? expression;
          if (forbidden.test(name) || /^(globalThis\.)?(fetch|require)$/.test(expression)) findings.push(`forbidden call: ${expression}`);
        }
        if (ts.isImportDeclaration(node) && /^(node:|crypto$|fs$|path$)/.test(String(node.moduleSpecifier.getText()).replace(/["']/g, ""))) findings.push(`forbidden import: ${text}`);
        if (ts.isIdentifier(node) && /^(default|synthetic).*(Lease|Allowed)$/i.test(node.text)) findings.push(`synthetic lease: ${text}`);
        if (ts.isPropertyAssignment(node) && node.name.getText() === "outcome" && /["']allowed["']/.test(node.initializer.getText())) findings.push(`synthetic allowed lease: ${text}`);
      }
      ts.forEachChild(node, (child) => inspect(child, inAcceptedClientFlow));
    };
    for (const sourceFile of program.getSourceFiles().filter((file) => files.some((name) => file.fileName.endsWith(name)))) inspect(sourceFile, false);
    expect(findings).toEqual([]);

    const negativeSource = "declare const inferred: any; declare const client: { withLease(): void }; declare function require(name: string): any; declare class ProviderFactory {}; const defaultLease = {}; function bad(value: any) { const leaked = inferred; client.withLease(); require('node:crypto'); new ProviderFactory(); return fetch(value); }";
    const negativeOptions: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022 };
    const negativeHost = ts.createCompilerHost(negativeOptions);
    const originalGetSourceFile = negativeHost.getSourceFile.bind(negativeHost);
    negativeHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === "negative.ts"
      ? ts.createSourceFile(fileName, negativeSource, languageVersion, true, ts.ScriptKind.TS)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    negativeHost.fileExists = (fileName) => fileName === "negative.ts" || ts.sys.fileExists(fileName);
    negativeHost.readFile = (fileName) => fileName === "negative.ts" ? negativeSource : ts.sys.readFile(fileName);
    const negativeProgram = ts.createProgram(["negative.ts"], negativeOptions, negativeHost);
    const negativeChecker = negativeProgram.getTypeChecker();
    const negativeFile = negativeProgram.getSourceFile("negative.ts")!;
    const negativeFindings: string[] = [];
    const inspectNegative = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) negativeFindings.push("explicit-any");
      if (ts.isVariableDeclaration(node) && (negativeChecker.getTypeAtLocation(node).flags & ts.TypeFlags.Any) !== 0) negativeFindings.push("inferred-any");
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(negativeFile);
        const name = expression.split(".").pop() ?? expression;
        if (forbidden.test(name)) negativeFindings.push(name);
      }
      if (ts.isNewExpression(node) && /Factory$/.test(node.expression.getText(negativeFile))) negativeFindings.push("factory");
      if (ts.isIdentifier(node) && /^default.*Lease$/i.test(node.text)) negativeFindings.push("synthetic-lease");
      ts.forEachChild(node, inspectNegative);
    };
    inspectNegative(negativeFile);
    expect(negativeFindings).toEqual(expect.arrayContaining(["explicit-any", "inferred-any", "fetch", "withLease", "require", "factory", "synthetic-lease"]));
    expect(fs.readFileSync(path.join(root, files[0]), "utf8")).not.toContain("ManagedChatRuntimeAdapterFactory");
  });
});
