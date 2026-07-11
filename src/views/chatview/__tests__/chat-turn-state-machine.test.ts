import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  ChatTurnIllegalTransitionError,
  initialChatTurnState,
  reduceChatTurn,
} from "../turn/ChatTurnReducer";
import type {
  ChatTurnEffect,
  ChatTurnEvent,
  ChatTurnOutcome,
  ChatTurnState,
  ChatTurnTransition,
} from "../turn/ChatTurnTypes";

const transition = (state: ChatTurnState, event: ChatTurnEvent): ChatTurnTransition =>
  reduceChatTurn(state, event);

function assertExactTypes(
  state: ChatTurnState,
  event: ChatTurnEvent,
  outcome: ChatTurnOutcome,
  effect: ChatTurnEffect,
  result: ChatTurnTransition,
): void {
  void state;
  void event;
  void outcome;
  void effect;
  // @ts-expect-error state is readonly
  result.state = { kind: "idle" };
  // @ts-expect-error effects are readonly
  result.effects.push({ type: "START_STREAM", phase: "initial", retryCount: 0, continuationIndex: 0 });
}
void assertExactTypes;

function assertNever(value: never): never { throw new Error(String(value)); }
function exhaustState(value: ChatTurnState): void {
  switch (value.kind) {
    case "idle": case "streaming_initial": case "retrying_initial":
    case "committing_assistant": case "awaiting_approval": case "executing_tool":
    case "checkpointing_tools": case "continuation_pending": case "streaming_continuation":
    case "retrying_continuation": case "cancel_requested": case "settling": case "terminal": return;
    default: assertNever(value);
  }
}
function exhaustEvent(value: ChatTurnEvent): void {
  switch (value.type) {
    case "TURN_STARTED": case "PERSIST_FAILED": case "STREAM_DELTA":
    case "STREAM_FINISHED": case "STREAM_FAILED": case "RETRY_ALLOWED": case "RETRY_EXHAUSTED":
    case "ASSISTANT_COMMITTED": case "TOOL_APPROVED": case "TOOL_DENIED": case "TOOL_COMPLETED":
    case "TOOL_FAILED": case "TOOL_CANCEL_UNKNOWN": case "TOOL_CHECKPOINT_COMMITTED":
    case "CONTINUATION_STARTED": case "CANCEL_REQUESTED": case "SETTLEMENT_STARTED": case "SETTLED": return;
    default: assertNever(value);
  }
}
function exhaustEffect(value: ChatTurnEffect): void {
  switch (value.type) {
    case "START_STREAM": case "PERSIST_ASSISTANT": case "REQUEST_TOOL_APPROVAL":
    case "EXECUTE_TOOL": case "PERSIST_TOOL_CHECKPOINT": case "START_CONTINUATION": case "REQUEST_ABORT":
    case "AWAIT_SETTLEMENT": case "FINISH": return;
    default: assertNever(value);
  }
}
function exhaustOutcome(value: ChatTurnOutcome): void {
  switch (value) {
    case "completed": case "cancelled": case "transport_failed": case "retry_exhausted":
    case "persistence_failed": case "tool_outcome_unknown": return;
    default: assertNever(value);
  }
}
void exhaustState; void exhaustEvent; void exhaustEffect; void exhaustOutcome;

describe("Chat turn state machine", () => {
  describe("happy path and assistant ordering", () => {
    const cases: ReadonlyArray<readonly [string, ChatTurnState, ChatTurnEvent, ChatTurnTransition]> = [
      ["starts initial streaming from an already durable accepted operation", { kind: "idle" }, { type: "TURN_STARTED" }, { state: { kind: "streaming_initial", retryCount: 0 }, effects: [{ type: "START_STREAM", phase: "initial", retryCount: 0, continuationIndex: 0 }] }],
      ["accepts an initial delta without effects", { kind: "streaming_initial", retryCount: 0 }, { type: "STREAM_DELTA" }, { state: { kind: "streaming_initial", retryCount: 0 }, effects: [] }],
      ["commits a no-tool assistant before finishing", { kind: "streaming_initial", retryCount: 0 }, { type: "STREAM_FINISHED", toolCount: 0 }, { state: { kind: "committing_assistant", phase: "initial", pendingToolCount: 0, continuationIndex: 0 }, effects: [{ type: "PERSIST_ASSISTANT" }] }],
      ["finishes only after no-tool assistant commit", { kind: "committing_assistant", phase: "initial", pendingToolCount: 0, continuationIndex: 0 }, { type: "ASSISTANT_COMMITTED" }, { state: { kind: "terminal", outcome: "completed" }, effects: [{ type: "FINISH", outcome: "completed" }] }],
      ["commits a tool-bearing assistant before approval", { kind: "streaming_initial", retryCount: 2 }, { type: "STREAM_FINISHED", toolCount: 2 }, { state: { kind: "committing_assistant", phase: "initial", pendingToolCount: 2, continuationIndex: 0 }, effects: [{ type: "PERSIST_ASSISTANT" }] }],
      ["requests approval only after assistant commit", { kind: "committing_assistant", phase: "initial", pendingToolCount: 2, continuationIndex: 0 }, { type: "ASSISTANT_COMMITTED" }, { state: { kind: "awaiting_approval", remainingToolCount: 2, continuationIndex: 0 }, effects: [{ type: "REQUEST_TOOL_APPROVAL", remainingToolCount: 2 }] }],
    ];
    test.each(cases)("%s", (_name, state, event, expected) => expect(transition(state, event)).toEqual(expected));
  });

  describe("retries stay in their phase", () => {
    const cases: ReadonlyArray<readonly [string, ChatTurnState, ChatTurnEvent, ChatTurnTransition]> = [
      ["initial failure enters initial retry", { kind: "streaming_initial", retryCount: 0 }, { type: "STREAM_FAILED", failureKind: "empty" }, { state: { kind: "retrying_initial", retryCount: 0, failureKind: "empty" }, effects: [] }],
      ["initial retry is monotonic", { kind: "retrying_initial", retryCount: 0, failureKind: "empty" }, { type: "RETRY_ALLOWED", retryCount: 1 }, { state: { kind: "streaming_initial", retryCount: 1 }, effects: [{ type: "START_STREAM", phase: "initial", retryCount: 1, continuationIndex: 0 }] }],
      ["initial exhaustion terminates", { kind: "retrying_initial", retryCount: 3, failureKind: "empty" }, { type: "RETRY_EXHAUSTED" }, { state: { kind: "terminal", outcome: "retry_exhausted" }, effects: [{ type: "FINISH", outcome: "retry_exhausted" }] }],
      ["continuation failure enters continuation retry", { kind: "streaming_continuation", retryCount: 1, continuationIndex: 2 }, { type: "STREAM_FAILED", failureKind: "empty" }, { state: { kind: "retrying_continuation", retryCount: 1, continuationIndex: 2, failureKind: "empty" }, effects: [] }],
      ["continuation retry preserves its index", { kind: "retrying_continuation", retryCount: 1, continuationIndex: 2, failureKind: "empty" }, { type: "RETRY_ALLOWED", retryCount: 2 }, { state: { kind: "streaming_continuation", retryCount: 2, continuationIndex: 2 }, effects: [{ type: "START_STREAM", phase: "continuation", retryCount: 2, continuationIndex: 2 }] }],
      ["continuation exhaustion terminates", { kind: "retrying_continuation", retryCount: 2, continuationIndex: 4, failureKind: "empty" }, { type: "RETRY_EXHAUSTED" }, { state: { kind: "terminal", outcome: "retry_exhausted" }, effects: [{ type: "FINISH", outcome: "retry_exhausted" }] }],
      ["continuation delta preserves counters", { kind: "streaming_continuation", retryCount: 3, continuationIndex: 4 }, { type: "STREAM_DELTA" }, { state: { kind: "streaming_continuation", retryCount: 3, continuationIndex: 4 }, effects: [] }],
      ["continuation finish records its phase", { kind: "streaming_continuation", retryCount: 3, continuationIndex: 4 }, { type: "STREAM_FINISHED", toolCount: 1 }, { state: { kind: "committing_assistant", phase: "continuation", pendingToolCount: 1, continuationIndex: 4 }, effects: [{ type: "PERSIST_ASSISTANT" }] }],
    ];
    test.each(cases)("%s", (_name, state, event, expected) => expect(transition(state, event)).toEqual(expected));

    test.each(["malformed", "transport"] as const)("preserves %s initial failure and maps exhaustion to transport failure", failureKind => {
      const retry = transition({ kind: "streaming_initial", retryCount: 1 }, { type: "STREAM_FAILED", failureKind });
      expect(retry).toEqual({ state: { kind: "retrying_initial", retryCount: 1, failureKind }, effects: [] });
      expect(transition(retry.state, { type: "RETRY_EXHAUSTED" })).toEqual({ state: { kind: "terminal", outcome: "transport_failed" }, effects: [{ type: "FINISH", outcome: "transport_failed" }] });
    });

    test.each(["malformed", "transport"] as const)("preserves %s continuation failure and maps exhaustion to transport failure", failureKind => {
      const retry = transition({ kind: "streaming_continuation", retryCount: 1, continuationIndex: 2 }, { type: "STREAM_FAILED", failureKind });
      expect(retry).toEqual({ state: { kind: "retrying_continuation", retryCount: 1, continuationIndex: 2, failureKind }, effects: [] });
      expect(transition(retry.state, { type: "RETRY_EXHAUSTED" })).toEqual({ state: { kind: "terminal", outcome: "transport_failed" }, effects: [{ type: "FINISH", outcome: "transport_failed" }] });
    });
  });

  describe("tools preserve denial and failure parity", () => {
    const cases: ReadonlyArray<readonly [string, ChatTurnState, ChatTurnEvent, ChatTurnTransition]> = [
      ["approval executes the current tool", { kind: "awaiting_approval", remainingToolCount: 2, continuationIndex: 1 }, { type: "TOOL_APPROVED" }, { state: { kind: "executing_tool", remainingToolCount: 2, continuationIndex: 1 }, effects: [{ type: "EXECUTE_TOOL", remainingToolCount: 2 }] }],
      ["denial advances to next approval", { kind: "awaiting_approval", remainingToolCount: 2, continuationIndex: 1 }, { type: "TOOL_DENIED" }, { state: { kind: "awaiting_approval", remainingToolCount: 1, continuationIndex: 1 }, effects: [{ type: "REQUEST_TOOL_APPROVAL", remainingToolCount: 1 }] }],
      ["last denial checkpoints", { kind: "awaiting_approval", remainingToolCount: 1, continuationIndex: 1 }, { type: "TOOL_DENIED" }, { state: { kind: "checkpointing_tools", outcomeUnknown: false, continuationIndex: 1 }, effects: [{ type: "PERSIST_TOOL_CHECKPOINT", outcomeUnknown: false }] }],
      ["completion advances to next approval", { kind: "executing_tool", remainingToolCount: 3, continuationIndex: 2 }, { type: "TOOL_COMPLETED" }, { state: { kind: "awaiting_approval", remainingToolCount: 2, continuationIndex: 2 }, effects: [{ type: "REQUEST_TOOL_APPROVAL", remainingToolCount: 2 }] }],
      ["failure advances to next approval", { kind: "executing_tool", remainingToolCount: 2, continuationIndex: 2 }, { type: "TOOL_FAILED" }, { state: { kind: "awaiting_approval", remainingToolCount: 1, continuationIndex: 2 }, effects: [{ type: "REQUEST_TOOL_APPROVAL", remainingToolCount: 1 }] }],
      ["last completion checkpoints", { kind: "executing_tool", remainingToolCount: 1, continuationIndex: 2 }, { type: "TOOL_COMPLETED" }, { state: { kind: "checkpointing_tools", outcomeUnknown: false, continuationIndex: 2 }, effects: [{ type: "PERSIST_TOOL_CHECKPOINT", outcomeUnknown: false }] }],
      ["last failure checkpoints", { kind: "executing_tool", remainingToolCount: 1, continuationIndex: 2 }, { type: "TOOL_FAILED" }, { state: { kind: "checkpointing_tools", outcomeUnknown: false, continuationIndex: 2 }, effects: [{ type: "PERSIST_TOOL_CHECKPOINT", outcomeUnknown: false }] }],
      ["unknown execution checkpoints honestly", { kind: "executing_tool", remainingToolCount: 2, continuationIndex: 2 }, { type: "TOOL_CANCEL_UNKNOWN" }, { state: { kind: "checkpointing_tools", outcomeUnknown: true, continuationIndex: 2 }, effects: [{ type: "PERSIST_TOOL_CHECKPOINT", outcomeUnknown: true }] }],
    ];
    test.each(cases)("%s", (_name, state, event, expected) => expect(transition(state, event)).toEqual(expected));
  });

  describe("checkpoint and continuation ordering", () => {
    const cases: ReadonlyArray<readonly [string, ChatTurnState, ChatTurnEvent, ChatTurnTransition]> = [
      ["normal checkpoint can complete", { kind: "checkpointing_tools", outcomeUnknown: false, continuationIndex: 0 }, { type: "TOOL_CHECKPOINT_COMMITTED", continuationRequired: false }, { state: { kind: "terminal", outcome: "completed" }, effects: [{ type: "FINISH", outcome: "completed" }] }],
      ["normal checkpoint schedules next continuation", { kind: "checkpointing_tools", outcomeUnknown: false, continuationIndex: 0 }, { type: "TOOL_CHECKPOINT_COMMITTED", continuationRequired: true }, { state: { kind: "continuation_pending", continuationIndex: 1 }, effects: [{ type: "START_CONTINUATION", continuationIndex: 1 }] }],
      ["continuation starts at the scheduled index", { kind: "continuation_pending", continuationIndex: 3 }, { type: "CONTINUATION_STARTED" }, { state: { kind: "streaming_continuation", retryCount: 0, continuationIndex: 3 }, effects: [{ type: "START_STREAM", phase: "continuation", retryCount: 0, continuationIndex: 3 }] }],
      ["unknown checkpoint terminates despite requested continuation", { kind: "checkpointing_tools", outcomeUnknown: true, continuationIndex: 2 }, { type: "TOOL_CHECKPOINT_COMMITTED", continuationRequired: true }, { state: { kind: "terminal", outcome: "tool_outcome_unknown" }, effects: [{ type: "FINISH", outcome: "tool_outcome_unknown" }] }],
      ["unknown checkpoint terminates without continuation", { kind: "checkpointing_tools", outcomeUnknown: true, continuationIndex: 2 }, { type: "TOOL_CHECKPOINT_COMMITTED", continuationRequired: false }, { state: { kind: "terminal", outcome: "tool_outcome_unknown" }, effects: [{ type: "FINISH", outcome: "tool_outcome_unknown" }] }],
    ];
    test.each(cases)("%s", (_name, state, event, expected) => expect(transition(state, event)).toEqual(expected));
  });

  describe("persistence seams", () => {
    test.each([
      ["initial assistant", { kind: "committing_assistant", phase: "initial", pendingToolCount: 1, continuationIndex: 0 }, { type: "PERSIST_FAILED", operation: "assistant_commit" }],
      ["continuation assistant", { kind: "committing_assistant", phase: "continuation", pendingToolCount: 0, continuationIndex: 2 }, { type: "PERSIST_FAILED", operation: "assistant_commit" }],
      ["tool checkpoint", { kind: "checkpointing_tools", outcomeUnknown: false, continuationIndex: 1 }, { type: "PERSIST_FAILED", operation: "tool_checkpoint" }],
    ] as const)("%s persistence failure terminates", (_name, state, event) => {
      expect(transition(state, event)).toEqual({ state: { kind: "terminal", outcome: "persistence_failed" }, effects: [{ type: "FINISH", outcome: "persistence_failed" }] });
    });
  });

  describe("cancellation settlement", () => {
    test.each([
      { kind: "streaming_initial", retryCount: 0 },
      { kind: "retrying_initial", retryCount: 0, failureKind: "empty" },
      { kind: "committing_assistant", phase: "initial", pendingToolCount: 1, continuationIndex: 0 },
      { kind: "awaiting_approval", remainingToolCount: 1, continuationIndex: 0 },
      { kind: "executing_tool", remainingToolCount: 1, continuationIndex: 0 },
      { kind: "checkpointing_tools", outcomeUnknown: false, continuationIndex: 0 },
      { kind: "continuation_pending", continuationIndex: 1 },
      { kind: "streaming_continuation", retryCount: 0, continuationIndex: 1 },
      { kind: "retrying_continuation", retryCount: 0, continuationIndex: 1, failureKind: "empty" },
    ] as const)("requests cancellation from $kind", state => {
      expect(transition(state, { type: "CANCEL_REQUESTED" })).toEqual({ state: { kind: "cancel_requested" }, effects: [{ type: "REQUEST_ABORT" }] });
    });

    test("starts cancelled settlement explicitly", () => {
      expect(transition({ kind: "cancel_requested" }, { type: "SETTLEMENT_STARTED", requestedOutcome: "cancelled" })).toEqual({ state: { kind: "settling", requestedOutcome: "cancelled" }, effects: [{ type: "AWAIT_SETTLEMENT", requestedOutcome: "cancelled" }] });
    });
    test("starts unknown-outcome settlement explicitly", () => {
      expect(transition({ kind: "cancel_requested" }, { type: "SETTLEMENT_STARTED", requestedOutcome: "tool_outcome_unknown" })).toEqual({ state: { kind: "settling", requestedOutcome: "tool_outcome_unknown" }, effects: [{ type: "AWAIT_SETTLEMENT", requestedOutcome: "tool_outcome_unknown" }] });
    });
    test.each(["cancelled", "tool_outcome_unknown"] as const)("settles %s only after matching settlement", outcome => {
      expect(transition({ kind: "settling", requestedOutcome: outcome }, { type: "SETTLED", outcome })).toEqual({ state: { kind: "terminal", outcome }, effects: [{ type: "FINISH", outcome }] });
    });
  });

  describe("illegal guards and terminal idempotency", () => {
    const illegalCases: ReadonlyArray<readonly [string, ChatTurnState, ChatTurnEvent]> = [
      ["idle cancellation", { kind: "idle" }, { type: "CANCEL_REQUESTED" }],
      ["duplicate start", { kind: "streaming_initial", retryCount: 0 }, { type: "TURN_STARTED" }],
      ["assistant before stream", { kind: "streaming_initial", retryCount: 0 }, { type: "ASSISTANT_COMMITTED" }],
      ["approval before assistant durability", { kind: "committing_assistant", phase: "initial", pendingToolCount: 1, continuationIndex: 0 }, { type: "TOOL_APPROVED" }],
      ["negative tool count", { kind: "streaming_initial", retryCount: 0 }, { type: "STREAM_FINISHED", toolCount: -1 }],
      ["noninteger tool count", { kind: "streaming_initial", retryCount: 0 }, { type: "STREAM_FINISHED", toolCount: 1.5 }],
      ["nonmonotonic initial retry", { kind: "retrying_initial", retryCount: 2, failureKind: "transport" }, { type: "RETRY_ALLOWED", retryCount: 2 }],
      ["negative continuation retry", { kind: "retrying_continuation", retryCount: 0, continuationIndex: 1, failureKind: "empty" }, { type: "RETRY_ALLOWED", retryCount: -1 }],
      ["wrong assistant persistence seam", { kind: "committing_assistant", phase: "initial", pendingToolCount: 0, continuationIndex: 0 }, { type: "PERSIST_FAILED", operation: "tool_checkpoint" }],
      ["duplicate cancellation", { kind: "cancel_requested" }, { type: "CANCEL_REQUESTED" }],
      ["settled before settlement start", { kind: "cancel_requested" }, { type: "SETTLED", outcome: "cancelled" }],
      ["mismatched settlement", { kind: "settling", requestedOutcome: "cancelled" }, { type: "SETTLED", outcome: "tool_outcome_unknown" }],
      ["late stream event", { kind: "awaiting_approval", remainingToolCount: 1, continuationIndex: 0 }, { type: "STREAM_DELTA" }],
      ["initial assistant at continuation index", { kind: "committing_assistant", phase: "initial", pendingToolCount: 0, continuationIndex: 1 }, { type: "ASSISTANT_COMMITTED" }],
      ["continuation assistant at initial index", { kind: "committing_assistant", phase: "continuation", pendingToolCount: 0, continuationIndex: 0 }, { type: "ASSISTANT_COMMITTED" }],
      ["zero-index continuation pending", { kind: "continuation_pending", continuationIndex: 0 }, { type: "CONTINUATION_STARTED" }],
      ["zero-index continuation stream", { kind: "streaming_continuation", retryCount: 0, continuationIndex: 0 }, { type: "STREAM_DELTA" }],
      ["zero-index continuation retry", { kind: "retrying_continuation", retryCount: 0, continuationIndex: 0, failureKind: "empty" }, { type: "RETRY_EXHAUSTED" }],
      ["non-finite finished tool count", { kind: "streaming_initial", retryCount: 0 }, { type: "STREAM_FINISHED", toolCount: Number.POSITIVE_INFINITY }],
      ["non-finite retry event", { kind: "retrying_initial", retryCount: 0, failureKind: "empty" }, { type: "RETRY_ALLOWED", retryCount: Number.NaN }],
    ];
    test.each(illegalCases)("rejects %s", (_name, state, event) => {
      let error: unknown;
      try { transition(state, event); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ChatTurnIllegalTransitionError);
      expect(error).toMatchObject({ stateKind: state.kind, eventType: event.type });
      expect((error as Error).message).toBe(`Illegal chat turn transition: ${state.kind} + ${event.type}`);
    });

    test.each([
      { type: "TURN_STARTED" },
      { type: "CANCEL_REQUESTED" },
      { type: "SETTLED", outcome: "cancelled" },
    ] as const)("terminal state is idempotent for $type", event => {
      const state = { kind: "terminal", outcome: "completed" } as const;
      expect(transition(state, event)).toEqual({ state, effects: [] });
    });
  });

  it("exports a deeply frozen initial state", () => {
    expect(initialChatTurnState).toEqual({ kind: "idle" });
    expect(Object.isFrozen(initialChatTurnState)).toBe(true);
  });

  it("has only type-only local imports and no side-effect globals", () => {
    const turnDir = path.resolve(__dirname, "../turn");
    const mutatingMethods = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "copyWithin", "fill", "set", "add", "delete", "clear"]);
    const objectMutators = new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]);
    const reflectMutators = new Set(["set", "deleteProperty", "setPrototypeOf", "defineProperty"]);
    const allowedRuntimeGlobals = new Map([
      ["Error", new Set<string>()],
      ["Object", new Set(["freeze"])],
      ["Number", new Set(["isInteger"])],
    ]);
    const sensitiveBindings = new Set([
      "Error", "Object", "Number", "process", "console", "globalThis", "global", "self", "window", "document", "navigator", "location",
      "localStorage", "sessionStorage", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "BroadcastChannel",
      "require", "module", "exports", "__dirname", "__filename", "Buffer", "Deno", "Bun", "eval", "Function", "Date", "Math", "performance",
      "crypto", "fs", "net", "http", "https", "child_process", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate",
      "clearImmediate", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
    ]);

    const analyze = (file: string, text: string, expectedExports: readonly string[]): void => {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const scopeBindings = new Map<ts.Node, Set<string>>([[source, new Set()]]);
      const scopeParent = new Map<ts.Node, ts.Node>();
      const nodeScope = new Map<ts.Node, ts.Node>();
      const addName = (scope: ts.Node, name: string): void => {
        if (sensitiveBindings.has(name)) throw new Error(`forbidden sensitive binding ${name} in ${file}`);
        scopeBindings.get(scope)?.add(name);
      };
      const addBinding = (scope: ts.Node, name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) { addName(scope, name.text); return; }
        for (const element of name.elements) if (!ts.isOmittedExpression(element)) addBinding(scope, element.name);
      };
      const isFunctionScope = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
        ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
        || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
      const collectDeclarations = (node: ts.Node, scope: ts.Node): void => {
        nodeScope.set(node, scope);
        if (isFunctionScope(node)) {
          if (ts.isFunctionDeclaration(node) && node.name) addName(scope, node.name.text);
          const functionScope = node;
          scopeBindings.set(functionScope, new Set());
          scopeParent.set(functionScope, scope);
          nodeScope.set(node, functionScope);
          if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) addName(functionScope, node.name.text);
          for (const parameter of node.parameters) addBinding(functionScope, parameter.name);
          ts.forEachChild(node, child => collectDeclarations(child, functionScope));
          return;
        }
        if (ts.isBlock(node) || ts.isCatchClause(node)) {
          const blockScope = node;
          scopeBindings.set(blockScope, new Set());
          scopeParent.set(blockScope, scope);
          nodeScope.set(node, blockScope);
          if (ts.isCatchClause(node) && node.variableDeclaration) addBinding(blockScope, node.variableDeclaration.name);
          ts.forEachChild(node, child => collectDeclarations(child, blockScope));
          return;
        }
        if (ts.isVariableDeclaration(node)) addBinding(scope, node.name);
        if ((ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) addName(scope, node.name.text);
        if (ts.isImportClause(node) && node.name) addName(scope, node.name.text);
        if (ts.isImportSpecifier(node)) addName(scope, node.name.text);
        if (ts.isNamespaceImport(node)) addName(scope, node.name.text);
        ts.forEachChild(node, child => collectDeclarations(child, scope));
      };
      collectDeclarations(source, source);

      const exports = source.statements.flatMap(statement => {
        const isExported = ts.canHaveModifiers(statement)
          && (ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
        if (!isExported) return [];
        if (ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) return statement.name ? [statement.name.text] : [];
        if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name.text] : ["<non-identifier-export>"]);
        return ["<unsupported-export>"];
      });
      if (exports.length !== expectedExports.length || exports.some((name, index) => name !== expectedExports[index])) {
        throw new Error(`unexpected exports in ${file}: ${exports.join(",")}`);
      }

      const isTypePosition = (node: ts.Identifier): boolean => {
        let current: ts.Node | undefined = node;
        while (current && current !== source) {
          if (ts.isTypeNode(current)) return true;
          if (ts.isExpression(current) || ts.isStatement(current)) return false;
          current = current.parent;
        }
        return false;
      };
      const isPropertyName = (node: ts.Identifier): boolean => {
        const parent = node.parent;
        return (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && parent.name === node)
          || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isImportSpecifier(parent)) && parent.name === node);
      };
      const isLexicallyDeclared = (node: ts.Identifier): boolean => {
        let scope: ts.Node | undefined = nodeScope.get(node) ?? source;
        while (scope) {
          if (scopeBindings.get(scope)?.has(node.text)) return true;
          scope = scopeParent.get(scope);
        }
        return false;
      };
      const allowedConstructorAssignment = (node: ts.BinaryExpression): boolean => {
        const left = node.left.getText(source);
        if (!["this.name", "this.stateKind", "this.eventType"].includes(left) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
        let current: ts.Node | undefined = node.parent;
        while (current && !ts.isConstructorDeclaration(current)) current = current.parent;
        if (!current || !ts.isClassDeclaration(current.parent)) return false;
        return current.parent.name?.text === "ChatTurnIllegalTransitionError";
      };

      const visit = (node: ts.Node): void => {
        if (ts.isImportEqualsDeclaration(node)) throw new Error(`forbidden import-equals in ${file}`);
        if (ts.isImportDeclaration(node)) {
          if (file === "ChatTurnTypes.ts" || !node.importClause?.isTypeOnly || node.moduleSpecifier.getText(source) !== "\"./ChatTurnTypes\"") {
            throw new Error(`forbidden import in ${file}: ${node.getText(source)}`);
          }
        }
        if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) throw new Error(`forbidden export form in ${file}`);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error(`dynamic import in ${file}`);

        const isAssignment = ts.isBinaryExpression(node)
          && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        if (isAssignment && !allowedConstructorAssignment(node)) throw new Error(`forbidden assignment in ${file}: ${node.getText(source)}`);
        if (ts.isDeleteExpression(node) || ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
          && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))) {
          throw new Error(`forbidden update/delete in ${file}: ${node.getText(source)}`);
        }

        if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
          const receiver = node.expression.expression.getText(source);
          const method = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : ts.isStringLiteralLike(node.expression.argumentExpression) ? node.expression.argumentExpression.text : "";
          if (mutatingMethods.has(method) || (receiver === "Object" && objectMutators.has(method)) || (receiver === "Reflect" && reflectMutators.has(method))) {
            throw new Error(`forbidden mutating call in ${file}: ${node.getText(source)}`);
          }
        }

        if (node.kind === ts.SyntaxKind.ThisKeyword) {
          let assignment = node.parent;
          while (ts.isPropertyAccessExpression(assignment) || ts.isElementAccessExpression(assignment)) assignment = assignment.parent;
          if (!ts.isBinaryExpression(assignment) || !allowedConstructorAssignment(assignment)) throw new Error(`forbidden this access in ${file}`);
        }
        if (ts.isIdentifier(node) && !isLexicallyDeclared(node) && !isTypePosition(node) && !isPropertyName(node)) {
          const allowedMembers = allowedRuntimeGlobals.get(node.text);
          if (!allowedMembers) throw new Error(`unknown runtime global ${node.text} in ${file}`);
          const parent = node.parent;
          if (ts.isPropertyAccessExpression(parent) && parent.expression === node && !allowedMembers.has(parent.name.text)) {
            throw new Error(`forbidden runtime global member ${node.text}.${parent.name.text} in ${file}`);
          }
          if (ts.isElementAccessExpression(parent) && parent.expression === node) throw new Error(`forbidden computed runtime global in ${file}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    };
    analyze("ChatTurnTypes.ts", fs.readFileSync(path.join(turnDir, "ChatTurnTypes.ts"), "utf8"), ["ChatTurnOutcome", "ChatTurnState", "ChatTurnEvent", "ChatTurnEffect", "ChatTurnTransition"]);
    analyze("ChatTurnReducer.ts", fs.readFileSync(path.join(turnDir, "ChatTurnReducer.ts"), "utf8"), ["ChatTurnIllegalTransitionError", "initialChatTurnState", "reduceChatTurn"]);

    const maliciousCases = [
      ["import equals", 'import dependency = require("dependency");'],
      ["export declaration", "const value = 1; export { value };"],
      ["export assignment", "const value = 1; export = value;"],
      ["computed global", 'globalThis["fetch"]("/");'],
      ["process stdout", 'process.stdout.write("leak");'],
      ["nested prohibited parameter shadow", 'function nested(process: unknown) { return process; }'],
      ["nested prohibited local shadow", 'function nested() { const console = {}; return console; }'],
      ["prohibited destructuring shadow", 'const { fetch } = source;'],
      ["nested ordinary binding does not hide top-level leak", 'function nested(leak: unknown) { return leak; } leak();'],
      ["named function expression does not hide ambient global", 'const holder = function indexedDB() { return indexedDB; }; indexedDB.open("db");'],
      ["console output", 'console.log("leak");'],
      ["this I/O", 'this.vault.read();'],
      ["Object.defineProperty", 'Object.defineProperty(state, "kind", { value: "idle" });'],
      ["function-argument alias mutation", 'function mutate(value: unknown[]) { value.push(event); } mutate(state.effects);'],
      ["eval", 'eval("state.kind = idle");'],
      ["Function constructor", 'Function("return fetch()")();'],
      ["direct alias assignment", 'const alias = state; alias.kind = "idle";'],
      ["nested alias mutation", "const alias = state.effects; alias.push(event);"],
      ["destructured alias mutation", "const { effects } = state; effects.push(event);"],
      ["computed alias mutation", 'const alias = state.effects; alias["push"](event);'],
      ["Object.assign alias mutation", "const alias = event; Object.assign(alias, {});"],
      ["Reflect.set alias mutation", 'const alias = state; Reflect.set(alias, "kind", "idle");'],
      ["unexpected named export", "export const surprise = 1;"],
    ] as const;
    for (const [name, snippet] of maliciousCases) {
      expect(() => analyze(`${name}.ts`, snippet, [])).toThrow();
    }
    expect(() => analyze("recursive-function-expression.ts", 'const factorial = function recurse(value: number): number { return value <= 1 ? 1 : value * recurse(value - 1); }; factorial(3);', [])).not.toThrow();
  });
});
