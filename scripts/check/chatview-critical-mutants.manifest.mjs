export const CHATVIEW_CRITICAL_MUTANTS = Object.freeze([
  Object.freeze({
    id: "message_update_terminalization_removed",
    category: "native-message-reconciliation",
    file: "src/views/chatview/thin/ThinAgentBridge.ts",
    anchorLine: 1441,
    anchorText: "this.applyMessageUpdate(outer.message);",
    replacement: "void outer.message;",
    testPaths: Object.freeze([
      "src/views/chatview/thin/__tests__/thin-agent-bridge.test.ts",
    ]),
  }),
  Object.freeze({
    id: "mutation_approval_ack_bypassed",
    category: "vault-mutation-safety",
    file: "src/views/chatview/thin/ThinAgentBridge.ts",
    anchorLine: 1062,
    anchorText: "if (!acknowledged || !approved) return;",
    replacement: "if (!approved) return;",
    testPaths: Object.freeze([
      "src/views/chatview/thin/__tests__/thin-agent-bridge.test.ts",
    ]),
  }),
  Object.freeze({
    id: "tool_continuation_not_announced",
    category: "native-tool-continuation",
    file: "src/views/chatview/thin/ThinAgentBridge.ts",
    anchorLine: 1766,
    anchorText: "active.transport.expectToolContinuation();",
    replacement: "active.transport.resetResumeState();",
    testPaths: Object.freeze([
      "src/views/chatview/thin/__tests__/thin-agent-bridge.test.ts",
    ]),
  }),
  Object.freeze({
    id: "mutation_receipts_truncated",
    category: "vault-mutation-safety",
    file: "src/views/chatview/thin/ThinAgentMutationJournal.ts",
    anchorLine: 196,
    anchorText: "records: [...this.records.values()]",
    replacement: "records: [...this.records.values()].slice(-256)",
    testPaths: Object.freeze([
      "src/views/chatview/thin/__tests__/thin-agent-mutation-journal.test.ts",
    ]),
  }),
  Object.freeze({
    id: "conversation_scope_removed_from_receipts",
    category: "vault-mutation-safety",
    file: "src/views/chatview/thin/ThinAgentMutationJournal.ts",
    anchorLine: 35,
    anchorText: "return `${conversationId}\\0${toolCallId}`;",
    replacement: "return toolCallId;",
    testPaths: Object.freeze([
      "src/views/chatview/thin/__tests__/thin-agent-mutation-journal.test.ts",
    ]),
  }),
]);
