export const CHATVIEW_CRITICAL_MUTANTS = Object.freeze([
  Object.freeze({
    id: "authoritative_user_collision_not_failed_closed",
    category: "native-message-reconciliation",
    file: "src/views/chatview/thin/FirstPartyThinAgentSession.ts",
    anchorLine: 687,
    anchorText: `this.protocolError(
        "The authoritative user message conflicts with the pending submission.",
      );`,
    replacement: "void authoritative;",
    testPaths: Object.freeze([
      "src/views/chatview/thin/__tests__/first-party-thin-agent-session.test.ts",
    ]),
  }),
  Object.freeze({
    id: "run_state_conflict_not_failed_closed",
    category: "server-authority",
    file: "src/views/chatview/thin/FirstPartyThinAgentSession.ts",
    anchorLine: 610,
    anchorText: `this.protocolError(
          "SystemSculpt returned conflicting state for one session cursor.",
          "run_state_conflict",
        );`,
    replacement: "void incoming;",
    testPaths: Object.freeze([
      "src/views/chatview/thin/__tests__/first-party-thin-agent-session.test.ts",
    ]),
  }),
  Object.freeze({
    id: "command_ack_callback_removed",
    category: "delivery-recovery",
    file: "src/views/chatview/thin/FirstPartyThinAgentSession.ts",
    anchorLine: 465,
    anchorText: "this.options.onCommandAck?.(parsed);",
    replacement: "void parsed;",
    testPaths: Object.freeze([
      "src/views/chatview/thin/__tests__/first-party-thin-agent-session.test.ts",
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
