export const CHATVIEW_CRITICAL_MUTANTS = Object.freeze([
  Object.freeze({
    id: "reader_flat_shape_fallback_removed",
    category: "historical-wire-compatibility",
    file: "src/services/chat/ManagedToolExecution.ts",
    anchorLine: 41,
    anchorText: "return recordValue(request?.function) ?? recordValue(record.function) ?? record;",
    replacement: "return recordValue(request?.function) ?? recordValue(record.function);",
    testPaths: Object.freeze([
      "src/services/chat/__tests__/managed-tool-execution.test.ts",
      "src/services/chat/__tests__/accepted-chat-request-snapshot.test.ts",
      "src/views/chatview/__tests__/agent-chat-view-coordinator.test.ts",
      "src/views/chatview/__tests__/agent-workspace-ui.test.ts",
    ]),
  }),
  Object.freeze({
    id: "reader_object_arguments_forced_empty",
    category: "historical-wire-compatibility",
    file: "src/services/chat/ManagedToolExecution.ts",
    anchorLine: 52,
    anchorText: "const normalizedArguments = argumentsJson(fn.arguments);",
    replacement: 'const normalizedArguments = typeof fn.arguments === "string" ? fn.arguments : "{}";',
    testPaths: Object.freeze([
      "src/services/chat/__tests__/managed-tool-execution.test.ts",
      "src/services/chat/__tests__/accepted-chat-request-snapshot.test.ts",
    ]),
  }),
  Object.freeze({
    id: "reader_server_name_fallback_removed",
    category: "server-tool-ownership",
    file: "src/services/chat/ManagedToolExecution.ts",
    anchorLine: 68,
    anchorText: `return record.executedOn === "server"
    || isServerExecutedManagedToolName(toolCallFunctionName(toolCallFunctionRecord(record)));`,
    replacement: 'return record.executedOn === "server";',
    testPaths: Object.freeze([
      "src/services/chat/__tests__/managed-tool-execution.test.ts",
      "src/services/chat/__tests__/accepted-chat-request-snapshot.test.ts",
      "src/services/chat/__tests__/managed-chat-replay-contract.test.ts",
      "src/views/chatview/__tests__/managed-agent-controller-runtime-seam.test.ts",
    ]),
  }),
  Object.freeze({
    id: "projector_empty_server_checkpoint_kept",
    category: "provider-transcript-validity",
    file: "src/services/chat/AcceptedChatRequestSnapshot.ts",
    anchorLine: 199,
    anchorText: `const emptyServerOnlyCheckpoint = message.role === "assistant"
      && (message.tool_calls?.length ?? 0) > 0
      && clientCalls.length === 0
      && prepared.content === "";`,
    replacement: "const emptyServerOnlyCheckpoint = false;",
    testPaths: Object.freeze([
      "src/services/chat/__tests__/accepted-chat-request-snapshot.test.ts",
      "src/services/chat/__tests__/managed-chat-replay-contract.test.ts",
      "src/views/chatview/__tests__/managed-agent-controller-runtime-seam.test.ts",
    ]),
  }),
  Object.freeze({
    id: "projector_malformed_legacy_call_fails_open",
    category: "fail-closed-projection",
    file: "src/services/chat/AcceptedChatRequestSnapshot.ts",
    anchorLine: 140,
    anchorText: 'if (!fn) throw new Error("Managed history contains a malformed tool call.");',
    replacement: 'if (!fn) return { id: call.id, type: "function", function: { name: "unknown_tool", arguments: "{}" } };',
    testPaths: Object.freeze([
      "src/services/chat/__tests__/accepted-chat-request-snapshot.test.ts",
    ]),
  }),
  Object.freeze({
    id: "projector_duplicate_client_ids_allowed",
    category: "provider-transcript-validity",
    file: "src/services/chat/AcceptedChatRequestSnapshot.ts",
    anchorLine: 193,
    anchorText: "!call.id || declaredClientToolCallIds.has(call.id)",
    replacement: "false",
    testPaths: Object.freeze([
      "src/services/chat/__tests__/accepted-chat-request-snapshot.test.ts",
      "src/services/chat/__tests__/managed-chat-projector-generative.test.ts",
    ]),
  }),
  Object.freeze({
    id: "serializer_reconstructed_tool_calls_dropped",
    category: "durable-history-integrity",
    file: "src/views/chatview/storage/ChatMarkdownSerializer.ts",
    anchorLine: 257,
    anchorText: "tool_calls: list.toolCalls",
    replacement: "tool_calls: []",
    testPaths: Object.freeze([
      "src/views/chatview/storage/__tests__/ChatMarkdownSerializer.test.ts",
      "src/views/chatview/__tests__/agent-workspace-ui.test.ts",
    ]),
  }),
  Object.freeze({
    id: "runtime_resume_uses_full_continuation",
    category: "session-continuation",
    file: "src/views/chatview/turn/ManagedChatRuntimeAdapter.ts",
    anchorLine: 689,
    anchorText: `return resumed
      ? composeAcceptedChatContinuationDelta(accepted, input.postCheckpointDurableSnapshot)
      : composeAcceptedChatContinuation(accepted, input.postCheckpointDurableSnapshot);`,
    replacement: "return composeAcceptedChatContinuation(accepted, input.postCheckpointDurableSnapshot);",
    testPaths: Object.freeze([
      "src/views/chatview/__tests__/managed-chat-runtime-adapter.test.ts",
    ]),
  }),
  Object.freeze({
    id: "runtime_session_checkpoint_exposed_before_done",
    category: "stream-durability",
    file: "src/views/chatview/turn/ManagedChatRuntimeAdapter.ts",
    anchorLine: 888,
    anchorText: `if (event.kind === "session_committed") {
            if (
              committedCheckpoint
              || event.checkpoint.id !== expectedCheckpoint.id
              || event.checkpoint.revision !== expectedCheckpoint.revision
            ) return false;
            committedCheckpoint = event.checkpoint;
            continue;
          }`,
    replacement: `if (event.kind === "session_committed") {
            if (
              committedCheckpoint
              || event.checkpoint.id !== expectedCheckpoint.id
              || event.checkpoint.revision !== expectedCheckpoint.revision
            ) return false;
            committedCheckpoint = event.checkpoint;
          }`,
    testPaths: Object.freeze([
      "src/views/chatview/__tests__/managed-chat-runtime-adapter.test.ts",
    ]),
  }),
  Object.freeze({
    id: "controller_server_tools_reenter_local_continuation",
    category: "server-tool-ownership",
    file: "src/views/chatview/ManagedAgentController.ts",
    anchorLine: 685,
    anchorText: '(streamedTool) => streamedTool.location !== "server"',
    replacement: "() => true",
    testPaths: Object.freeze([
      "src/views/chatview/__tests__/managed-agent-controller-runtime-seam.test.ts",
    ]),
  }),
  Object.freeze({
    id: "replay_unknowable_tool_fails_open",
    category: "replay-safety",
    file: "src/views/chatview/AgentChatView.ts",
    anchorLine: 118,
    anchorText: "if (!name) return true;",
    replacement: "if (!name) return false;",
    testPaths: Object.freeze([
      "src/views/chatview/__tests__/agent-chat-view-coordinator.test.ts",
    ]),
  }),
  Object.freeze({
    id: "renderer_historical_name_fallback_lost",
    category: "historical-ui-semantics",
    file: "src/views/chatview/AgentConversationRenderer.ts",
    anchorLine: 793,
    anchorText: 'name: fn?.name ?? "unknown_tool"',
    replacement: 'name: "unknown_tool"',
    testPaths: Object.freeze([
      "src/views/chatview/__tests__/agent-workspace-ui.test.ts",
    ]),
  }),
  Object.freeze({
    id: "renderer_server_location_forced_vault",
    category: "historical-ui-semantics",
    file: "src/views/chatview/AgentConversationRenderer.ts",
    anchorLine: 794,
    anchorText: 'location: isServerExecutedManagedToolCall(tool) ? "server" : "vault"',
    replacement: 'location: "vault"',
    testPaths: Object.freeze([
      "src/views/chatview/__tests__/agent-workspace-ui.test.ts",
    ]),
  }),
]);
