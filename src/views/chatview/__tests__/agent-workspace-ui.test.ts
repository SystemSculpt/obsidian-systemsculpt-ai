/**
 * @jest-environment jsdom
 */

import { App, MarkdownRenderer } from "obsidian";
import { AgentComposer } from "../AgentComposer";
import {
  applyManagedAgentEvent,
  createInitialAgentConversation,
  MANAGED_AGENT_EVENT_VERSION,
  type ManagedAgentEvent,
  type ManagedAgentEventEnvelope,
} from "../AgentConversation";
import { AgentWorkspace } from "../AgentWorkspace";
import { AgentConversationRenderer } from "../AgentConversationRenderer";

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

    expect(parent.querySelector('[aria-label="Add vault context, including images"]')).not.toBeNull();

    composer.setValue("First request");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(submissions).toEqual([{ text: "First request", webSearch: false, mode: "send" }]);

    composer.setRunning(true);
    expect(parent.querySelector('[aria-label="Search the web"]')).toBeNull();
    composer.setValue("Follow up");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(submissions.at(-1)).toEqual({ text: "Follow up", webSearch: false, mode: "queue" });

    composer.setValue("Keep me");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(composer.getValue()).toBe("Keep me");
    composer.unload();
  });

  it("renders removable vault context", () => {
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
    expect(parent.querySelector(".systemsculpt-agent-composer-attachments")?.getAttribute("role"))
      .toBe("list");
    expect(parent.querySelector(".systemsculpt-agent-attachment")?.getAttribute("role"))
      .toBe("listitem");
    const remove = parent.querySelector<HTMLButtonElement>('[aria-label="Remove Project.md"]')!;
    remove.click();
    expect(onRemoveAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

    expect(parent.textContent).toContain("Project.md");
    composer.unload();
  });

  it("keeps a vault image thumbnail visible after selection", () => {
    const parent = document.body.createDiv();
    const composer = new AgentComposer(parent, {
      onSubmit: jest.fn(),
      onStop: jest.fn(),
      onAttach: jest.fn(),
      onRemoveAttachment: jest.fn(),
    });
    composer.load();
    composer.setAttachments([{
      id: "image",
      label: "Diagram.png",
      path: "[[Images/Diagram.png]]",
      kind: "image",
      previewUrl: "app://local/Images/Diagram.png",
    }]);

    const preview = parent.querySelector<HTMLImageElement>(
      ".systemsculpt-agent-attachment.is-context .systemsculpt-agent-attachment-preview",
    )!;
    expect(preview.src).toContain("Images/Diagram.png");
    expect(preview.alt).toBe("");
    expect(preview.loading).toBe("lazy");
    expect(preview.decoding).toBe("async");
    expect(preview.draggable).toBe(false);

    preview.dispatchEvent(new Event("error"));
    expect(parent.querySelector(".systemsculpt-agent-attachment.is-context img")).toBeNull();
    const fallback = parent.querySelector(
      ".systemsculpt-agent-attachment.is-context .systemsculpt-agent-attachment-icon",
    );
    expect(fallback).not.toBeNull();
    expect(fallback?.nextElementSibling?.classList.contains("systemsculpt-agent-attachment-label"))
      .toBe(true);
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
    expect(select.hasAttribute("title")).toBe(false);
    composer.setApprovalMode("full-access");
    expect(select.value).toBe("full-access");
    expect(select.hasAttribute("title")).toBe(false);
    select.value = "ask";
    select.dispatchEvent(new Event("change"));
    expect(onApprovalModeChange).toHaveBeenCalledWith("ask");
    composer.unload();
  });
});

describe("AgentWorkspace", () => {
  const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalClipboardDescriptor) {
      Object.defineProperty(window.navigator, "clipboard", originalClipboardDescriptor);
      return;
    }
    delete (window.navigator as Navigator & { clipboard?: Clipboard }).clipboard;
  });

  it("renders tool status as static non-focusable content without raw payload disclosure", async () => {
    const host = document.body.createDiv();
    const renderer = new AgentConversationRenderer(host, {
      app: new App(),
      sourcePath: () => "",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    const node = host.createDiv();

    await (renderer as any).renderTool(node, {
      id: "status-only",
      name: "read",
      state: "running",
    });

    const shell = node.querySelector(".systemsculpt-agent-tool") as HTMLElement;
    const header = node.querySelector(".systemsculpt-agent-tool-header") as HTMLElement;
    expect(shell.tagName).toBe("DIV");
    expect(header.tagName).toBe("DIV");
    expect(header.hasAttribute("tabindex")).toBe(false);
    expect(node.querySelector("summary")).toBeNull();
    expect(node.querySelector("pre")).toBeNull();
  });

  it("mounts the canonical view surface and shared action grammar", () => {
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

    expect(workspace.element.matches('.ss-surface[data-ss-surface="view"]')).toBe(true);
    expect(parent.querySelector('[aria-label="Chat history"]')?.classList.contains("ss-button--icon")).toBe(true);
    expect(parent.querySelector('[aria-label="Attach files"]')?.classList.contains("ss-button--icon")).toBe(true);
    expect(parent.querySelector('[aria-label="Jump to latest"]')?.classList.contains("ss-button")).toBe(true);
    for (const label of ["Chat history", "New chat", "Chat settings", "Attach files", "Jump to latest"]) {
      expect(parent.querySelector(`[aria-label="${label}"]`)?.hasAttribute("title")).toBe(false);
    }
    expect(parent.querySelector(".systemsculpt-agent-header-title")?.getAttribute("role"))
      .toBe("heading");
    const title = parent.querySelector<HTMLElement>(".systemsculpt-agent-header-title")!;
    const conversation = parent.querySelector<HTMLElement>(".systemsculpt-agent-conversation")!;
    expect(conversation.hasAttribute("aria-label")).toBe(false);
    expect(conversation.getAttribute("aria-labelledby")).toBe(title.id);
    expect(parent.querySelector(".systemsculpt-agent-viewport")?.hasAttribute("aria-label")).toBe(false);
    workspace.setTitle("Conversation");
    expect(title.hasAttribute("title")).toBe(false);

    workspace.setBanner("Connection failed", "error");
    expect(parent.querySelector(".systemsculpt-agent-banner")?.getAttribute("role"))
      .toBe("alert");
    workspace.setQueue([{ id: "queued-1", text: "Follow up" }]);
    expect(parent.querySelector(".systemsculpt-agent-queue")?.getAttribute("role"))
      .toBe("list");
    expect(parent.querySelector(".systemsculpt-agent-queue-item")?.getAttribute("role"))
      .toBe("listitem");

    workspace.unload();
  });

  it("keeps the current transcript mounted until an asynchronous replacement is ready", async () => {
    const host = document.body.createDiv();
    const renderer = new AgentConversationRenderer(host, {
      app: new App(),
      sourcePath: () => "",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    const render = jest.spyOn(MarkdownRenderer, "render");
    render.mockImplementation(async (_app, markdown, parent) => {
      parent.setText(String(markdown));
    });
    await renderer.renderHistory([{ role: "assistant", message_id: "old", content: "Old answer" }]);

    let finish!: () => void;
    render.mockImplementation(async (_app, markdown, parent) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      parent.setText(String(markdown));
    });
    const replacing = renderer.renderHistory([{
      role: "assistant",
      message_id: "new",
      content: "New answer",
    }]);

    expect(host.textContent).toContain("Old answer");
    expect(host.textContent).not.toContain("New answer");
    finish();
    await replacing;
    expect(host.textContent).not.toContain("Old answer");
    expect(host.textContent).toContain("New answer");
    render.mockRestore();
  });

  it("containerizes rendered code and shows compact copy success feedback", async () => {
    const host = document.body.createDiv();
    const renderer = new AgentConversationRenderer(host, {
      app: new App(),
      sourcePath: () => "",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    renderer.load();
    const render = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, _markdown, parent) => {
        parent.innerHTML = '<pre><button class="copy-code-button">Copy code</button><code>const answer = 42;</code></pre>';
      },
    );
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await (renderer as any).renderMarkdown("```ts\nconst answer = 42;\n```", host);
    const pre = host.querySelector("pre")!;
    const copy = host.querySelector<HTMLButtonElement>(".systemsculpt-agent-code-copy")!;
    expect(pre.classList.contains("systemsculpt-agent-code-block")).toBe(true);
    expect(host.querySelector(".copy-code-button")).toBeNull();
    expect(copy.textContent).toContain("Copy");
    expect(copy.hasAttribute("title")).toBe(false);

    copy.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(copy.textContent).toContain("Copied");
    expect(copy.classList.contains("is-copied")).toBe(true);
    expect(copy.getAttribute("aria-label")).toBe("Code copied");
    expect((renderer as any).copyFeedbackTimers.size).toBe(1);
    renderer.unload();
    expect((renderer as any).copyFeedbackTimers.size).toBe(0);
    render.mockRestore();
  });

  it("confirms response copying in place, preserves focus, and recovers from failure", async () => {
    const host = document.body.createDiv();
    const onCopyText = jest.fn<Promise<boolean>, [string]>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("clipboard unavailable"));
    const renderer = new AgentConversationRenderer(host, {
      app: new App(),
      sourcePath: () => "",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onCopyText,
    });
    renderer.load();

    await renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-copy",
      content: "A response worth copying.",
    }]);
    const copy = host.querySelector<HTMLButtonElement>(".systemsculpt-agent-message-copy")!;
    expect(copy.classList.contains("ss-button--icon")).toBe(true);
    expect(copy.textContent).not.toContain("Copy");
    expect(copy.title).toBe("Copy response");
    copy.focus();
    copy.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onCopyText).toHaveBeenCalledWith("A response worth copying.");
    expect(copy.textContent).not.toContain("Copied");
    expect(copy.classList.contains("is-copied")).toBe(true);
    expect(copy.getAttribute("aria-label")).toBe("Response copied");
    expect(copy.title).toBe("Response copied");
    expect(document.activeElement).toBe(copy);
    expect((renderer as any).copyFeedbackTimers.size).toBe(1);

    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCopyText).toHaveBeenCalledTimes(2);
    expect(copy.textContent).not.toContain("Copied");
    expect((renderer as any).copyFeedbackTimers.size).toBe(1);

    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copy.textContent).not.toContain("Copy failed");
    expect(copy.classList.contains("is-copy-failed")).toBe(true);
    expect(copy.getAttribute("aria-label")).toBe("Could not copy response. Try again");
    expect(copy.title).toBe("Could not copy response. Try again");
    expect(document.activeElement).toBe(copy);
    expect((renderer as any).copyFeedbackTimers.size).toBe(1);

    renderer.unload();
    expect((renderer as any).copyFeedbackTimers.size).toBe(0);
  });

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
    const orderedTool = tool("call-ordered", "assistant-tool-ordered", 2);
    const mixedTool = tool("call-mixed", "assistant-mixed", 4);

    await workspace.setHistory([
      { role: "user", message_id: "user-text", content: "Inspect the vault." },
      {
        role: "assistant",
        message_id: "assistant-tool-ordered",
        content: "stale aggregate content",
        tool_calls: [orderedTool],
        messageParts: [
          { id: "part-ordered", type: "tool_call", timestamp: 2, data: orderedTool },
        ],
      },
      { role: "user", message_id: "user-boundary", content: "Continue." },
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
    expect(row("assistant-tool-ordered").classList.contains("is-tool-only")).toBe(true);
    expect(row("assistant-tool-ordered").querySelector(".systemsculpt-agent-message-actions")).toBeNull();
    expect(row("user-text").classList.contains("is-tool-only")).toBe(false);
    expect(row("user-text").querySelector('[aria-label="Edit and resubmit"]')).not.toBeNull();
    expect(row("assistant-mixed").classList.contains("is-tool-only")).toBe(false);
    expect(row("assistant-mixed").querySelector('[aria-label="Copy response"]')).not.toBeNull();
    workspace.unload();
  });

  it("edits a historical user message inline while preserving the global draft", async () => {
    const parent = document.body.createDiv();
    let workspace: AgentWorkspace;
    const onCancelMessageEdit = jest.fn(async (messageId: string) => {
      await workspace.hideMessageEditor(messageId);
    });
    workspace = new AgentWorkspace(parent, {
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
      onResubmitMessage: jest.fn(async () => false),
      onCancelMessageEdit,
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    await workspace.setHistory([
      { role: "user", message_id: "user-edit", content: "Original request" },
      { role: "assistant", message_id: "assistant-edit", content: "Original response" },
      { role: "user", message_id: "user-later", content: "Later follow-up" },
    ]);
    workspace.setInputText("Keep this bottom draft");
    const capturedAnchor = {
      rowId: "message:user-edit",
      offsetFromViewportTop: 12,
      mode: "manual" as const,
      turnAnchorRowId: null,
    };
    const captureAnchor = jest.spyOn((workspace as any).scroller, "capturePrependAnchor")
      .mockReturnValue(capturedAnchor);
    const restoreAnchor = jest.spyOn((workspace as any).scroller, "restorePrependAnchor");

    await workspace.showMessageEditor({
      messageId: "user-edit",
      text: "Original request",
      laterMessageCount: 2,
      hasAttachments: false,
      unavailableAttachmentCount: 0,
      requiresReplayConfirmation: false,
    });

    const row = parent.querySelector<HTMLElement>('[data-message-id="user-edit"]')!;
    const input = row.querySelector<HTMLTextAreaElement>(".systemsculpt-agent-message-editor-input")!;
    const globalInput = parent.querySelector<HTMLTextAreaElement>('[aria-label="Message SystemSculpt"]')!;
    expect(row.classList.contains("is-editing")).toBe(true);
    expect(input.value).toBe("Original request");
    expect(document.activeElement).toBe(input);
    expect(row.textContent).toContain("Saving will replace 2 later messages in this chat.");
    expect(row.textContent).toContain("Ctrl or Command Enter to save. Escape to cancel.");
    expect(globalInput.value).toBe("Keep this bottom draft");
    expect(globalInput.disabled).toBe(true);
    expect(parent.textContent).toContain("Finish editing the earlier message");
    expect(captureAnchor).toHaveBeenCalledTimes(1);
    expect(restoreAnchor).toHaveBeenCalledWith(capturedAnchor);

    const escapedToHost = jest.fn();
    parent.addEventListener("keydown", escapedToHost);
    input.value = "Changed but cancelled";
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(escapedToHost).not.toHaveBeenCalled();
    expect(row.classList.contains("is-editing")).toBe(true);
    const escapeKeyup = new KeyboardEvent("keyup", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escapeKeyup);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await (workspace as any).rendering;

    expect(escapeKeyup.defaultPrevented).toBe(true);
    expect(escapedToHost).not.toHaveBeenCalled();
    expect(onCancelMessageEdit).toHaveBeenCalledWith("user-edit");
    expect(row.isConnected).toBe(false);
    const restored = parent.querySelector<HTMLElement>('[data-message-id="user-edit"]')!;
    expect(restored.classList.contains("is-editing")).toBe(false);
    expect(restored.textContent).toContain("Original request");
    expect(globalInput.value).toBe("Keep this bottom draft");
    expect(globalInput.disabled).toBe(false);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit and resubmit");
    workspace.unload();
  });

  it("resubmits an inline edit with keyboard semantics and keeps failures editable", async () => {
    const parent = document.body.createDiv();
    const onResubmitMessage = jest.fn(async () => false);
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
      onResubmitMessage,
      onCancelMessageEdit: jest.fn(),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    await workspace.setHistory([
      { role: "user", message_id: "user-edit", content: "Original request" },
    ]);
    await workspace.showMessageEditor({
      messageId: "user-edit",
      text: "Original request",
      laterMessageCount: 0,
      hasAttachments: false,
      unavailableAttachmentCount: 1,
      requiresReplayConfirmation: true,
    });
    const input = parent.querySelector<HTMLTextAreaElement>(".systemsculpt-agent-message-editor-input")!;
    const shortcutToHost = jest.fn();
    parent.addEventListener("keydown", shortcutToHost);
    input.value = "  Updated request  ";
    const saveShortcut = new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(saveShortcut);
    await Promise.resolve();
    await Promise.resolve();

    expect(saveShortcut.defaultPrevented).toBe(true);
    expect(shortcutToHost).not.toHaveBeenCalled();
    expect(onResubmitMessage).toHaveBeenCalledWith("user-edit", "Updated request");
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    const saveKeyup = new KeyboardEvent("keyup", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(saveKeyup);
    expect(saveKeyup.defaultPrevented).toBe(true);
    expect(shortcutToHost).not.toHaveBeenCalled();
    expect(parent.textContent).toContain("1 unavailable attachment will be left out.");
    expect(parent.textContent).toContain("Existing vault changes will not be undone.");

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const save = Array.from(
      parent.querySelectorAll<HTMLButtonElement>(".systemsculpt-agent-message-editor-actions button"),
    ).find((button) => button.textContent?.includes("Save and resubmit"));
    expect(save?.disabled).toBe(true);
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
      expect.stringMatching(/One\.md[\s\S]*Two\.md/),
      "After",
    ]);
    const groupedTools = body.querySelectorAll(
      ".systemsculpt-agent-activity .systemsculpt-agent-part.is-tool",
    );
    expect(groupedTools).toHaveLength(1);
    expect(groupedTools[0].querySelector("strong")?.textContent).toBe("Read 2 files");
    expect(body.textContent).not.toContain("BeforeAfter");
    workspace.unload();
  });

  it("keeps one assistant-owned activity section after a subsequent user turn", async () => {
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
      onCopyText: jest.fn(async () => true),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    const tool = (id: string, timestamp: number) => ({
      id,
      messageId: "assistant-multiround",
      request: {
        id,
        type: "function" as const,
        function: { name: "read", arguments: JSON.stringify({ path: `${id}.md` }) },
      },
      state: "completed" as const,
      result: { success: true, data: { summary: `Read ${id}.md`, raw: "not product UI" } },
      timestamp,
    });
    const firstTool = tool("first", 2);
    const secondTool = tool("second", 5);
    const thirdTool = tool("third", 7);
    const firstUser = {
      role: "user" as const,
      message_id: "user-first",
      content: "Inspect several notes.",
    };
    const assistantRounds = [{
      role: "assistant" as const,
      message_id: "assistant-multiround-1",
      content: "",
      tool_calls: [firstTool],
      messageParts: [
        { id: "reasoning-1", type: "reasoning" as const, timestamp: 1, data: "Plan the first read." },
        { id: "tool-1", type: "tool_call" as const, timestamp: 2, data: firstTool },
        { id: "empty-round-1", type: "content" as const, timestamp: 3, data: "" },
      ],
    }, {
      role: "assistant" as const,
      message_id: "assistant-multiround-2",
      content: "",
      tool_calls: [secondTool],
      messageParts: [
        { id: "reasoning-2", type: "reasoning" as const, timestamp: 4, data: "Continue with the next reads." },
        { id: "tool-2", type: "tool_call" as const, timestamp: 5, data: secondTool },
        { id: "empty-round-2", type: "content" as const, timestamp: 6, data: " " },
      ],
    }, {
      role: "assistant" as const,
      message_id: "assistant-multiround-3",
      content: "Finished.",
      tool_calls: [thirdTool],
      messageParts: [
        { id: "tool-3", type: "tool_call" as const, timestamp: 7, data: thirdTool },
        { id: "answer", type: "content" as const, timestamp: 8, data: "Finished." },
      ],
    }];

    const assertCoherentTurn = () => {
      const row = parent.querySelector<HTMLElement>('[data-message-id="assistant-multiround-1"]')!;
      expect(row.dataset.messageIds).toBe(
        "assistant-multiround-1 assistant-multiround-2 assistant-multiround-3",
      );
      expect(row.querySelectorAll(":scope .systemsculpt-agent-activity")).toHaveLength(1);
      expect(row.querySelector(".systemsculpt-agent-activity-label")?.textContent).toBe("Activity");
      expect(row.querySelector(".systemsculpt-agent-activity-state")?.textContent).toBe("Done");
      expect(row.querySelectorAll(".systemsculpt-agent-activity .systemsculpt-agent-part.is-reasoning"))
        .toHaveLength(2);
      expect(row.querySelectorAll(".systemsculpt-agent-activity .systemsculpt-agent-part.is-tool"))
        .toHaveLength(3);
      expect(row.querySelector(".systemsculpt-agent-activity pre")).toBeNull();
      expect(row.querySelector(".systemsculpt-agent-artifact")).toBeNull();
      expect(row.textContent).not.toContain("not product UI");
      expect(row.querySelector('[aria-label="Copy response"]')).not.toBeNull();
    };

    await workspace.setHistory([firstUser, ...assistantRounds]);
    assertCoherentTurn();
    await workspace.setHistory([
      firstUser,
      ...assistantRounds,
      { role: "user", message_id: "user-follow-up", content: "?" },
    ]);
    assertCoherentTurn();
    expect(parent.querySelectorAll(".systemsculpt-agent-activity")).toHaveLength(1);
    expect(parent.querySelectorAll(".systemsculpt-agent-turn.is-assistant")).toHaveLength(1);
    workspace.unload();
  });

  it("keeps consecutive reads grouped across assistant continuation messages and later history rerenders", async () => {
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
      onCopyText: jest.fn(async () => true),
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();
    const tool = (id: string, messageId: string, timestamp: number, path: string) => ({
      id,
      messageId,
      request: {
        id,
        type: "function" as const,
        function: { name: "read", arguments: JSON.stringify({ paths: [path] }) },
      },
      state: "completed" as const,
      result: { success: true, data: { files: [{ path, content: "ok" }] } },
      timestamp,
    });
    const reads = [
      tool("read-1", "assistant-read-1", 1, "Research/One.md"),
      tool("read-2", "assistant-read-2", 2, "Research/Two.md"),
      tool("read-3", "assistant-read-3", 3, "Research/Three.md"),
    ];
    const firstUser = {
      role: "user" as const,
      message_id: "user-read",
      content: "Read these notes.",
    };
    const assistantRounds = reads.map((read, index) => ({
      role: "assistant" as const,
      message_id: `assistant-read-${index + 1}`,
      content: index === reads.length - 1 ? "Finished." : "",
      tool_calls: [read],
      messageParts: [
        { id: `read-part-${index + 1}`, type: "tool_call" as const, timestamp: read.timestamp, data: read },
        ...(index === reads.length - 1
          ? [{ id: "read-answer", type: "content" as const, timestamp: 4, data: "Finished." }]
          : []),
      ],
    }));

    const assertGrouped = () => {
      const row = parent.querySelector<HTMLElement>('[data-message-id="assistant-read-1"]')!;
      expect(row.dataset.messageIds).toBe(
        "assistant-read-1 assistant-read-2 assistant-read-3",
      );
      const toolRows = row.querySelectorAll(".systemsculpt-agent-activity .systemsculpt-agent-part.is-tool");
      expect(toolRows).toHaveLength(1);
      expect(toolRows[0].classList.contains("is-grouped")).toBe(true);
      expect(toolRows[0].getAttribute("data-tool-count")).toBe("3");
      expect(toolRows[0].querySelector("strong")?.textContent).toBe("Read 3 files");
      expect(toolRows[0].querySelector(".systemsculpt-agent-tool-summary")?.textContent)
        .toBe("Research/One.md, Research/Two.md, +1 more");
      expect(toolRows[0].querySelector(".systemsculpt-agent-tool-state")?.textContent).toBe("Done");
      expect(toolRows[0].querySelector(".systemsculpt-agent-tool-header")?.getAttribute("aria-label"))
        .toBe("Read 3 files, Research/One.md, Research/Two.md, +1 more, Done");
    };

    await workspace.setHistory([firstUser, ...assistantRounds]);
    assertGrouped();
    await workspace.setHistory([
      firstUser,
      ...assistantRounds,
      { role: "user", message_id: "user-after-read", content: "Now summarize them." },
    ]);
    assertGrouped();
    expect(parent.querySelectorAll(".systemsculpt-agent-turn.is-assistant")).toHaveLength(1);
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
    const allowOnce = parent.querySelector<HTMLButtonElement>('[data-focus-key="tool-allow-once"]')!;
    expect(allowOnce.classList.contains("ss-button--primary")).toBe(true);
    allowOnce.click();
    expect(onApprove).toHaveBeenCalledWith("approval-1", true);
    Array.from(parent.querySelectorAll<HTMLButtonElement>(".systemsculpt-agent-approval-actions button"))
      .find((entry) => entry.textContent === "Allow for chat")!
      .click();
    expect(onApprove).toHaveBeenCalledWith("approval-1", true, true);

    const pendingPart = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-tool")!;
    const pendingHeader = pendingPart.querySelector<HTMLElement>(".systemsculpt-agent-tool-header")!;
    expect(pendingHeader.hasAttribute("tabindex")).toBe(false);
    expect(pendingPart.querySelector("summary")).toBeNull();
    snapshot = applyManagedAgentEvent(snapshot, envelope(6, { type: "approval.resolved", approvalId: "approval-1", approved: true }));
    await workspace.setAgentSnapshot(snapshot);
    expect(parent.querySelector(".systemsculpt-agent-part.is-tool")).toBe(pendingPart);
    expect(pendingPart.querySelector("summary")).toBeNull();

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

  it("hides redundant continuation progress once streamed content is visible", async () => {
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
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, {
      type: "run.status",
      phase: "working",
      label: "Continuing",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "message.started",
      messageId: "assistant-continuing",
      role: "assistant",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(4, {
      type: "text.delta",
      messageId: "assistant-continuing",
      partId: "text-continuing",
      delta: "Working through the result",
    }));
    await workspace.setAgentSnapshot(snapshot);

    const turn = parent.querySelector(".systemsculpt-agent-active-run .systemsculpt-agent-turn.is-active");
    expect(turn).not.toBeNull();
    expect(turn?.querySelector(".systemsculpt-agent-part.is-text")?.textContent)
      .toContain("Working through the result");
    expect(turn?.querySelector(".systemsculpt-agent-part.is-status")).toBeNull();
    expect(turn?.textContent).not.toContain("Continuing");
    workspace.unload();
  });

  it("keeps the assistant shell and prior text node stable when a tool arrives", async () => {
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
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, {
      type: "message.started",
      messageId: "assistant-stable",
      role: "assistant",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "text.delta",
      messageId: "assistant-stable",
      partId: "text-stable",
      delta: "I will check that.",
    }));
    await workspace.setAgentSnapshot(snapshot);
    const turn = parent.querySelector(".systemsculpt-agent-turn.is-active");
    const text = turn?.querySelector(".systemsculpt-agent-part.is-text");

    snapshot = applyManagedAgentEvent(snapshot, envelope(4, {
      type: "text.completed",
      messageId: "assistant-stable",
      partId: "text-stable",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(5, {
      type: "tool.input.started",
      callId: "call-stable",
      partId: "tool-stable",
      messageId: "assistant-stable",
      name: "read",
      location: "vault",
    }));
    await workspace.setAgentSnapshot(snapshot);

    expect(parent.querySelector(".systemsculpt-agent-turn.is-active")).toBe(turn);
    expect(parent.querySelector(".systemsculpt-agent-part.is-text")).toBe(text);
    expect(turn?.querySelector(".systemsculpt-agent-activity .systemsculpt-agent-part.is-tool"))
      .not.toBeNull();
    workspace.unload();
  });

  it("waits for terminal settlement before grouping a completed live tool sequence", async () => {
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
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, {
      type: "message.started",
      messageId: "assistant-group-live",
      role: "assistant",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "tool.requested",
      call: {
        callId: "read-live-1",
        partId: "read-live-part-1",
        messageId: "assistant-group-live",
        name: "read",
        location: "vault",
        input: { paths: ["One.md"] },
      },
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(4, { type: "tool.started", callId: "read-live-1" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(5, {
      type: "tool.succeeded",
      callId: "read-live-1",
      result: { data: { files: [{ path: "One.md", content: "one" }] } },
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(6, {
      type: "tool.requested",
      call: {
        callId: "read-live-2",
        partId: "read-live-part-2",
        messageId: "assistant-group-live",
        name: "read",
        location: "vault",
        input: { paths: ["Two.md"] },
      },
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(7, { type: "tool.started", callId: "read-live-2" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(8, {
      type: "tool.succeeded",
      callId: "read-live-2",
      result: { data: { files: [{ path: "Two.md", content: "two" }] } },
    }));
    await workspace.setAgentSnapshot(snapshot);

    expect(parent.querySelectorAll(
      ".systemsculpt-agent-active-run .systemsculpt-agent-part.is-tool",
    )).toHaveLength(2);

    snapshot = applyManagedAgentEvent(snapshot, envelope(9, { type: "run.completed" }));
    await workspace.setAgentSnapshot(snapshot);
    const grouped = parent.querySelectorAll(
      ".systemsculpt-agent-active-run .systemsculpt-agent-part.is-tool",
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0].querySelector("strong")?.textContent).toBe("Read 2 files");
    expect(grouped[0].querySelector(".systemsculpt-agent-tool-state")?.textContent).toBe("Done");
    workspace.unload();
  });

  it("settles a completed live run into history without leaving duplicate active content", async () => {
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
    const user = { role: "user" as const, message_id: "user-settle", content: "Finish this" };
    await workspace.setHistory([user]);

    let snapshot = createInitialAgentConversation();
    snapshot = applyManagedAgentEvent(snapshot, envelope(1, { type: "run.started" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, {
      type: "message.started",
      messageId: "assistant-settle",
      role: "assistant",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "text.delta",
      messageId: "assistant-settle",
      partId: "text-settle",
      delta: "Final answer",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(4, {
      type: "text.completed",
      messageId: "assistant-settle",
      partId: "text-settle",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(5, { type: "run.completed" }));
    await workspace.setAgentSnapshot(snapshot);
    expect(parent.querySelector(".systemsculpt-agent-active-run")?.textContent).toContain("Final answer");

    await workspace.settleCompletedRun([
      user,
      { role: "assistant", message_id: "assistant-settle", content: "Final answer" },
    ]);

    expect(parent.querySelector(".systemsculpt-agent-active-run")?.childElementCount).toBe(0);
    expect(parent.querySelectorAll(".systemsculpt-agent-history .systemsculpt-agent-turn")).toHaveLength(2);
    expect(parent.textContent?.match(/Final answer/g)).toHaveLength(1);
    workspace.unload();
  });

  it("stops the composer at the terminal protocol boundary even while settlement is pending", async () => {
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
    workspace.setRunPending(true);

    let snapshot = createInitialAgentConversation();
    snapshot = applyManagedAgentEvent(snapshot, envelope(1, { type: "run.started" }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, { type: "run.completed" }));
    await workspace.setAgentSnapshot(snapshot);

    expect(parent.querySelector(".systemsculpt-agent-composer")?.classList.contains("is-running"))
      .toBe(false);
    expect(parent.querySelector(".systemsculpt-agent-prompt-hint")?.textContent).toBe("Enter to send");
    expect(parent.querySelector('[aria-label="Send message"]')).not.toBeNull();
    workspace.unload();
  });

  it("shows the proposed change before approval without exposing raw result data", async () => {
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

    const tool = parent.querySelector(".systemsculpt-agent-tool")!;
    expect(tool.tagName).toBe("DIV");
    expect(tool.querySelector(":scope > .systemsculpt-agent-tool-header")?.textContent)
      .toContain("Created Plan.md");
    expect(tool.querySelector(":scope > .systemsculpt-agent-tool-header")?.textContent)
      .toContain("Done");
    expect(tool.querySelector("summary")).toBeNull();
    expect(tool.querySelector("pre")).toBeNull();
    expect(tool.textContent).not.toContain("Result");
    expect(tool.textContent).not.toContain('"bytes": 13');
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
    expect(render).toHaveBeenCalledWith(
      working,
      expect.objectContaining({ busy: true, composerRunning: true }),
    );
    expect(parent.textContent).toContain("Working");
    workspace.unload();
  });

  it("retries turn anchoring when the lifecycle snapshot arrives before its durable user row", async () => {
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
    const notifyTurnStarted = jest.spyOn((workspace as any).scroller, "notifyTurnStarted");
    const started = applyManagedAgentEvent(
      createInitialAgentConversation(),
      envelope(1, { type: "run.started" }),
    );

    await workspace.setAgentSnapshot(started);
    expect(notifyTurnStarted).not.toHaveBeenCalled();

    await workspace.setHistory([{
      role: "user",
      message_id: "user-1",
      content: "Start",
    }]);
    expect(notifyTurnStarted).toHaveBeenCalledWith("message:user-1");
    workspace.unload();
  });

  it("renders reasoning summaries as compact streaming and durable disclosures", async () => {
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
    snapshot = applyManagedAgentEvent(snapshot, envelope(2, {
      type: "run.status",
      phase: "thinking",
      label: "Thinking",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(3, {
      type: "message.started",
      messageId: "assistant-reasoning",
      role: "assistant",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(4, {
      type: "reasoning.delta",
      messageId: "assistant-reasoning",
      partId: "reasoning-1",
      delta: "Checking the active note. ",
    }));
    await workspace.setAgentSnapshot(snapshot);

    const active = parent.querySelector<HTMLElement>(".systemsculpt-agent-active-run")!;
    let details = active.querySelector<HTMLDetailsElement>(".systemsculpt-agent-reasoning-details")!;
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("Thinking");
    expect(details.textContent).toContain("Checking the active note.");
    expect(active.querySelector(".systemsculpt-agent-part.is-status.is-thinking")).toBeNull();

    details.open = false;
    snapshot = applyManagedAgentEvent(snapshot, envelope(5, {
      type: "reasoning.delta",
      messageId: "assistant-reasoning",
      partId: "reasoning-1",
      delta: "Planning one safe edit.",
    }));
    await workspace.setAgentSnapshot(snapshot);
    details = active.querySelector<HTMLDetailsElement>(".systemsculpt-agent-reasoning-details")!;
    expect(details.open).toBe(false);

    details.open = true;
    snapshot = applyManagedAgentEvent(snapshot, envelope(6, {
      type: "reasoning.completed",
      messageId: "assistant-reasoning",
      partId: "reasoning-1",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(7, {
      type: "text.delta",
      messageId: "assistant-reasoning",
      partId: "text-1",
      delta: "Done.",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(8, {
      type: "text.completed",
      messageId: "assistant-reasoning",
      partId: "text-1",
    }));
    snapshot = applyManagedAgentEvent(snapshot, envelope(9, { type: "run.completed" }));
    await workspace.setAgentSnapshot(snapshot);
    details = active.querySelector<HTMLDetailsElement>(".systemsculpt-agent-reasoning-details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Reasoning");
    expect(active.textContent).toContain("Done.");

    await workspace.setHistory([{
      role: "assistant",
      message_id: "assistant-history-reasoning",
      content: "Done.",
      messageParts: [
        { id: "reasoning-history", type: "reasoning", timestamp: 1, data: "Checked the vault first." },
        { id: "content-history", type: "content", timestamp: 2, data: "Done." },
      ],
    }]);
    const historical = parent.querySelector<HTMLDetailsElement>(
      '[data-message-id="assistant-history-reasoning"] .systemsculpt-agent-reasoning-details',
    )!;
    expect(historical.open).toBe(false);
    expect(historical.textContent).toContain("Checked the vault first.");
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
    const continuing = applyManagedAgentEvent(started, envelope(2, {
      type: "run.status",
      phase: "working",
      label: "Continuing",
    }));
    await workspace.setAgentSnapshot(continuing);
    expect(parent.querySelector(".systemsculpt-agent-part.is-status")?.textContent).toContain("Continuing");

    const failed = applyManagedAgentEvent(continuing, envelope(3, {
      type: "run.failed",
      error: { code: "transport", message: "Connection lost." },
    }));

    await workspace.setAgentSnapshot(failed);

    expect(parent.textContent).toContain("Connection lost.");
    expect(parent.querySelector(".systemsculpt-agent-part.is-status")).toBeNull();
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
    const writeCall = {
      id: "call-1",
      messageId: "assistant-1",
      request: {
        id: "call-1",
        type: "function" as const,
        function: {
          name: "write",
          arguments: JSON.stringify({ path: "Projects/Project.md", content: "Done" }),
        },
      },
      state: "completed" as const,
      timestamp: 1,
      result: { success: true, data: { path: "Projects/Project.md" } },
    };
    await workspace.setHistory([{
      role: "assistant",
      content: "Updated the project note.",
      message_id: "assistant-1",
      tool_calls: [writeCall],
      messageParts: [
        { id: "write-part", type: "tool_call", timestamp: 1, data: writeCall },
        { id: "content-part", type: "content", timestamp: 2, data: "Updated the project note." },
      ],
    }]);

    expect(parent.textContent).toContain("Project.md");
    expect(parent.textContent).toContain("Write file");
    expect(parent.textContent).not.toContain("Mcp Filesystem");
    expect(parent.querySelector(".systemsculpt-agent-tool")?.textContent).not.toContain("Result");
    expect(parent.querySelector(".systemsculpt-agent-tool")?.querySelector("pre")).toBeNull();
    parent.querySelector<HTMLButtonElement>('.systemsculpt-agent-artifact [aria-label="Open"]')!.click();
    expect(onOpenArtifact).toHaveBeenCalledWith(expect.objectContaining({ path: "Projects/Project.md" }));
    workspace.unload();
  });

  it("restores a concise partial-result error and only successful artifacts", async () => {
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
    const partialCall = {
      id: "call-partial",
      messageId: "assistant-partial",
      request: {
        id: "call-partial",
        type: "function" as const,
        function: {
          name: "multi_edit",
          arguments: JSON.stringify({ files: [{ path: "Changed.md" }, { path: "Failed.md" }] }),
        },
      },
      state: "failed" as const,
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
    };
    await workspace.setHistory([{
      role: "assistant",
      content: "One file changed; one conflicted.",
      message_id: "assistant-partial",
      tool_calls: [partialCall],
      messageParts: [
        { id: "partial-part", type: "tool_call", timestamp: 1, data: partialCall },
        { id: "content-part", type: "content", timestamp: 2, data: "One file changed; one conflicted." },
      ],
    }]);

    expect(parent.querySelector(".systemsculpt-agent-tool")?.textContent)
      .toContain("One file changed; one conflicted.");
    expect(parent.querySelector(".systemsculpt-agent-tool")?.textContent).not.toContain("results");
    expect(parent.querySelector(".systemsculpt-agent-tool")?.querySelector("pre")).toBeNull();
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

    const outcomeCalls = [
      tool("denied", "USER_DENIED", "The user denied this tool execution."),
      tool("stopped", "TOOL_CANCELLED_BEFORE_START", "Cancelled before execution."),
      tool("uncertain", "TOOL_OUTCOME_UNKNOWN_AFTER_RESTART", "Outcome unknown after restart."),
    ];
    await workspace.setHistory([{
      role: "assistant",
      content: "Tool outcomes",
      message_id: "assistant-outcomes",
      tool_calls: outcomeCalls,
      messageParts: [
        ...outcomeCalls.map((call, index) => ({
          id: `part-${call.id}`,
          type: "tool_call" as const,
          timestamp: index + 1,
          data: call,
        })),
        { id: "content-part", type: "content", timestamp: 4, data: "Tool outcomes" },
      ],
    }]);

    const states = [...parent.querySelectorAll<HTMLElement>(".systemsculpt-agent-tool-state")]
      .map((element) => element.textContent);
    expect(states).toEqual(["Denied", "Stopped", "Check required"]);
    workspace.unload();
  });
});
