/**
 * @jest-environment jsdom
 */

import { TFile } from "obsidian";
import { createInitialAgentConversation } from "../AgentConversation";
import { AgentChatView } from "../AgentChatView";

const submit = {
  text: "Summarize Project.md",
  webSearch: true,
  mode: "send" as const,
};

function executionHarness(result: Record<string, unknown>) {
  const workspace = {
    setHistory: jest.fn(async () => undefined),
    setAgentSnapshot: jest.fn(async () => undefined),
    settleCompletedRun: jest.fn(async () => undefined),
    setRunPending: jest.fn(),
    setBanner: jest.fn(),
    setInputText: jest.fn(),
    restoreRejectedSubmission: jest.fn(),
    hasDraft: jest.fn(() => false),
    focus: jest.fn(),
  };
  const view = {
    activeRunPromise: null,
    queuedFollowUps: [],
    pendingRetry: null,
    activeWebSearch: false,
    activeIncludeContextFiles: true,
    automationApprovalMode: "interactive",
    suppressQueueDrain: false,
    workspace,
    transcript: { snapshot: jest.fn(() => ({ messages: [] })) },
    controller: { start: jest.fn(() => Promise.resolve(result)) },
    handleRunResult: jest.fn(),
    drainQueue: jest.fn(async () => undefined),
    syncQueue: jest.fn(),
    scheduleQueuePersistence: jest.fn(),
  };
  return { view, workspace };
}

describe("AgentChatView coordinator", () => {
  it("shows pending run state and restores the prompt when admission is denied", async () => {
    const result = {
      kind: "admission_denied",
      outcome: "license_required",
      snapshot: createInitialAgentConversation(),
    };
    const { view, workspace } = executionHarness(result);

    await (AgentChatView.prototype as any).executeSubmission.call(
      view,
      submit,
      { includeContextFiles: false },
    );

    expect(workspace.setRunPending.mock.calls).toEqual([[true], [false]]);
    expect(workspace.setAgentSnapshot).toHaveBeenCalledWith(null);
    expect(workspace.restoreRejectedSubmission).toHaveBeenCalledWith(submit);
    expect(view.activeWebSearch).toBe(false);
    expect(view.activeIncludeContextFiles).toBe(true);
    expect(view.handleRunResult).toHaveBeenCalledWith(result);
    expect(view.drainQueue).not.toHaveBeenCalled();
  });

  it("does not restore a submission that was durably committed before a host-side failure", async () => {
    const result = {
      kind: "failed",
      error: { code: "projection_failed", message: "The renderer failed." },
      snapshot: createInitialAgentConversation(),
    };
    const { view, workspace } = executionHarness(result);
    let committedMessage: any;
    view.controller.start.mockImplementation((input: any) => {
      committedMessage = input.commit.message;
      view.transcript.snapshot.mockReturnValue({ messages: [committedMessage] });
      return Promise.resolve(result);
    });

    await (AgentChatView.prototype as any).executeSubmission.call(view, submit);

    expect(committedMessage).toEqual(expect.objectContaining({ role: "user", content: submit.text }));
    expect(workspace.restoreRejectedSubmission).not.toHaveBeenCalled();
  });

  it("commits ordered mixed attachments and restores them when admission is denied", async () => {
    const attachment = {
      status: "ready" as const,
      id: "image-hash",
      name: "diagram.png",
      mimeType: "image/png",
      byteLength: 4,
      kind: "image" as const,
      contentPart: { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } },
    };
    const result = {
      kind: "admission_denied",
      outcome: "license_required",
      snapshot: createInitialAgentConversation(),
    };
    const { view, workspace } = executionHarness(result);
    const attachmentSubmission = {
      text: "",
      webSearch: false,
      mode: "send",
      attachments: [attachment],
    } as const;

    await (AgentChatView.prototype as any).executeSubmission.call(view, attachmentSubmission);

    const startInput = view.controller.start.mock.calls[0][0];
    expect(startInput.commit.message.content).toEqual([attachment.contentPart]);
    expect(startInput.commit.message.attachmentMetadata).toEqual([
      expect.objectContaining({ id: attachment.id, name: attachment.name, contentPartIndex: 0 }),
    ]);
    expect(workspace.restoreRejectedSubmission).toHaveBeenCalledWith(attachmentSubmission);
  });

  it("does not rewrite a lazy queue attachment before admission", async () => {
    const contentRef = {
      schema: "systemsculpt-chat-attachment-v1" as const,
      payload: "image-bytes" as const,
      sha256: "a".repeat(64),
      byteLength: 3,
    };
    const attachment = {
      status: "ready" as const,
      id: "image-1",
      name: "diagram.png",
      mimeType: "image/png",
      byteLength: 3,
      kind: "image" as const,
      contentPart: { type: "image_url" as const, image_url: { url: "lazy" } },
      contentRef,
    };
    const externalizeAttachments = jest.fn();
    const view = { attachmentStore: { externalizeAttachments } };

    const prepared = await (AgentChatView.prototype as any).prepareSubmission.call(view, {
      text: "Compare",
      webSearch: false,
      mode: "send",
      attachments: [attachment],
    });

    expect(prepared.attachments).toEqual([attachment]);
    expect(externalizeAttachments).not.toHaveBeenCalled();
  });

  it("maps Full Access to an approval-free vault tool policy including trash", async () => {
    const result = {
      kind: "admission_denied",
      outcome: "license_required",
      snapshot: createInitialAgentConversation(),
    };
    const { view } = executionHarness(result);
    Object.assign(view, {
      approvalMode: "full-access",
      sessionTrustedToolNames: new Set<string>(),
    });

    await (AgentChatView.prototype as any).executeSubmission.call(view, submit);

    expect(view.controller.start.mock.calls[0][0].approvalPolicy).toEqual({
      requireDestructiveApproval: false,
    });
  });

  it("shares chat-scoped trust with the active run so remembered approvals affect continuations", async () => {
    const result = {
      kind: "admission_denied",
      outcome: "license_required",
      snapshot: createInitialAgentConversation(),
    };
    const { view } = executionHarness(result);
    const sessionTrustedToolNames = new Set<string>();
    Object.assign(view, {
      approvalMode: "ask",
      sessionTrustedToolNames,
    });

    await (AgentChatView.prototype as any).executeSubmission.call(view, submit);

    expect(view.controller.start.mock.calls[0][0].approvalPolicy.trustedToolNames)
      .toBe(sessionTrustedToolNames);
  });

  it("prepares retry from exact durable multipart identity without including attachment payload in the prompt", async () => {
    const attachment = {
      status: "ready" as const,
      id: "document-original-source-hash",
      name: "brief.pdf",
      mimeType: "application/pdf",
      byteLength: 8000,
      kind: "document" as const,
      contentPart: {
        type: "text" as const,
        text: "--- BEGIN ATTACHED FILE: brief.pdf (application/pdf) ---\nExtracted PDF\n--- END ATTACHED FILE: brief.pdf ---",
      },
    };
    const message = {
      role: "user" as const,
      message_id: "user-multipart",
      content: [{ type: "text" as const, text: "Compare this" }, attachment.contentPart],
      attachmentMetadata: [{
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        byteLength: attachment.byteLength,
        kind: attachment.kind,
        contentPartIndex: 1,
      }],
    };
    const workspace = {
      hasDraft: jest.fn(() => false),
      setInputText: jest.fn(),
      restoreMessageAttachments: jest.fn(),
    };
    const view = {
      transcript: { snapshot: jest.fn(() => ({ version: 7, messages: [message] })) },
      attachmentStore: { hydrateMessage: jest.fn(async (candidate) => candidate) },
      workspace,
      activeRunPromise: null,
      pendingRetry: null,
    };

    await (AgentChatView.prototype as any).prepareRetry.call(view, message.message_id);

    expect(view.pendingRetry).toMatchObject({
      kind: "resend",
      targetMessageId: message.message_id,
      expectedIndex: 0,
      expectedVersion: 7,
    });
    expect(workspace.setInputText).toHaveBeenCalledWith("Compare this", { focus: true });
    expect(workspace.restoreMessageAttachments).toHaveBeenCalledWith([attachment]);
  });

  it("leaves a nonempty current draft untouched when retry-from-here is requested", async () => {
    const workspace = {
      hasDraft: jest.fn(() => true),
      setInputText: jest.fn(),
      restoreMessageAttachments: jest.fn(),
      focus: jest.fn(),
    };
    const view = {
      transcript: { snapshot: jest.fn(() => ({
        version: 2,
        messages: [{ role: "user", message_id: "user-1", content: "Old prompt" }],
      })) },
      workspace,
      activeRunPromise: null,
      pendingRetry: null,
    };

    await (AgentChatView.prototype as any).prepareRetry.call(view, "user-1");

    expect(view.pendingRetry).toBeNull();
    expect(workspace.setInputText).not.toHaveBeenCalled();
    expect(workspace.restoreMessageAttachments).not.toHaveBeenCalled();
    expect(workspace.focus).toHaveBeenCalledTimes(1);
  });

  it("makes a missing attachment explicit when retry hydration degrades", async () => {
    const message = {
      role: "user" as const,
      message_id: "user-1",
      content: "Compare this",
      attachmentMetadata: [{
        id: "image-1",
        name: "missing.png",
        mimeType: "image/png",
        byteLength: 3,
        kind: "image" as const,
        contentPartIndex: 1,
        contentRef: {
          schema: "systemsculpt-chat-attachment-v1" as const,
          payload: "image-bytes" as const,
          sha256: "a".repeat(64),
          byteLength: 3,
        },
      }],
    };
    const workspace = {
      hasDraft: jest.fn(() => false),
      setInputText: jest.fn(),
      restoreMessageAttachments: jest.fn(),
      setBanner: jest.fn(),
    };
    const view = {
      transcript: { snapshot: jest.fn(() => ({ version: 2, messages: [message] })) },
      attachmentStore: { hydrateMessage: jest.fn(async () => message) },
      workspace,
      activeRunPromise: null,
      pendingRetry: null,
    };

    await (AgentChatView.prototype as any).prepareRetry.call(view, "user-1");

    expect(workspace.setBanner).toHaveBeenCalledWith(
      "One or more attachments are unavailable. They were left out of this retry.",
      "error",
    );
    expect(workspace.restoreMessageAttachments).not.toHaveBeenCalled();
  });

  it("adds a Similar Notes drag as vault context without copying the file", async () => {
    const source = new TFile({ path: "Research/Project.md" });
    const addFileToContext = jest.fn(async () => undefined);
    const view = {
      app: { vault: { getAbstractFileByPath: jest.fn(() => source) } },
      contextManager: { addFileToContext },
    };

    await (AgentChatView.prototype as any).addDroppedVaultContext.call(view, "Research/Project.md");

    expect(view.app.vault.getAbstractFileByPath).toHaveBeenCalledWith("Research/Project.md");
    expect(addFileToContext).toHaveBeenCalledWith(source);
    expect(view.app.vault).not.toHaveProperty("createBinary");
  });

  it("preserves context policy when a follow-up is queued behind an active run", async () => {
    const { view } = executionHarness({
      kind: "completed",
      snapshot: createInitialAgentConversation(),
      operation: {},
    });
    view.activeRunPromise = Promise.resolve({ kind: "completed" });

    await (AgentChatView.prototype as any).executeSubmission.call(
      view,
      submit,
      { includeContextFiles: false },
    );

    expect(view.queuedFollowUps).toEqual([
      expect.objectContaining({
        text: submit.text,
        webSearch: true,
        includeContextFiles: false,
      }),
    ]);
    expect(view.controller.start).not.toHaveBeenCalled();
    expect(view.syncQueue).toHaveBeenCalledTimes(1);
  });

  it("drains the next follow-up only after a completed turn", async () => {
    const result = {
      kind: "completed",
      snapshot: createInitialAgentConversation(),
      operation: {},
    };
    const { view, workspace } = executionHarness(result);
    view.pendingRetry = {
      kind: "resend",
      message: { role: "user", content: "old", message_id: "old" },
      targetMessageId: "old",
      expectedIndex: 0,
      expectedVersion: 1,
    };

    await (AgentChatView.prototype as any).executeSubmission.call(view, submit);

    expect(view.pendingRetry).toBeNull();
    expect(workspace.setHistory).toHaveBeenCalledTimes(1);
    expect(workspace.setAgentSnapshot).toHaveBeenCalledTimes(1);
    expect(workspace.setAgentSnapshot).toHaveBeenCalledWith(null);
    expect(workspace.settleCompletedRun).toHaveBeenCalledTimes(1);
    expect(workspace.settleCompletedRun).toHaveBeenCalledWith(
      view.transcript.snapshot().messages,
    );
    expect(view.drainQueue).toHaveBeenCalledTimes(1);
  });

  it("keeps a queued follow-up in memory when its removal cannot be persisted", async () => {
    const queued = {
      id: "queued-1",
      text: "Do not lose me",
      webSearch: false,
      includeContextFiles: true,
    };
    const view = {
      queuedFollowUps: [queued],
      syncQueue: jest.fn(),
      persistQueueState: jest.fn(async () => { throw new Error("disk unavailable"); }),
      reportQueuePersistenceError: jest.fn(),
      executeSubmission: jest.fn(),
    };

    await (AgentChatView.prototype as any).drainQueue.call(view);

    expect(view.queuedFollowUps).toEqual([queued]);
    expect(view.executeSubmission).not.toHaveBeenCalled();
    expect(view.reportQueuePersistenceError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("keeps post-admission failures inline instead of duplicating them in a banner", () => {
    const workspace = { setBanner: jest.fn() };
    const view = { workspace, aiService: { releaseAcceptedChatRequest: jest.fn() }, updateViewState: jest.fn() };
    const result = {
      kind: "failed",
      operation: {},
      error: { code: "tool_failed", message: "Could not edit the note." },
      snapshot: createInitialAgentConversation(),
    };

    (AgentChatView.prototype as any).handleRunResult.call(view, result);

    expect(workspace.setBanner).not.toHaveBeenCalled();
    expect(view.updateViewState).toHaveBeenCalledTimes(1);
  });

  it("honors automation requests that intentionally omit attached context", async () => {
    const executeSubmission = jest.fn(async () => undefined);
    const view = {
      automationApprovalMode: "interactive",
      getInputText: jest.fn(() => "Inspect this"),
      isWebSearchEnabled: jest.fn(() => false),
      executeSubmission,
      focusInput: jest.fn(),
    };

    await AgentChatView.prototype.sendAutomationMessage.call(view as any, {
      includeContextFiles: false,
      focusAfterSend: false,
    });

    expect(executeSubmission).toHaveBeenCalledWith(
      { text: "Inspect this", webSearch: false, mode: "send" },
      { includeContextFiles: false },
    );
    expect(view.focusInput).not.toHaveBeenCalled();
  });

  it("carries a queued follow-up's context policy into stop-and-send-now", async () => {
    const executeSubmission = jest.fn(async () => undefined);
    const view = {
      queuedFollowUps: [{
        id: "queued-1",
        text: "Continue without attachments",
        webSearch: false,
        includeContextFiles: false,
      }],
      suppressQueueDrain: false,
      cancelQueuedFollowUp: jest.fn(),
      controller: { cancel: jest.fn(async () => undefined) },
      executeSubmission,
    };

    await (AgentChatView.prototype as any).runQueuedFollowUpNow.call(view, "queued-1");

    expect(view.cancelQueuedFollowUp).toHaveBeenCalledWith("queued-1");
    expect(view.controller.cancel).toHaveBeenCalledTimes(1);
    expect(executeSubmission).toHaveBeenCalledWith(
      { text: "Continue without attachments", webSearch: false, mode: "send" },
      { includeContextFiles: false },
    );
    expect(view.suppressQueueDrain).toBe(false);
  });

  it("does not trust a tool when a stale approval response is rejected", () => {
    const sessionTrustedToolNames = new Set<string>();
    const controller = {
      getSnapshot: jest.fn(() => ({
        parts: [{ kind: "tool", name: "write", approvalId: "approval-1" }],
      })),
      respondToApproval: jest.fn(() => false),
    };
    const view = { controller, sessionTrustedToolNames };

    (AgentChatView.prototype as any).respondToToolApproval.call(view, "approval-1", true, true);

    expect(controller.respondToApproval).toHaveBeenCalledWith("approval-1", true);
    expect(sessionTrustedToolNames).toEqual(new Set());
  });

  it("publishes remembered trust before approval settlement resumes the controller", () => {
    const sessionTrustedToolNames = new Set<string>();
    let trustedDuringSettlement = false;
    const controller = {
      getSnapshot: jest.fn(() => ({
        parts: [{ kind: "tool", name: "write", approvalId: "approval-1" }],
      })),
      respondToApproval: jest.fn(() => {
        trustedDuringSettlement = sessionTrustedToolNames.has("write");
        return true;
      }),
    };
    const view = { controller, sessionTrustedToolNames };

    (AgentChatView.prototype as any).respondToToolApproval.call(view, "approval-1", true, true);

    expect(trustedDuringSettlement).toBe(true);
    expect(sessionTrustedToolNames).toEqual(new Set(["write"]));
  });

  it("loads the chat-scoped approval mode while clearing session-only trust", async () => {
    const sessionTrustedToolNames = new Set(["write"]);
    const loaded = {
      chatId: "chat-2",
      title: "Chat two",
      version: 2,
      messages: [],
      contextFiles: [],
      approvalMode: "full-access",
    };
    const workspace = {
      setBanner: jest.fn(),
      setApprovalMode: jest.fn(),
      setTitle: jest.fn(),
      setHistory: jest.fn(async () => undefined),
      setAgentSnapshot: jest.fn(async () => undefined),
    };
    const view = {
      controller: { cancel: jest.fn(async () => undefined) },
      sessionTrustedToolNames,
      workspace,
      transcript: { load: jest.fn(async () => loaded) },
      contextManager: { setContextFiles: jest.fn(async () => undefined) },
      contextLoading: false,
      approvalMode: "ask",
      applyTranscriptIdentity: jest.fn(),
      applyFontSize: jest.fn(),
      syncAttachments: jest.fn(),
      hydrateQueue: jest.fn(async () => undefined),
      updateViewState: jest.fn(),
      app: { workspace: { trigger: jest.fn() } },
    };

    await AgentChatView.prototype.loadChatById.call(view as any, "chat-2");

    expect(sessionTrustedToolNames).toEqual(new Set());
    expect(view.approvalMode).toBe("full-access");
    expect(workspace.setApprovalMode).toHaveBeenCalledWith("full-access");
    expect(view.hydrateQueue).toHaveBeenCalledWith("chat-2");
  });

  it("rolls current approval state back and rejects when durable persistence fails", async () => {
    const workspace = { setApprovalMode: jest.fn() };
    const view = {
      approvalMode: "ask",
      chatId: "chat-1",
      workspace,
      updateViewState: jest.fn(),
      saveChat: jest.fn().mockRejectedValue(new Error("vault write failed")),
      app: { workspace: { requestSaveLayout: jest.fn() } },
      applyApprovalMode: (AgentChatView.prototype as any).applyApprovalMode,
    };

    await expect((AgentChatView.prototype as any).setApprovalMode.call(view, "full-access"))
      .rejects.toThrow("vault write failed");

    expect(view.approvalMode).toBe("ask");
    expect(workspace.setApprovalMode.mock.calls).toEqual([["full-access"], ["ask"]]);
    expect(view.updateViewState).toHaveBeenCalledTimes(2);
    expect(view.app.workspace.requestSaveLayout).toHaveBeenCalledTimes(2);
  });

  it("rejects a tool-access change while a run is active", async () => {
    const view = {
      approvalMode: "full-access",
      activeRunPromise: Promise.resolve(),
      applyApprovalMode: jest.fn(),
      saveChat: jest.fn(),
    };

    await expect((AgentChatView.prototype as any).setApprovalMode.call(view, "ask"))
      .rejects.toThrow("Tool access cannot change while the agent is running.");

    expect(view.applyApprovalMode).not.toHaveBeenCalled();
    expect(view.saveChat).not.toHaveBeenCalled();
    expect(view.approvalMode).toBe("full-access");
  });

  it("waits for queued follow-ups to persist before the view closes", async () => {
    const persistQueueState = jest.fn(async () => undefined);
    const transcriptCommitUnsubscribe = jest.fn();
    const view = {
      suppressQueueDrain: false,
      controller: { cancel: jest.fn(async () => undefined) },
      queueHydrated: true,
      persistQueueState,
      queuePersistence: Promise.resolve(),
      reportQueuePersistenceError: jest.fn(),
      transcript: { idle: jest.fn(async () => undefined) },
      pruneAttachmentStore: jest.fn(async () => undefined),
      controllerUnsubscribe: jest.fn(),
      transcriptCommitUnsubscribe,
      recorderToggleUnsubscribe: jest.fn(),
      recorderTranscriptUnsubscribe: jest.fn(),
      contextManager: { destroy: jest.fn() },
      workspace: { setBanner: jest.fn() },
    };

    await AgentChatView.prototype.onClose.call(view as any);

    expect(persistQueueState).toHaveBeenCalledTimes(1);
    expect(view.transcript.idle).toHaveBeenCalledTimes(1);
    expect(transcriptCommitUnsubscribe).toHaveBeenCalledTimes(1);
    expect(view.workspace).toBeNull();
  });

  it("moves an undurable queued follow-up onto the next draft instead of clearing it", async () => {
    const queued = [{
      id: "queued-1",
      text: "Keep this",
      webSearch: false,
      includeContextFiles: true,
    }];
    const queueRepository = { move: jest.fn(async () => undefined), save: jest.fn(async () => undefined) };
    const view = {
      suppressQueueDrain: false,
      controller: { cancel: jest.fn(async () => undefined) },
      queuedFollowUps: [...queued],
      queueHydrated: true,
      persistQueueState: jest.fn(async () => undefined),
      draftKey: "draft-old",
      chatId: "",
      pendingRetry: null,
      sessionTrustedToolNames: new Set<string>(),
      approvalMode: "full-access",
      workspace: {
        setApprovalMode: jest.fn(),
        setTitle: jest.fn(),
        setBanner: jest.fn(),
        setHistory: jest.fn(async () => undefined),
        setAgentSnapshot: jest.fn(async () => undefined),
      },
      contextLoading: false,
      contextManager: { clearContext: jest.fn() },
      transcript: { reset: jest.fn(() => ({
        chatId: "",
        title: "New chat",
        version: 0,
        messages: [],
      })) },
      applyTranscriptIdentity: jest.fn(),
      syncAttachments: jest.fn(),
      syncQueue: jest.fn(),
      queueRepository,
      updateViewState: jest.fn(),
      app: { workspace: { trigger: jest.fn() } },
      isFullyLoaded: false,
    };

    await (AgentChatView.prototype as any).startNewChat.call(view, false);

    expect(view.queuedFollowUps).toEqual(queued);
    expect(queueRepository.move).toHaveBeenCalledWith(
      "draft-old",
      expect.stringMatching(/^draft-/),
      queued,
    );
    expect(queueRepository.save).not.toHaveBeenCalled();
  });
});
