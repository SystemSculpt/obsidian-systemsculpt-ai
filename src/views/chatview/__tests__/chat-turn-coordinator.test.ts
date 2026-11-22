/** @jest-environment jsdom */

import { ChatTurnCoordinator } from "../ChatTurnCoordinator";
import type { AgentRunInput, AgentRunResult } from "../../../chat/managed/ChatSession";
import type { AgentConversationSnapshot } from "../../../chat/ChatConversation";
import type { ChatMessage } from "../../../types";

function receiptHarness() {
  const messages: ChatMessage[] = [];
  const snapshot = () => ({
    chatId: "original-chat",
    title: "Original chat",
    version: messages.length,
    messages: [...messages],
    contextFiles: [],
  });
  const transcript = {
    snapshot,
    commitUser: jest.fn(async ({ message }: { message: ChatMessage }) => {
      messages.push(message);
      return snapshot();
    }),
    persistFailedReceipt: jest.fn(async () => snapshot()),
    idle: jest.fn(async () => undefined),
  };
  let sessionSnapshot: AgentConversationSnapshot = {
    status: "idle", runId: null, turnId: null, messages: [], parts: [],
  };
  let turns: ChatTurnCoordinator;
  const host = {
    viewer: {},
    plugin: {
      settings: { licenseKey: "test-license" },
      getLoadedPluginBuildId: async () => `sha256:${"a".repeat(64)}`,
    },
    agent: {
      getSnapshot: () => sessionSnapshot,
      start: async (input: AgentRunInput): Promise<AgentRunResult> => {
        await input.beforeSend?.();
        sessionSnapshot = {
          status: "failed", runId: "run-original", turnId: input.turnId, messages: [], parts: [],
          terminalError: { code: "agent_provider_failed", message: "Provider failed", retryable: true },
        };
        turns.recordFailureReport(input.turnId, `report_${"b".repeat(32)}`);
        return { kind: "failed", snapshot: sessionSnapshot, error: sessionSnapshot.terminalError! };
      },
    },
    transcript,
    attachmentStore: { hydrateMessage: async (message: ChatMessage) => message },
    workspace: {
      setRunPending: jest.fn(),
      setBanner: jest.fn(),
      setHistory: jest.fn(async () => undefined),
      setAgentSnapshot: jest.fn(async () => undefined),
      settleUnfinishedRun: jest.fn(async () => undefined),
      resetMessageEditor: jest.fn(),
    },
    contextManager: { getPinnedFiles: () => [] },
    queueRepository: { move: jest.fn(async () => undefined) },
    chatId: "original-chat",
    draftKey: "original-chat",
    conversationOriginToken: "original-origin",
    approvalMode: "ask",
    automationApprovalMode: "interactive",
    sessionTrustedToolNames: new Set<string>(),
    runConversationOrigins: new Map<string, string>(),
    thinClientId: `client_${"c".repeat(32)}`,
    clientMonotonicNow: () => 0,
    recordUiLifecycle: jest.fn(),
    blockReadOnlyHistoryAction: () => false,
    isCurrentConversationOrigin: (origin: string): boolean => origin === host.conversationOriginToken,
    historyForDisplay: () => messages,
    readThinAgentContextSources: async () => ({ sources: [] }),
    applyTranscriptIdentity: jest.fn(),
    updateViewState: jest.fn(),
    clearUncommittedFork: jest.fn(),
    renderAgentSnapshot: jest.fn(),
    logAgentError: jest.fn(),
  };
  turns = new ChatTurnCoordinator(host as unknown as ConstructorParameters<typeof ChatTurnCoordinator>[0]);
  return { turns, host, transcript };
}

describe("Chat turn failure receipt ownership", () => {
  afterEach(() => jest.useRealTimers());

  it("retries a failed turn receipt against its original transcript after navigation", async () => {
    jest.useFakeTimers();
    const { turns, host, transcript } = receiptHarness();
    transcript.persistFailedReceipt.mockRejectedValueOnce(new Error("vault temporarily unavailable"));

    await turns.executeSubmission({ text: "Keep this failure receipt", mode: "send" });
    expect(transcript.persistFailedReceipt).toHaveBeenCalledTimes(1);
    const replacement = {
      ...transcript,
      snapshot: () => ({ ...transcript.snapshot(), chatId: "replacement-chat", messages: [] }),
      persistFailedReceipt: jest.fn(async () => transcript.snapshot()),
    };
    host.transcript = replacement;
    host.conversationOriginToken = "replacement-origin";
    turns.resetMessageEdits();
    host.applyTranscriptIdentity.mockClear();

    await jest.runOnlyPendingTimersAsync();

    expect(transcript.persistFailedReceipt).toHaveBeenCalledTimes(2);
    expect(transcript.persistFailedReceipt).toHaveBeenLastCalledWith(expect.objectContaining({
      reportId: `report_${"b".repeat(32)}`,
      failureCode: "agent_provider_failed",
      retryable: true,
    }));
    expect(replacement.persistFailedReceipt).not.toHaveBeenCalled();
    expect(host.applyTranscriptIdentity).not.toHaveBeenCalled();
  });

  it("does not adopt an old identity when a receipt write completes after navigation", async () => {
    const { turns, host, transcript } = receiptHarness();
    let finish!: () => void;
    const write = new Promise<void>((resolve) => { finish = resolve; });
    transcript.persistFailedReceipt.mockImplementationOnce(async () => {
      await write;
      return transcript.snapshot();
    });

    await turns.executeSubmission({ text: "Keep the original target", mode: "send" });
    expect(transcript.persistFailedReceipt).toHaveBeenCalledTimes(1);
    host.transcript = { ...transcript };
    host.conversationOriginToken = "replacement-origin";
    turns.resetMessageEdits();
    host.applyTranscriptIdentity.mockClear();
    finish();
    await turns.persistOnClose();

    expect(host.applyTranscriptIdentity).not.toHaveBeenCalled();
    expect(host.workspace.resetMessageEditor).toHaveBeenCalledTimes(1);
  });
});

describe("Chat turn failure follow-up", () => {
  function failure(status: number, code: string) {
    return Object.assign(new Error(`SystemSculpt could not start this chat (${status}).`), { code, status });
  }

  function followUpHarness() {
    const { turns, host } = receiptHarness();
    const recheckLicenseAfterRejection = jest.fn();
    const refreshCreditsBalance = jest.fn(async () => undefined);
    Object.assign(host.plugin, { recheckLicenseAfterRejection });
    Object.assign(host, { refreshCreditsBalance });
    return { turns, recheckLicenseAfterRejection, refreshCreditsBalance };
  }

  it.each([
    [401, "license_invalid"],
    [403, "access_denied"],
  ])("asks the license manager to re-check a chat refused with %s %s", (status, code) => {
    const { turns, recheckLicenseAfterRejection, refreshCreditsBalance } = followUpHarness();

    turns.refreshCreditsAfterBillingFailure(failure(status, code));

    expect(recheckLicenseAfterRejection).toHaveBeenCalledTimes(1);
    expect(refreshCreditsBalance).not.toHaveBeenCalled();
  });

  it.each([
    [402, "insufficient_credits"],
    [429, "auth_rate_limited"],
    [500, "agent_bootstrap_failed"],
    [503, "auth_unavailable"],
  ])("leaves the license alone for %s %s", (status, code) => {
    const { turns, recheckLicenseAfterRejection } = followUpHarness();

    turns.refreshCreditsAfterBillingFailure(failure(status, code));

    expect(recheckLicenseAfterRejection).not.toHaveBeenCalled();
  });
});
