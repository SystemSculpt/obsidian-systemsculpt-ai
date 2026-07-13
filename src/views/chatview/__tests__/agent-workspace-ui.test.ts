/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import { AgentComposer } from "../AgentComposer";
import {
  applyManagedAgentEvent,
  createInitialAgentConversation,
  MANAGED_AGENT_EVENT_VERSION,
  type ManagedAgentEvent,
  type ManagedAgentEventEnvelope,
} from "../AgentConversation";
import { AgentWorkspace } from "../AgentWorkspace";

function envelope(seq: number, event: ManagedAgentEvent): ManagedAgentEventEnvelope {
  return {
    version: MANAGED_AGENT_EVENT_VERSION,
    seq,
    runId: "run-1",
    turnId: "user-1",
    emittedAt: seq,
    event,
  };
}

describe("AgentComposer", () => {
  it("sends while idle, queues while running, and preserves line breaks", async () => {
    const parent = document.body.createDiv();
    const submissions: Array<{ text: string; webSearch: boolean; mode: "send" | "queue" }> = [];
    const composer = new AgentComposer(parent, {
      onSubmit: async (submission) => { submissions.push(submission); },
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
    });
    composer.load();
    const input = parent.querySelector("textarea")!;

    composer.setValue("First request");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(submissions).toEqual([{ text: "First request", webSearch: false, mode: "send" }]);

    composer.setRunning(true);
    composer.setWebSearchEnabled(true);
    composer.setValue("Follow up");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(submissions.at(-1)).toEqual({ text: "Follow up", webSearch: true, mode: "queue" });

    composer.setValue("Keep me");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(composer.getValue()).toBe("Keep me");
    composer.unload();
  });

  it("renders removable context and disables mutation in read-only chats", () => {
    const parent = document.body.createDiv();
    const onRemoveAttachment = jest.fn();
    const composer = new AgentComposer(parent, {
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment,
    });
    composer.load();
    composer.setAttachments([{ id: "a", label: "Project.md", path: "Project.md", kind: "vault" }]);
    const remove = parent.querySelector<HTMLButtonElement>('[aria-label="Remove Project.md"]')!;
    remove.click();
    expect(onRemoveAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

    composer.setReadOnly(true);
    expect(parent.querySelector("textarea")?.hasAttribute("disabled")).toBe(true);
    expect(parent.textContent).toContain("Project.md");
    composer.unload();
  });

  it("preserves pasted text while ingesting multiple mixed clipboard files", async () => {
    const parent = document.body.createDiv();
    const submissions: any[] = [];
    const composer = new AgentComposer(parent, {
      onSubmit: async (submission) => { submissions.push(submission); },
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
    });
    composer.load();
    const text = new File(["# Plan"], "plan.md", { type: "text/markdown" });
    const image = new File([new Uint8Array([1, 2, 3])], "diagram.png", { type: "image/png" });
    Object.defineProperty(text, "arrayBuffer", { value: async () => new TextEncoder().encode("# Plan").buffer });
    Object.defineProperty(image, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });

    composer.setValue("Pasted instructions");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { types: ["Files", "text/plain"], files: [text, image], items: [] },
    });
    parent.querySelector("textarea")!.dispatchEvent(paste);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(paste.defaultPrevented).toBe(false);
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(2);
    expect(parent.querySelector<HTMLImageElement>(".systemsculpt-agent-attachment-preview")?.src).toMatch(/^data:image\/png;base64,/);
    const send = parent.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(send.disabled).toBe(false);
    send.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(submissions).toHaveLength(1);
    expect(submissions[0].text).toBe("Pasted instructions");
    expect(submissions[0].attachments.map((item: any) => item.kind)).toEqual(["text", "image"]);
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(0);
    composer.unload();
  });

  it("ingests multiple mixed files through the native picker and sends attachment-only", async () => {
    const parent = document.body.createDiv();
    const submissions: any[] = [];
    const composer = new AgentComposer(parent, {
      onSubmit: async (submission) => { submissions.push(submission); },
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
    });
    composer.load();
    const text = new File(["notes"], "notes.txt", { type: "text/plain" });
    const image = new File([new Uint8Array([7, 8])], "photo.webp", { type: "image/webp" });
    Object.defineProperty(text, "arrayBuffer", { value: async () => new TextEncoder().encode("notes").buffer });
    Object.defineProperty(image, "arrayBuffer", { value: async () => new Uint8Array([7, 8]).buffer });
    const picker = parent.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [text, image] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(2);
    parent.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(submissions).toHaveLength(1);
    expect(submissions[0].text).toBe("");
    expect(submissions[0].attachments.map((item: any) => item.kind)).toEqual(["text", "image"]);
    composer.unload();
  });

  it("restores a rejected submission without overwriting the newer draft", () => {
    const parent = document.body.createDiv();
    const composer = new AgentComposer(parent, {
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
    });
    composer.load();
    composer.setValue("New draft typed while waiting");
    const rejectedAttachment = {
      status: "ready" as const,
      id: "text-hash",
      name: "brief.md",
      mimeType: "text/markdown",
      byteLength: 7,
      kind: "text" as const,
      contentPart: {
        type: "text" as const,
        text: "--- BEGIN ATTACHED FILE: brief.md (text/markdown) ---\n# Brief\n--- END ATTACHED FILE: brief.md ---",
      },
    };

    composer.restoreRejectedSubmission({
      text: "Rejected request",
      attachments: [rejectedAttachment],
    });

    expect(composer.getValue()).toBe("Rejected request\n\nNew draft typed while waiting");
    expect(composer.getMessageAttachments()).toEqual([rejectedAttachment]);
    expect(composer.hasDraft()).toBe(true);
    composer.unload();
  });

  it("blocks a mixed batch when PDF processing fails, then submits the whole batch after retry", async () => {
    const parent = document.body.createDiv();
    const submissions: any[] = [];
    let attempt = 0;
    const composer = new AgentComposer(parent, {
      onSubmit: async (submission) => { submissions.push(submission); },
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      documentAttachmentProcessor: {
        prepare: jest.fn(async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("conversion failed");
          return { operationId: "pdf-retry", markdown: "Recovered document" };
        }),
        complete: jest.fn(async () => undefined),
        discard: jest.fn(async () => undefined),
      },
    });
    composer.load();
    const text = new File(["notes"], "notes.md", { type: "text/markdown" });
    const pdf = new File(["%PDF"], "broken.pdf", { type: "application/pdf" });
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    Object.defineProperty(text, "arrayBuffer", { value: async () => new TextEncoder().encode("notes").buffer });
    Object.defineProperty(pdf, "arrayBuffer", { value: async () => new TextEncoder().encode("%PDF").buffer });
    Object.defineProperty(image, "arrayBuffer", { value: async () => new TextEncoder().encode("image").buffer });

    await (composer as any).ingestFiles([text, pdf, image]);

    const send = parent.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(parent.querySelectorAll(".systemsculpt-agent-attachment.is-message")).toHaveLength(3);
    expect(parent.querySelector(".systemsculpt-agent-attachment.is-failed")?.textContent).toContain("broken.pdf");
    expect(send.disabled).toBe(true);
    send.click();
    expect(submissions).toEqual([]);

    const failedId = (composer as any).messageAttachments.displaySnapshot()
      .find((attachment: any) => attachment.status === "failed").id;
    await (composer as any).retryMessageAttachment(failedId);

    expect(send.disabled).toBe(false);
    send.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].attachments.map((attachment: any) => attachment.name)).toEqual([
      "notes.md", "broken.pdf", "diagram.png",
    ]);
    composer.unload();
  });

  it("turns a Similar Notes drag payload into vault context instead of a message file", () => {
    const parent = document.body.createDiv();
    const onVaultContextDrop = jest.fn();
    const composer = new AgentComposer(parent, {
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onVaultContextDrop,
    });
    composer.load();
    const transfer = {
      types: ["application/x-systemsculpt-similar-note"],
      files: [],
      items: [],
      getData: jest.fn(() => JSON.stringify({
        path: "Research/Project.md",
        title: "Project",
        source: "similar-notes",
      })),
    };
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });

    composer.element.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    expect(onVaultContextDrop).toHaveBeenCalledWith("Research/Project.md");
    expect((composer as any).messageAttachments.displaySnapshot()).toEqual([]);
    composer.unload();
  });

  it("does not enable send for vault context without prompt text or message attachments", () => {
    const parent = document.body.createDiv();
    const composer = new AgentComposer(parent, {
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
    });
    composer.load();

    composer.setAttachments([{ id: "context", label: "Project.md", path: "Project.md", kind: "vault" }]);

    expect(parent.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
    composer.unload();
  });

  it("offers familiar Ask Approval and Full Access modes in the composer", () => {
    const parent = document.body.createDiv();
    const onApprovalModeChange = jest.fn();
    const composer = new AgentComposer(parent, {
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprovalModeChange,
    });
    composer.load();
    const select = parent.querySelector<HTMLSelectElement>('[aria-label="Vault changes"]')!;
    expect(Array.from(select.options).map((option) => option.text)).toEqual(["Ask Approval", "Full Access"]);
    composer.setApprovalMode("full-access");
    expect(select.value).toBe("full-access");
    select.value = "ask";
    select.dispatchEvent(new Event("change"));
    expect(onApprovalModeChange).toHaveBeenCalledWith("ask");
    composer.unload();
  });
});

describe("AgentWorkspace", () => {
  it("classifies tool-only history turns without action chrome", async () => {
    const parent = document.body.createDiv();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onRetryMessage: jest.fn(),
      onCopyText: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    const tool = (id: string, messageId: string, timestamp: number) => ({
      id,
      messageId,
      request: {
        id,
        type: "function" as const,
        function: { name: "read", arguments: JSON.stringify({ path: `${id}.md` }) },
      },
      state: "completed" as const,
      result: { success: true, data: { summary: `Read ${id}.md` } },
      timestamp,
    });
    const aggregateTool = tool("call-aggregate", "assistant-tool-aggregate", 1);
    const orderedTool = tool("call-ordered", "assistant-tool-ordered", 2);
    const mixedTool = tool("call-mixed", "assistant-mixed", 4);

    await workspace.setHistory([
      { role: "user", message_id: "user-text", content: "Inspect the vault." },
      {
        role: "assistant",
        message_id: "assistant-tool-aggregate",
        content: "",
        tool_calls: [aggregateTool],
      },
      {
        role: "assistant",
        message_id: "assistant-tool-ordered",
        content: "stale aggregate content",
        tool_calls: [orderedTool],
        messageParts: [
          { id: "part-ordered", type: "tool_call", timestamp: 2, data: orderedTool },
        ],
      },
      {
        role: "assistant",
        message_id: "assistant-mixed",
        content: "Finished.",
        tool_calls: [mixedTool],
        messageParts: [
          { id: "part-text", type: "content", timestamp: 3, data: "Finished." },
          { id: "part-mixed", type: "tool_call", timestamp: 4, data: mixedTool },
        ],
      },
    ]);

    const row = (id: string) => parent.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
    expect(row("assistant-tool-aggregate").classList.contains("is-tool-only")).toBe(true);
    expect(row("assistant-tool-ordered").classList.contains("is-tool-only")).toBe(true);
    expect(row("assistant-tool-aggregate").querySelector(".systemsculpt-agent-message-actions")).toBeNull();
    expect(row("assistant-tool-ordered").querySelector(".systemsculpt-agent-message-actions")).toBeNull();
    expect(row("user-text").classList.contains("is-tool-only")).toBe(false);
    expect(row("user-text").querySelector('[aria-label="Retry from here"]')).not.toBeNull();
    expect(row("assistant-mixed").classList.contains("is-tool-only")).toBe(false);
    expect(row("assistant-mixed").querySelector('[aria-label="Copy"]')).not.toBeNull();
    workspace.unload();
  });

  it("preserves durable text and tool chronology after a reload", async () => {
    const parent = document.body.createDiv();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    const firstTool = {
      id: "call-1",
      messageId: "assistant-1",
      request: { id: "call-1", type: "function" as const, function: { name: "read", arguments: '{"path":"One.md"}' } },
      state: "completed" as const,
      result: { success: true, data: { summary: "Read One.md" } },
      timestamp: 2,
    };
    const secondTool = {
      id: "call-2",
      messageId: "assistant-1",
      request: { id: "call-2", type: "function" as const, function: { name: "read", arguments: '{"path":"Two.md"}' } },
      state: "completed" as const,
      result: { success: true, data: { summary: "Read Two.md" } },
      timestamp: 4,
    };
    await workspace.setHistory([{
      role: "assistant",
      message_id: "assistant-1",
      content: "BeforeAfter",
      tool_calls: [firstTool, secondTool],
      messageParts: [
        { id: "text-1", type: "content", timestamp: 1, data: "Before" },
        { id: "tool-1", type: "tool_call", timestamp: 2, data: firstTool },
        { id: "tool-2", type: "tool_call", timestamp: 2, data: secondTool },
        { id: "text-2", type: "content", timestamp: 3, data: "After" },
      ],
    }]);

    const body = parent.querySelector(".systemsculpt-agent-turn-body")!;
    expect(Array.from(body.children).map((node) => node.textContent)).toEqual([
      "Before",
      expect.stringContaining("One.md"),
      expect.stringContaining("Two.md"),
      "After",
    ]);
    expect(body.textContent).not.toContain("BeforeAfter");
    workspace.unload();
  });

  it("renders mixed and attachment-only user turns after reload", async () => {
    const parent = document.body.createDiv();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    await workspace.setHistory([
      {
        role: "user",
        message_id: "mixed",
        content: [
          { type: "text", text: "Compare these." },
          { type: "image_url", image_url: { url: "data:image/png;base64,one" } },
          { type: "text", text: "--- BEGIN ATTACHED FILE: notes.txt (text/plain) ---\nbody\n--- END ATTACHED FILE: notes.txt ---" },
        ],
      },
      {
        role: "user",
        message_id: "image-only",
        content: [{ type: "image_url", image_url: { url: "data:image/webp;base64,two" } }],
      },
    ]);

    expect(parent.textContent).toContain("Compare these.");
    expect(parent.textContent).toContain("notes.txt");
    expect(parent.textContent).not.toContain("body");
    expect(parent.querySelectorAll(".systemsculpt-agent-message-attachment.is-image")).toHaveLength(2);
    expect(parent.querySelectorAll(".systemsculpt-agent-turn.is-user")).toHaveLength(2);
    workspace.unload();
  });

  it("projects a full agent run with inline approval, queue, and artifact actions", async () => {
    const parent = document.body.createDiv();
    const onApprove = jest.fn();
    const onOpenArtifact = jest.fn();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      reducedMotion: () => true,
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove,
      onOpenArtifact,
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
      onCancelQueued: jest.fn(),
      onRunQueuedNow: jest.fn(),
    });
    workspace.load();
    await workspace.setHistory([{ role: "user", content: "Update Project.md", message_id: "user-1" }]);
    workspace.setQueue([{
      id: "queued-1",
      text: "Then summarize it",
      webSearch: false,
      includeContextFiles: true,
    }]);

    let snapshot = createInitialAgentConversation();
    snapshot = applyManagedAgentEvent(snapshot, envelope(1, { type: "run.started" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "tool.requested",
      call: {
        callId: "call-1",
        partId: "tool-1",
        messageId: "assistant-1",
        name: "edit",
        location: "vault",
        input: { path: "Project.md" },
      },
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(4, {
      type: "approval.requested",
      callId: "call-1",
      approvalId: "approval-1",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(5, { type: "run.waiting", reason: "approval" }));
    await workspace.setAgentSnapshot(snapshot);

    expect(parent.textContent).toContain("Update Project.md");
    expect(parent.textContent).toContain("Then summarize it");
    expect(parent.textContent).toContain("Needs approval");
    parent.querySelector<HTMLButtonElement>(".systemsculpt-agent-approval .mod-cta")!.click();
    expect(onApprove).toHaveBeenCalledWith("approval-1", true);
    Array.from(parent.querySelectorAll<HTMLButtonElement>(".systemsculpt-agent-approval-actions button"))
      .find((entry) => entry.textContent === "Allow for chat")!
      .click();
    expect(onApprove).toHaveBeenCalledWith("approval-1", true, true);

    const pendingDetails = parent.querySelector<HTMLDetailsElement>(".systemsculpt-agent-tool-details")!;
    pendingDetails.open = true;
    const pendingSummary = pendingDetails.querySelector<HTMLElement>(".systemsculpt-agent-tool-header")!;
    pendingSummary.focus();
    expect(document.activeElement).toBe(pendingSummary);
    snapshot = applyManagedAgentEvent(snapshot, envelope(6, { type: "approval.resolved", approvalId: "approval-1", approved: true }));
    await workspace.setAgentSnapshot(snapshot);
    expect(parent.querySelector<HTMLDetailsElement>(".systemsculpt-agent-tool-details")?.open).toBe(true);
    expect((document.activeElement as HTMLElement | null)?.dataset.focusKey).toBe("tool-summary");

    snapshot = applyManagedAgentEvent(snapshot, envelope(7, { type: "tool.started", callId: "call-1" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(8, {
      type: "tool.succeeded",
      callId: "call-1",
      result: {
        summary: "Updated Project.md",
        artifacts: [{ id: "artifact-1", kind: "vault_file", title: "Project.md", path: "Project.md" }],
      },
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(9, { type: "run.completed" }));
    await workspace.setAgentSnapshot(snapshot);

    expect(parent.textContent).toContain("Updated Project.md");
    parent.querySelector<HTMLButtonElement>('.systemsculpt-agent-artifact [aria-label="Open"]')!.click();
    expect(onOpenArtifact).toHaveBeenCalledWith(expect.objectContaining({ path: "Project.md" }));
    workspace.unload();
  });

  it("shows the proposed change before approval and exposes bounded result details", async () => {
    const parent = document.body.createDiv();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();

    let snapshot = createInitialAgentConversation();
    snapshot = applyManagedAgentEvent(snapshot, envelope(1, { type: "run.started" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, { type: "message.started", messageId: "assistant-1", role: "assistant" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "tool.requested",
      call: {
        callId: "call-write",
        partId: "tool-write",
        messageId: "assistant-1",
        name: "write",
        location: "vault",
        input: { path: "Projects/Plan.md", content: "# Plan\n\nReady" },
      },
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(4, {
      type: "approval.requested",
      callId: "call-write",
      approvalId: "approval-write",
    }));
    await workspace.setAgentSnapshot(snapshot);

    expect(parent.querySelector(".systemsculpt-agent-approval-preview .systemsculpt-diff-viewer")).not.toBeNull();
    expect(parent.textContent).toContain("Projects/Plan.md");
    expect(parent.textContent).toContain("Ready");

    snapshot = applyManagedAgentEvent(snapshot, envelope(5, { type: "approval.resolved", approvalId: "approval-write", approved: true }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(6, { type: "tool.started", callId: "call-write" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(7, {
      type: "tool.succeeded",
      callId: "call-write",
      result: { summary: "Created Plan.md", data: { path: "Projects/Plan.md", bytes: 13 } },
    }));
    await workspace.setAgentSnapshot(snapshot);

    const details = parent.querySelector(".systemsculpt-agent-tool-details")!;
    expect(details.tagName).toBe("DETAILS");
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details.querySelector(":scope > .systemsculpt-agent-tool-header")?.textContent)
      .toContain("Created Plan.md");
    expect(details.querySelector(":scope > .systemsculpt-agent-tool-header")?.textContent)
      .toContain("Done");
    expect(details.textContent).toContain("Result");
    expect(details.textContent).toContain('"bytes": 13');
    workspace.unload();
  });

  it("coalesces bursty stream snapshots and renders only the newest frame", async () => {
    const parent = document.body.createDiv();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    const render = jest.spyOn(workspace.renderer, "renderActive");
    const started = applyManagedAgentEvent(createInitialAgentConversation(), envelope(1, { type: "run.started" }));
    const thinking = applyManagedAgentEvent(started, envelope(2, { type: "run.status", phase: "thinking", label: "Thinking" }));
    const working = applyManagedAgentEvent(thinking, envelope(3, { type: "run.status", phase: "working", label: "Working" }));

    await Promise.all([
      workspace.setAgentSnapshot(started),
      workspace.setAgentSnapshot(thinking),
      workspace.setAgentSnapshot(working),
    ]);

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(working);
    expect(parent.textContent).toContain("Working");
    workspace.unload();
  });

  it("renders one inline terminal error with a direct retry action", async () => {
    const parent = document.body.createDiv();
    const onRetryMessage = jest.fn();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onRetryMessage,
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    const started = applyManagedAgentEvent(createInitialAgentConversation(), envelope(1, { type: "run.started" }));
    const failed = applyManagedAgentEvent(started, envelope(2, {
      type: "run.failed",
      error: { code: "transport", message: "Connection lost." },
    }));

    await workspace.setAgentSnapshot(failed);

    expect(parent.textContent).toContain("Connection lost.");
    parent.querySelector<HTMLButtonElement>(".systemsculpt-agent-error-retry")!.click();
    expect(onRetryMessage).toHaveBeenCalledWith("user-1");
    workspace.unload();
  });

  it("restores durable tool artifacts after a chat reload", async () => {
    const parent = document.body.createDiv();
    const onOpenArtifact = jest.fn();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact,
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    await workspace.setHistory([{
      role: "assistant",
      content: "Updated the project note.",
      message_id: "assistant-1",
      tool_calls: [{
        id: "call-1",
        messageId: "assistant-1",
        request: {
          id: "call-1",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({ path: "Projects/Project.md", content: "Done" }),
          },
        },
        state: "completed",
        timestamp: 1,
        result: { success: true, data: { path: "Projects/Project.md" } },
      }],
    }]);

    expect(parent.textContent).toContain("Project.md");
    expect(parent.textContent).toContain("Write file");
    expect(parent.textContent).not.toContain("Mcp Filesystem");
    expect(parent.querySelector(".systemsculpt-agent-tool-details")?.textContent).toContain("Result");
    parent.querySelector<HTMLButtonElement>('.systemsculpt-agent-artifact [aria-label="Open"]')!.click();
    expect(onOpenArtifact).toHaveBeenCalledWith(expect.objectContaining({ path: "Projects/Project.md" }));
    workspace.unload();
  });

  it("restores truthful partial-result details and only successful artifacts", async () => {
    const parent = document.body.createDiv();
    const onOpenArtifact = jest.fn();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact,
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    await workspace.setHistory([{
      role: "assistant",
      content: "One file changed; one conflicted.",
      message_id: "assistant-partial",
      tool_calls: [{
        id: "call-partial",
        messageId: "assistant-partial",
        request: {
          id: "call-partial",
          type: "function",
          function: {
            name: "multi_edit",
            arguments: JSON.stringify({ files: [{ path: "Changed.md" }, { path: "Failed.md" }] }),
          },
        },
        state: "failed",
        timestamp: 1,
        result: {
          success: false,
          data: {
            results: [
              { path: "Changed.md", success: true },
              { path: "Failed.md", success: false, error: "Conflict" },
            ],
          },
          error: { code: "TOOL_PARTIAL_FAILURE", message: "One file changed; one conflicted." },
        },
      }],
    }]);

    expect(parent.querySelector(".systemsculpt-agent-tool-details")?.textContent).toContain("Result");
    const artifacts = [...parent.querySelectorAll<HTMLElement>(".systemsculpt-agent-artifact")];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].textContent).toContain("Changed.md");
    expect(artifacts[0].textContent).not.toContain("Failed.md");
    artifacts[0].querySelector<HTMLButtonElement>('[aria-label="Open"]')!.click();
    expect(onOpenArtifact).toHaveBeenCalledWith(expect.objectContaining({ path: "Changed.md" }));
    workspace.unload();
  });

  it("restores denied, stopped, and uncertain tool outcomes without flattening them to failed", async () => {
    const parent = document.body.createDiv();
    const workspace = new AgentWorkspace(parent, {
      app: new App(),
      sourcePath: () => "SystemSculpt/Chats/chat.md",
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();

    const tool = (id: string, code: string, message: string) => ({
      id,
      messageId: "assistant-outcomes",
      request: {
        id,
        type: "function" as const,
        function: { name: "write", arguments: JSON.stringify({ path: `${id}.md`, content: "test" }) },
      },
      state: "failed" as const,
      timestamp: 1,
      result: { success: false, error: { code, message } },
    });

    await workspace.setHistory([{
      role: "assistant",
      content: "Tool outcomes",
      message_id: "assistant-outcomes",
      tool_calls: [
        tool("denied", "USER_DENIED", "The user denied this tool execution."),
        tool("stopped", "TOOL_CANCELLED_BEFORE_START", "Cancelled before execution."),
        tool("uncertain", "TOOL_OUTCOME_UNKNOWN_AFTER_RESTART", "Outcome unknown after restart."),
      ],
    }]);

    const states = [...parent.querySelectorAll<HTMLElement>(".systemsculpt-agent-tool-state")]
      .map((element) => element.textContent);
    expect(states).toEqual(["Denied", "Stopped", "Check required"]);
    workspace.unload();
  });
});
