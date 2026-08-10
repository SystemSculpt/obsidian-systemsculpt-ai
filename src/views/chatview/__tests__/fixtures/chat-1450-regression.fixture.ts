/**
 * Content-free structural reproduction of the private 14:50 ChatView export.
 *
 * This fixture intentionally preserves only the failure shapes needed for
 * acceptance. It contains no original prompt, response text, vault path,
 * file content, provider payload, request identity, or tool-call identity.
 */
export const CHAT_1450_REGRESSION_FIXTURE = {
  mixedRead: {
    name: "read",
    input: {
      paths: [
        "Fixture/available-a.md",
        "Fixture/unavailable.md",
        "Fixture/available-b.md",
      ],
    },
    result: {
      success: false,
      data: {
        files: [
          { path: "Fixture/available-a.md", content: "fixture-a" },
          {
            path: "Fixture/unavailable.md",
            content: "",
            error: "Fixture item unavailable.",
          },
          { path: "Fixture/available-b.md", content: "fixture-b" },
        ],
      },
      error: {
        code: "TOOL_OPERATION_FAILED",
        message: "Fixture batch contained a failed item.",
      },
    },
  },
  allFailedRead: {
    name: "read",
    input: {
      paths: ["Fixture/missing-a.md", "Fixture/missing-b.md"],
    },
    result: {
      success: false,
      data: {
        files: [
          {
            path: "Fixture/missing-a.md",
            content: "",
            error: "Fixture item unavailable.",
          },
          {
            path: "Fixture/missing-b.md",
            content: "",
            error: "Fixture item unavailable.",
          },
        ],
      },
      error: {
        code: "TOOL_OPERATION_FAILED",
        message: "Fixture batch contained no successful items.",
      },
    },
  },
  invalidEmptyClientCalls: [
    { name: "read", arguments: {} },
    { name: "list_items", arguments: {} },
  ],
  continuationMarker: "SANITIZED_CONTINUATION_MARKER",
  duplicateTerminalError: {
    code: "TOOL_EXECUTION_FAILED",
    message: "Sanitized duplicate response-wide failure.",
    retryable: true,
  },
} as const;

