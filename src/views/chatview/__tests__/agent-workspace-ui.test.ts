/**
 * @jest-environment jsdom
 */

import { App, MarkdownRenderer, setIcon } from "obsidian";
import { AgentComposer } from "../AgentComposer";
import {
  type AgentArtifact,
  type AgentConversationSnapshot,
  type AgentPart,
} from "../AgentConversation";
import { AgentWorkspace } from "../AgentWorkspace";
import { AgentConversationRenderer } from "../AgentConversationRenderer";
import { ChatMarkdownSerializer } from "../storage/ChatMarkdownSerializer";
import type { ChatMessage } from "../../../types";
import type { UIMessage } from "ai";
import {
  durableAssistant,
  projectThinAgentChat,
} from "../thin/ThinAgentProjection";

function reloadSavedMessages(messages: ChatMessage[]): ChatMessage[] {
  const parsed = (ChatMarkdownSerializer as unknown as {
    parseSequentialFormat(content: string): { success: boolean; messages: ChatMessage[] };
  }).parseSequentialFormat(ChatMarkdownSerializer.serializeMessages(messages));
  expect(parsed.success).toBe(true);
  return parsed.messages;
}

describe("AgentComposer", () => {
  it("sends while idle, queues while running, and preserves line breaks", async () => {
    const parent = document.body.createDiv();
    const submissions: Array<{ text: string; mode: "send" | "queue" }> = [];
    const onStop = jest.fn();
    const composer = new AgentComposer(parent, {
      onSubmit: async (submission) => { submissions.push(submission); },
      onStop,
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
    expect(submissions).toEqual([{ text: "First request", mode: "send" }]);

    composer.setRunning(true);
    expect(parent.querySelector('[aria-label="Search the web"]')).toBeNull();
    parent.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click();
    expect(onStop).toHaveBeenCalledTimes(1);
    composer.setValue("Follow up");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(submissions.at(-1)).toEqual({ text: "Follow up", mode: "queue" });

    composer.setValue("Keep me");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(composer.getValue()).toBe("Keep me");
    composer.unload();
  });

  it("makes a saved-history composer visibly read-only until a new chat enables it", async () => {
    const parent = document.body.createDiv();
    const onSubmit = jest.fn(async () => undefined);
    const onAttach = jest.fn();
    const onRemoveAttachment = jest.fn();
    const composer = new AgentComposer(parent, {
      onSubmit,
      onStop: jest.fn(),
      onAttach,
      onRemoveAttachment,
    });
    composer.load();
    composer.setValue("Draft that must not be sent");
    composer.setAttachments([{
      id: "legacy-context",
      label: "Legacy.md",
      path: "Legacy.md",
      kind: "vault",
    }]);

    composer.setReadOnly("View-only saved chat. Start a new chat to continue.");

    const input = parent.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Start a new chat to continue.");
    expect(parent.querySelector(".systemsculpt-agent-prompt-hint")?.textContent)
      .toBe("View-only saved chat. Start a new chat to continue.");
    expect(parent.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
    expect(parent.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!.disabled).toBe(true);
    expect(parent.querySelector<HTMLButtonElement>(
      '[aria-label="Add vault context, including images"]',
    )!.disabled).toBe(true);
    expect(parent.querySelector<HTMLSelectElement>('[aria-label="Vault changes"]')!.disabled).toBe(true);
    expect(parent.querySelector<HTMLButtonElement>('[aria-label="Remove Legacy.md"]')!.disabled).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    parent.querySelector<HTMLButtonElement>('[aria-label="Remove Legacy.md"]')!.click();
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
    expect(onRemoveAttachment).not.toHaveBeenCalled();
    expect(composer.getValue()).toBe("Draft that must not be sent");

    composer.setReadOnly(null);

    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("Ask SystemSculpt to work in your vault…");
    expect(parent.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(false);
    parent.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith({
      text: "Draft that must not be sent",
      mode: "send",
    });
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
    const noticeLog = jest.spyOn(console, "log").mockImplementation(() => undefined);
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

    expect(noticeLog).toHaveBeenCalledWith(
      "Notice: broken.pdf could not be processed: conversion failed",
    );
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
    jest.useRealTimers();
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

  it("renders fixed and generic server activity without exposing protocol tool names", async () => {
    const host = document.body.createDiv();
    const onApprove = jest.fn();
    const renderer = new AgentConversationRenderer(host, {
      app: new App(),
      sourcePath: () => "",
      onApprove,
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    const node = host.createDiv();

    await (renderer as any).renderTool(node, {
      id: "server-search",
      order: 0,
      kind: "tool",
      messageId: "assistant-search",
      callId: "call-search",
      name: "web_search",
      location: "server",
      input: { query: "Obsidian agents" },
      state: "running",
    });
    expect(node.textContent).toContain("Search web");
    expect(node.textContent).not.toContain("web_search");

    node.empty();
    await (renderer as any).renderTool(node, {
      id: "server-additive",
      order: 0,
      kind: "tool",
      messageId: "assistant-additive",
      callId: "call-additive",
      name: "cf_agent_provider_retry",
      location: "server",
      input: { query: "provider-internal" },
      state: "running",
      output: { summary: "Cloudflare provider retry" },
    });
    expect(node.textContent).toContain("SystemSculpt action");
    expect(node.textContent).not.toMatch(/cf_agent|provider|cloudflare|retry/i);
    expect(node.querySelector(".systemsculpt-agent-tool-header")?.getAttribute("aria-label"))
      .toBe("SystemSculpt action, Working");

    node.empty();
    await (renderer as any).renderTool(node, {
      id: "server-write-collision",
      order: 0,
      kind: "tool",
      messageId: "assistant-write-collision",
      callId: "call-write-collision",
      name: "write",
      location: "server",
      input: { path: "server-private-path" },
      state: "approval-required",
      approvalId: "approval-server-write",
    });
    expect(node.textContent).toContain("SystemSculpt action");
    expect(node.textContent).toContain("Working");
    expect(node.textContent).not.toMatch(/needs approval|allow once|allow for chat/i);
    expect(node.querySelector(".systemsculpt-agent-approval")).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("omits inert path actions and reports artifact copy success or failure in place", async () => {
    const host = document.body.createDiv();
    const onOpenArtifact = jest.fn();
    const onCopyArtifactPath = jest.fn<Promise<boolean>, [AgentArtifact]>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const renderer = new AgentConversationRenderer(host, {
      app: new App(),
      sourcePath: () => "",
      onApprove: jest.fn(),
      onOpenArtifact,
      onCopyArtifactPath,
    });
    renderer.load();

    const pathless = host.createDiv();
    await (renderer as any).renderTool(pathless, {
      id: "pathless-tool",
      order: 0,
      kind: "tool",
      messageId: "assistant-pathless",
      callId: "call-pathless",
      name: "write",
      location: "vault",
      input: {},
      state: "succeeded",
      output: {
        artifacts: [{
          id: "pathless-artifact",
          kind: "generated_file",
          title: "Generated result",
        }],
      },
    });
    expect(pathless.textContent).toContain("Generated result");
    expect(pathless.querySelector(".systemsculpt-agent-artifact-actions")).toBeNull();
    expect(pathless.querySelector('[aria-label="Open"]')).toBeNull();
    expect(pathless.querySelector('[aria-label="Copy path"]')).toBeNull();

    const actionable = host.createDiv();
    const artifact: AgentArtifact = {
      id: "artifact-with-path",
      kind: "vault_file",
      title: "Project.md",
      path: "Projects/Project.md",
    };
    await (renderer as any).renderTool(actionable, {
      id: "path-tool",
      order: 0,
      kind: "tool",
      messageId: "assistant-path",
      callId: "call-path",
      name: "write",
      location: "vault",
      input: { path: artifact.path },
      state: "succeeded",
      output: { artifacts: [artifact] },
    });

    actionable.querySelector<HTMLButtonElement>('[aria-label="Open"]')!.click();
    expect(onOpenArtifact).toHaveBeenCalledWith(artifact);
    const copy = actionable.querySelector<HTMLButtonElement>('[aria-label="Copy path"]')!;
    copy.focus();
    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCopyArtifactPath).toHaveBeenLastCalledWith(artifact);
    expect(copy.classList.contains("is-copied")).toBe(true);
    expect(copy.getAttribute("aria-label")).toBe("Path copied");
    expect(document.activeElement).toBe(copy);

    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copy.classList.contains("is-copy-failed")).toBe(true);
    expect(copy.getAttribute("aria-label")).toBe("Could not copy path. Try again");
    expect(document.activeElement).toBe(copy);
    expect((renderer as any).copyFeedbackTimers.size).toBe(1);
    renderer.unload();
    expect((renderer as any).copyFeedbackTimers.size).toBe(0);
  });

  it("opens an oldest-shape persisted web search without crashing the history renderer", async () => {
    const host = document.body.createDiv();
    const renderer = new AgentConversationRenderer(host, {
      app: new App(),
      sourcePath: () => "",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
    });
    const flatWebSearch = {
      id: "flat-web-search",
      messageId: "assistant-legacy",
      name: "web_search",
      arguments: { query: "legacy release" },
      state: "completed",
      timestamp: 1,
      result: {
        success: true,
        data: { tool: "web_search", result_count: 1 },
      },
    };

    await expect(renderer.renderHistory([{
      role: "assistant",
      message_id: "assistant-legacy",
      content: "Legacy search answer",
      tool_calls: [flatWebSearch as any],
      messageParts: [
        {
          id: "tool_call_part-flat-web-search",
          type: "tool_call",
          data: flatWebSearch as any,
          timestamp: 1,
        },
        {
          id: "content-legacy",
          type: "content",
          data: "Legacy search answer",
          timestamp: 2,
        },
      ],
    }])).resolves.toBeUndefined();

    expect((renderer as any).historicalToolPart(flatWebSearch)).toMatchObject({
      name: "web_search",
      location: "server",
      state: "succeeded",
      output: {
        data: { tool: "web_search", result_count: 1 },
      },
    });
    expect(host.querySelector(".systemsculpt-agent-tool")).not.toBeNull();
    expect(host.textContent).toContain("Search web");
    expect(host.textContent).toContain("Legacy search answer");
    expect(host.textContent).not.toContain("legacy release");
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
      onOpenCredits: jest.fn(),
      onCancelQueued: jest.fn(),
      onRunQueuedNow: jest.fn(),
    });
    workspace.load();

    expect(workspace.element.matches('.ss-surface[data-ss-surface="view"]')).toBe(true);
    expect(parent.querySelector('[aria-label="Chat history"]')?.classList.contains("ss-button--icon")).toBe(true);
    expect(parent.querySelector('[aria-label="Attach files"]')?.classList.contains("ss-button--icon")).toBe(true);
    expect(parent.querySelector('[aria-label="Jump to latest"]')?.classList.contains("ss-button")).toBe(true);
    expect(parent.querySelector(".systemsculpt-agent-credits")?.textContent).toBe("Credits");
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
    workspace.setQueue([
      {
        id: "queued-1",
        text: "Follow up with private message content",
        includeContextFiles: true,
      },
      {
        id: "queued-2",
        text: "Second private follow-up",
        includeContextFiles: false,
      },
    ]);
    expect(parent.querySelector(".systemsculpt-agent-queue")?.getAttribute("role"))
      .toBe("list");
    expect(parent.querySelectorAll('.systemsculpt-agent-queue-item[role="listitem"]'))
      .toHaveLength(2);
    const actionLabels = Array.from(
      parent.querySelectorAll<HTMLButtonElement>(".systemsculpt-agent-queue-item button"),
      (button) => button.getAttribute("aria-label"),
    );
    expect(actionLabels).toEqual([
      "Stop and send queued follow-up 1 of 2 now",
      "Remove queued follow-up 1 of 2",
      "Stop and send queued follow-up 2 of 2 now",
      "Remove queued follow-up 2 of 2",
    ]);
    expect(actionLabels.join(" ")).not.toContain("private");

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

  it("appends history without rebuilding earlier turns, controls, focus, or selection", async () => {
    const host = document.body.createDiv();
    const renderer = new AgentConversationRenderer(host, {
      app: new App(),
      sourcePath: () => "",
      onApprove: jest.fn(),
      onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(),
      onCopyText: jest.fn(async () => true),
    });
    renderer.load();
    const render = jest.spyOn(MarkdownRenderer, "render").mockImplementation(
      async (_app, markdown, parent) => {
        if (String(markdown).includes("const stable")) {
          parent.innerHTML = "<pre><code>const stable = true;</code></pre>";
        } else {
          parent.setText(String(markdown));
        }
      },
    );
    const firstHistory: ChatMessage[] = [{
      role: "user",
      message_id: "history-user-1",
      content: "First request",
    }, {
      role: "assistant",
      message_id: "history-assistant-1",
      content: "```ts\nconst stable = true;\n```",
    }];
    await renderer.renderHistory(firstHistory);
    const assistantRow = host.querySelector<HTMLElement>(
      '[data-message-id="history-assistant-1"]',
    )!;
    const code = assistantRow.querySelector<HTMLElement>("code")!;
    const copy = assistantRow.querySelector<HTMLButtonElement>(
      ".systemsculpt-agent-code-copy",
    )!;
    copy.focus();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    const initialRenderCalls = render.mock.calls.length;

    await renderer.renderHistory([
      ...JSON.parse(JSON.stringify(firstHistory)) as ChatMessage[],
      {
        role: "user",
        message_id: "history-user-2",
        content: "Second request",
      },
    ]);

    expect(host.querySelector('[data-message-id="history-assistant-1"]')).toBe(assistantRow);
    expect(assistantRow.querySelector(".systemsculpt-agent-code-copy")).toBe(copy);
    expect(document.activeElement).toBe(copy);
    expect(selection.toString()).toBe("const stable = true;");
    expect(render).toHaveBeenCalledTimes(initialRenderCalls + 1);
    renderer.unload();
    render.mockRestore();
  });

  it("containerizes rendered code and shows compact copy success feedback", async () => {
    jest.useFakeTimers();
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

    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect((renderer as any).copyFeedbackTimers.size).toBe(1);

    jest.advanceTimersByTime(1_600);
    expect(copy.classList.contains("is-copied")).toBe(false);
    expect(copy.textContent).toContain("Copy");
    expect(copy.getAttribute("aria-label")).toBe("Copy code");
    expect((renderer as any).copyFeedbackTimers.size).toBe(0);

    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copy.classList.contains("is-copy-failed")).toBe(true);
    expect(copy.getAttribute("aria-label")).toBe("Could not copy code");
    copy.remove();
    jest.advanceTimersByTime(1_600);
    expect((renderer as any).copyFeedbackTimers.size).toBe(0);

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
      content: "A response worth copying.\n\n### Sources\n\n- [Reference](<https://example.com/reference>)",
      messageParts: [{
        id: "answer",
        type: "content",
        timestamp: 1,
        data: "A response worth copying.",
      }, {
        id: "sources",
        type: "content",
        timestamp: 2,
        data: "### Sources\n\n- [Reference](<https://example.com/reference>)",
      }],
    }]);
    const copy = host.querySelector<HTMLButtonElement>(".systemsculpt-agent-message-copy")!;
    expect(copy.classList.contains("ss-button--icon")).toBe(true);
    expect(copy.textContent).not.toContain("Copy");
    expect(copy.title).toBe("Copy response");
    copy.focus();
    copy.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onCopyText).toHaveBeenCalledWith(
      "A response worth copying.\n\n### Sources\n\n- [Reference](<https://example.com/reference>)",
    );
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
      includeContextFiles: true,
    }]);

    const approvalTool: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-1",
      kind: "tool",
      messageId: "assistant-1",
      callId: "call-1",
      name: "edit",
      location: "vault",
      input: { path: "Project.md" },
      state: "approval-required",
      approvalId: "approval-1",
      order: 0,
    };
    let snapshot: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "waiting",
      phase: "waiting",
      statusLabel: "Starting",
      waitingReason: "approval",
      messages: [{ id: "assistant-1", role: "assistant", partIds: ["tool-1"] }],
      parts: [approvalTool],
    };
    await workspace.setAgentSnapshot(snapshot);

    expect(parent.textContent).toContain("Update Project.md");
    expect(parent.textContent).toContain("Then summarize it");
    expect(parent.textContent).toContain("Needs approval");
    parent.querySelector<HTMLButtonElement>('[data-focus-key="tool-deny"]')!.click();
    expect(onApprove).toHaveBeenCalledWith("approval-1", false);
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
    snapshot = {
      ...snapshot,
      parts: [{ ...approvalTool, state: "approved" }],
    };
    await workspace.setAgentSnapshot(snapshot);
    expect(parent.querySelector(".systemsculpt-agent-part.is-tool")).toBe(pendingPart);
    expect(pendingPart.querySelector("summary")).toBeNull();

    snapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "completed",
      phase: "complete",
      messages: [{ id: "assistant-1", role: "assistant", partIds: ["tool-1"] }],
      parts: [{
        ...approvalTool,
        state: "succeeded",
        output: {
          summary: "Updated Project.md",
          artifacts: [{
            id: "artifact-1",
            kind: "vault_file",
            title: "Project.md",
            path: "Project.md",
          }],
        },
      }],
    };
    await workspace.setAgentSnapshot(snapshot);

    expect(parent.textContent).toContain("Updated Project.md");
    parent.querySelector<HTMLButtonElement>('.systemsculpt-agent-artifact [aria-label="Open"]')!.click();
    expect(onOpenArtifact).toHaveBeenCalledWith(expect.objectContaining({ path: "Project.md" }));
    workspace.unload();
  });

  it("keeps one continuation header beside visible streamed content", async () => {
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

    const snapshot: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "working",
      statusLabel: "Continuing",
      messages: [{
        id: "assistant-continuing",
        role: "assistant",
        partIds: ["text-continuing"],
      }],
      parts: [{
        id: "text-continuing",
        kind: "text",
        messageId: "assistant-continuing",
        state: "streaming",
        markdown: "Working through the result",
        order: 0,
      }],
    };
    await workspace.setAgentSnapshot(snapshot);

    const turn = parent.querySelector(".systemsculpt-agent-active-run .systemsculpt-agent-turn.is-active");
    expect(turn).not.toBeNull();
    expect(turn?.querySelector(".systemsculpt-agent-part.is-text")?.textContent)
      .toContain("Working through the result");
    expect(turn?.querySelector(".systemsculpt-agent-part.is-status")).toBeNull();
    expect(turn?.querySelectorAll(".systemsculpt-agent-activity")).toHaveLength(1);
    expect(turn?.querySelector(".systemsculpt-agent-activity-state")?.textContent)
      .toBe("Continuing");
    workspace.unload();
  });

  it("keeps one stable animated activity header through every live run phase", async () => {
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
    const textPart = {
      id: "text-phase",
      kind: "text" as const,
      messageId: "assistant-phase",
      state: "streaming" as const,
      markdown: "Streaming answer",
      order: 1,
    };
    const snapshot = (
      phase: NonNullable<AgentConversationSnapshot["phase"]>,
      statusLabel: string,
      tool?: Extract<AgentPart, { kind: "tool" }>,
    ): AgentConversationSnapshot => ({
      runId: "run-phase",
      turnId: "user-phase",
      status: tool?.state === "approval-required" ? "waiting" : "running",
      phase,
      statusLabel,
      ...(tool?.state === "approval-required"
        ? { waitingReason: "approval" as const }
        : {}),
      messages: [{
        id: "assistant-phase",
        role: "assistant",
        partIds: [...(tool ? [tool.id] : []), textPart.id],
      }],
      parts: [...(tool ? [tool] : []), textPart],
    });
    const assertPhase = async (
      value: AgentConversationSnapshot,
      label: string,
      expectedActivity?: HTMLElement,
    ): Promise<HTMLElement> => {
      await workspace.setAgentSnapshot(value);
      const activity = parent.querySelector<HTMLElement>(".systemsculpt-agent-activity")!;
      expect(activity).toBe(expectedActivity ?? activity);
      expect(activity.querySelector(".systemsculpt-agent-activity-state")?.textContent).toBe(label);
      expect(activity.querySelector(".systemsculpt-agent-activity-icon")?.classList)
        .toContain("is-animated");
      expect(parent.querySelectorAll(".systemsculpt-agent-activity")).toHaveLength(1);
      expect(parent.querySelector(".systemsculpt-agent-part.is-status")).toBeNull();
      expect(parent.querySelector(".systemsculpt-agent-part.is-text")?.textContent)
        .toContain("Streaming answer");
      return activity;
    };

    const activity = await assertPhase(snapshot("thinking", "Working"), "Thinking");
    await assertPhase(snapshot("working", "Working", {
      id: "tool-search",
      kind: "tool",
      messageId: "assistant-phase",
      callId: "call-search",
      name: "web_search",
      location: "server",
      input: { query: "Obsidian" },
      state: "running",
      order: 0,
    }), "Searching", activity);
    await assertPhase(snapshot("waiting", "Working", {
      id: "tool-write",
      kind: "tool",
      messageId: "assistant-phase",
      callId: "call-write",
      name: "write",
      location: "vault",
      input: { path: "Plan.md" },
      state: "running",
      order: 0,
    }), "Working in vault", activity);
    await assertPhase(snapshot("waiting", "Working", {
      id: "tool-approval",
      kind: "tool",
      messageId: "assistant-phase",
      callId: "call-approval",
      name: "write",
      location: "vault",
      input: { path: "Plan.md" },
      state: "approval-required",
      approvalId: "approval-write",
      order: 0,
    }), "Needs approval", activity);
    await assertPhase(snapshot("retrying", "Continuing"), "Continuing", activity);
    await assertPhase(snapshot("retrying", "Reconnecting"), "Continuing", activity);
    await assertPhase(snapshot("settling", "Finishing"), "Finishing", activity);
    workspace.unload();
  });

  it("preserves activity icon and spinner identity across streamed token snapshots", async () => {
    const setIconMock = setIcon as jest.Mock;
    const previousImplementation = setIconMock.getMockImplementation();
    const markdownRender = jest.spyOn(MarkdownRenderer, "render");
    setIconMock.mockImplementation((element: HTMLElement, name: string) => {
      const svg = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("data-icon", name);
      element.replaceChildren(svg);
    });
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

    try {
      const snapshot = (
        markdown: string,
        completed = false,
      ): AgentConversationSnapshot => ({
        runId: "run-1",
        turnId: "user-1",
        status: completed ? "completed" : "running",
        phase: completed ? "complete" : "submitted",
        ...(!completed ? { statusLabel: "Starting" } : {}),
        messages: [{
          id: "assistant-token-stream",
          role: "assistant",
          partIds: ["reasoning-token-stream", "tool-token-stream", "text-token-stream"],
        }],
        parts: [{
          id: "reasoning-token-stream",
          kind: "reasoning",
          messageId: "assistant-token-stream",
          state: "complete",
          summary: "Planning the vault change",
          order: 0,
        }, {
          id: "tool-token-stream",
          kind: "tool",
          messageId: "assistant-token-stream",
          callId: "call-token-stream",
          name: "write",
          location: "vault",
          input: undefined,
          state: completed ? "succeeded" : "approval-required",
          approvalId: "approval-token-stream",
          ...(completed ? { output: { summary: "Search complete" } } : {}),
          order: 1,
        }, {
          id: "text-token-stream",
          kind: "text",
          messageId: "assistant-token-stream",
          state: completed ? "complete" : "streaming",
          markdown,
          order: 2,
        }],
      });
      let currentSnapshot = snapshot("First token");
      await workspace.setAgentSnapshot(currentSnapshot);

      const activity = parent.querySelector<HTMLElement>(".systemsculpt-agent-activity")!;
      const icon = activity.querySelector<HTMLElement>(".systemsculpt-agent-activity-icon")!;
      const spinner = icon.querySelector<SVGElement>("svg")!;
      const activityIconCalls = () =>
        setIconMock.mock.calls.filter(([element]) => element === icon).length;
      const busyCallCount = activityIconCalls();
      expect(busyCallCount).toBe(1);
      const reasoningDetails = activity.querySelector<HTMLDetailsElement>(
        ".systemsculpt-agent-reasoning-details",
      )!;
      const reasoningIcon = activity.querySelector<HTMLElement>(
        ".systemsculpt-agent-reasoning-icon",
      )!;
      const reasoningSvg = reasoningIcon.querySelector("svg");
      const toolNode = activity.querySelector<HTMLElement>(".systemsculpt-agent-part.is-tool")!;
      const toolIcon = toolNode.querySelector<HTMLElement>(".systemsculpt-agent-tool-icon")!;
      const toolSvg = toolIcon.querySelector("svg");
      const approvalButton = toolNode.querySelector<HTMLButtonElement>(
        '[data-focus-key="tool-allow-once"]',
      )!;
      const textPart = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-text")!;
      const streamedTextNode = textPart.firstChild;
      expect(streamedTextNode?.nodeType).toBe(Node.TEXT_NODE);
      const markdownCallsBeforeSuffix = markdownRender.mock.calls.length;
      approvalButton.focus();

      currentSnapshot = snapshot("First token and second token");
      await workspace.setAgentSnapshot(currentSnapshot);

      expect(parent.querySelector(".systemsculpt-agent-activity")).toBe(activity);
      expect(parent.querySelector(".systemsculpt-agent-activity-icon")).toBe(icon);
      expect(icon.querySelector("svg")).toBe(spinner);
      expect(activityIconCalls()).toBe(busyCallCount);
      expect(activity.querySelector(".systemsculpt-agent-reasoning-details")).toBe(reasoningDetails);
      expect(activity.querySelector(".systemsculpt-agent-reasoning-icon")).toBe(reasoningIcon);
      expect(reasoningIcon.querySelector("svg")).toBe(reasoningSvg);
      expect(activity.querySelector(".systemsculpt-agent-part.is-tool")).toBe(toolNode);
      expect(toolNode.querySelector(".systemsculpt-agent-tool-icon")).toBe(toolIcon);
      expect(toolIcon.querySelector("svg")).toBe(toolSvg);
      expect(toolNode.querySelector('[data-focus-key="tool-allow-once"]')).toBe(approvalButton);
      expect(document.activeElement).toBe(approvalButton);
      expect(textPart.firstChild).toBe(streamedTextNode);
      expect(textPart.textContent).toBe("First token and second token");
      expect(markdownRender).toHaveBeenCalledTimes(markdownCallsBeforeSuffix);

      const selection = document.getSelection()!;
      const selectedToken = document.createRange();
      selectedToken.setStart(streamedTextNode!, 0);
      selectedToken.setEnd(streamedTextNode!, 5);
      selection.removeAllRanges();
      selection.addRange(selectedToken);
      reasoningDetails.open = true;
      approvalButton.focus();
      const burstRender = jest.spyOn(workspace.renderer, "renderActive");
      const burstPrefix = "First token and second token ";
      const burstSuffix = Array.from(
        { length: 64 },
        (_, index) => String.fromCharCode(97 + (index % 26)),
      ).join("");
      const burstSnapshots = Array.from(burstSuffix, (_, index) =>
        snapshot(`${burstPrefix}${burstSuffix.slice(0, index + 1)}`));
      await Promise.all(
        burstSnapshots.map((burstSnapshot) =>
          workspace.setAgentSnapshot(burstSnapshot)),
      );
      currentSnapshot = burstSnapshots.at(-1)!;

      expect(burstRender).toHaveBeenCalledTimes(1);
      expect(burstRender.mock.calls[0][0]).toBe(currentSnapshot);
      expect(parent.querySelector(".systemsculpt-agent-activity")).toBe(activity);
      expect(parent.querySelector(".systemsculpt-agent-activity-icon")).toBe(icon);
      expect(icon.querySelector("svg")).toBe(spinner);
      expect(activityIconCalls()).toBe(busyCallCount);
      expect(activity.querySelector(".systemsculpt-agent-reasoning-details")).toBe(reasoningDetails);
      expect(activity.querySelector(".systemsculpt-agent-reasoning-icon")).toBe(reasoningIcon);
      expect(reasoningIcon.querySelector("svg")).toBe(reasoningSvg);
      expect(reasoningDetails.open).toBe(true);
      expect(activity.querySelector(".systemsculpt-agent-part.is-tool")).toBe(toolNode);
      expect(toolNode.querySelector(".systemsculpt-agent-tool-icon")).toBe(toolIcon);
      expect(toolIcon.querySelector("svg")).toBe(toolSvg);
      expect(toolNode.querySelector('[data-focus-key="tool-allow-once"]')).toBe(approvalButton);
      expect(document.activeElement).toBe(approvalButton);
      expect(textPart.firstChild).toBe(streamedTextNode);
      expect(textPart.textContent).toBe(`${burstPrefix}${burstSuffix}`);
      expect(selection.toString()).toBe("First");
      expect(selection.anchorNode).toBe(streamedTextNode);
      expect(selection.anchorOffset).toBe(0);
      expect(selection.focusNode).toBe(streamedTextNode);
      expect(selection.focusOffset).toBe(5);
      expect(markdownRender).toHaveBeenCalledTimes(markdownCallsBeforeSuffix);
      burstRender.mockRestore();

      const formattedStream = [
        `${burstPrefix}${burstSuffix}`,
        "",
        "# Heading",
        "",
        "- list item with *emphasis*",
        "",
        "[official source](https://help.obsidian.md)",
        "",
        "```ts",
        "const streamed = true;",
        "```",
      ].join("\n");
      currentSnapshot = snapshot(formattedStream);
      await workspace.setAgentSnapshot(currentSnapshot);
      expect(textPart.firstChild).toBe(streamedTextNode);
      expect(textPart.textContent).toBe(formattedStream);
      expect(selection.toString()).toBe("First");
      expect(selection.anchorNode).toBe(streamedTextNode);
      expect(selection.focusNode).toBe(streamedTextNode);
      expect(markdownRender).toHaveBeenCalledTimes(markdownCallsBeforeSuffix);
      expect(parent.querySelector(".systemsculpt-agent-activity")).toBe(activity);
      expect(icon.querySelector("svg")).toBe(spinner);
      expect(activityIconCalls()).toBe(busyCallCount);

      const correctedFormattedStream = formattedStream.replace(
        "const streamed = true;",
        "const corrected = true;",
      );
      currentSnapshot = snapshot(correctedFormattedStream);
      await workspace.setAgentSnapshot(currentSnapshot);
      const correctedTextNode = textPart.firstChild;
      expect(correctedTextNode).not.toBe(streamedTextNode);
      expect(correctedTextNode?.nodeType).toBe(Node.TEXT_NODE);
      expect(textPart.textContent).toBe(correctedFormattedStream);
      expect(markdownRender).toHaveBeenCalledTimes(markdownCallsBeforeSuffix);
      expect(parent.querySelector(".systemsculpt-agent-activity")).toBe(activity);
      expect(icon.querySelector("svg")).toBe(spinner);
      expect(activityIconCalls()).toBe(busyCallCount);

      currentSnapshot = snapshot(
        correctedFormattedStream,
        true,
      );
      await workspace.setAgentSnapshot(currentSnapshot);

      expect(textPart.firstChild).not.toBe(correctedTextNode);
      expect(markdownRender).toHaveBeenCalledTimes(markdownCallsBeforeSuffix + 1);
      expect(parent.querySelector(".systemsculpt-agent-activity")).toBe(activity);
      expect(parent.querySelector(".systemsculpt-agent-activity-icon")).toBe(icon);
      expect(icon.querySelector("svg")).not.toBe(spinner);
      expect(activityIconCalls()).toBe(busyCallCount + 1);
      expect(icon.classList).not.toContain("is-animated");
    } finally {
      workspace.unload();
      markdownRender.mockRestore();
      setIconMock.mockImplementation(previousImplementation ?? (() => undefined));
    }
  });

  it("leaves a large settled tool subtree untouched across unrelated text deltas", async () => {
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
    const snapshot = (markdown: string): AgentConversationSnapshot => ({
      runId: "run-large-tool",
      turnId: "user-large-tool",
      status: "running",
      phase: "working",
      statusLabel: "Working",
      messages: [{
        id: "assistant-large-tool",
        role: "assistant",
        partIds: ["tool-large", "text-large"],
      }],
      parts: [{
        id: "tool-large",
        kind: "tool",
        messageId: "assistant-large-tool",
        callId: "call-large",
        name: "read",
        location: "vault",
        input: { paths: ["Large.md"] },
        state: "succeeded",
        output: {
          summary: "Loaded the note",
          data: { content: "x".repeat(250_000) },
        },
        order: 0,
      }, {
        id: "text-large",
        kind: "text",
        messageId: "assistant-large-tool",
        state: "streaming",
        markdown,
        order: 1,
      }],
    });

    await workspace.setAgentSnapshot(snapshot("Token"));
    const toolNode = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-tool")!;
    const toolShell = toolNode.firstElementChild;
    const toolIcon = toolNode.querySelector<HTMLElement>(".systemsculpt-agent-tool-icon")!;
    const iconCallCount = (setIcon as jest.Mock).mock.calls
      .filter(([element]) => element === toolIcon).length;

    let markdown = "Token";
    for (let index = 0; index < 12; index += 1) {
      markdown += ` ${index}`;
      await workspace.setAgentSnapshot(snapshot(markdown));
      expect(parent.querySelector(".systemsculpt-agent-part.is-tool")).toBe(toolNode);
      expect(toolNode.firstElementChild).toBe(toolShell);
    }
    expect((setIcon as jest.Mock).mock.calls
      .filter(([element]) => element === toolIcon)).toHaveLength(iconCallCount);
    workspace.unload();
  });

  it("does not remount a server tool when only hidden streamed payloads change", async () => {
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
    const snapshot = (input: unknown, output?: unknown): AgentConversationSnapshot => ({
      runId: "run-server-payload",
      turnId: "user-server-payload",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-server-payload",
        role: "assistant",
        partIds: ["tool-server-payload"],
      }],
      parts: [{
        id: "tool-server-payload",
        kind: "tool",
        messageId: "assistant-server-payload",
        callId: "call-server-payload",
        name: "web_search",
        location: "server",
        input,
        state: "running",
        ...(output === undefined ? {} : { output: { data: output } }),
        order: 0,
      }],
    });

    await workspace.setAgentSnapshot(snapshot({ query: "clo" }));
    const toolNode = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-tool")!;
    const shell = toolNode.firstElementChild;
    const icon = toolNode.querySelector<HTMLElement>(".systemsculpt-agent-tool-icon")!;
    const svg = icon.firstElementChild;

    await workspace.setAgentSnapshot(snapshot(
      { query: "cloudflare official documentation", hidden: "x".repeat(250_000) },
      { raw: "y".repeat(250_000) },
    ));

    expect(parent.querySelector(".systemsculpt-agent-part.is-tool")).toBe(toolNode);
    expect(toolNode.firstElementChild).toBe(shell);
    expect(toolNode.querySelector(".systemsculpt-agent-tool-icon")).toBe(icon);
    expect(icon.firstElementChild).toBe(svg);
    expect(toolNode.textContent).toContain("Search web");
    expect(toolNode.textContent).not.toContain("cloudflare official documentation");
    workspace.unload();
  });

  it("keeps a text-only terminal activity row until the completed run settles", async () => {
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
    const running: AgentConversationSnapshot = {
      runId: "run-text-terminal",
      turnId: "user-text-terminal",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-text-terminal",
        role: "assistant",
        partIds: ["text-terminal"],
      }],
      parts: [{
        id: "text-terminal",
        kind: "text",
        messageId: "assistant-text-terminal",
        state: "streaming",
        markdown: "Final",
        order: 0,
      }],
    };
    await workspace.setAgentSnapshot(running);
    const activity = parent.querySelector<HTMLElement>(".systemsculpt-agent-activity")!;

    await workspace.setAgentSnapshot({
      ...running,
      status: "completed",
      phase: "complete",
      parts: [{
        ...running.parts[0] as Extract<AgentPart, { kind: "text" }>,
        state: "complete",
        markdown: "Final answer",
      }],
    });

    expect(parent.querySelector(".systemsculpt-agent-activity")).toBe(activity);
    expect(activity.getAttribute("aria-label")).toBe("Agent activity: Done");
    expect(activity.querySelector(".systemsculpt-agent-activity-state")?.textContent).toBe("Done");
    workspace.unload();
  });

  it.each([
    {
      status: "failed" as const,
      expectedLabel: "Failed",
      parts: [{
        id: "error-empty-terminal",
        kind: "error" as const,
        error: { code: "response_failed", message: "Could not finish." },
        retryable: false,
        order: 0,
      }],
    },
    {
      status: "cancelled" as const,
      expectedLabel: "Stopped",
      parts: [],
    },
  ])("retains the same activity row for an otherwise empty $status terminal", async ({
    status,
    expectedLabel,
    parts,
  }) => {
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
    const running: AgentConversationSnapshot = {
      runId: `run-empty-${status}`,
      turnId: `user-empty-${status}`,
      status: "running",
      phase: "working",
      messages: [],
      parts: [],
    };
    await workspace.setAgentSnapshot(running);
    const activity = parent.querySelector<HTMLElement>(".systemsculpt-agent-activity")!;

    await workspace.setAgentSnapshot({
      ...running,
      status,
      phase: "complete",
      parts,
    });

    expect(parent.querySelector(".systemsculpt-agent-activity")).toBe(activity);
    expect(activity.getAttribute("aria-label")).toBe(`Agent activity: ${expectedLabel}`);
    expect(activity.querySelector(".systemsculpt-agent-activity-state")?.textContent)
      .toBe(expectedLabel);
    workspace.unload();
  });

  it("keeps streamed text visible until completed Markdown is ready", async () => {
    const parent = document.body.createDiv();
    const markdownRender = jest.spyOn(MarkdownRenderer, "render");
    let releaseRender!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseRender = resolve; });
    markdownRender.mockImplementation(async (
      _app: App,
      markdown: string,
      target: HTMLElement,
    ) => {
      markStarted();
      await released;
      target.createEl("p", { text: markdown });
    });
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
    const snapshot = (complete: boolean): AgentConversationSnapshot => ({
      runId: "run-markdown-handoff",
      turnId: "user-markdown-handoff",
      status: complete ? "completed" : "running",
      phase: complete ? "complete" : "working",
      messages: [{
        id: "assistant-markdown-handoff",
        role: "assistant",
        partIds: ["text-markdown-handoff"],
      }],
      parts: [{
        id: "text-markdown-handoff",
        kind: "text",
        messageId: "assistant-markdown-handoff",
        state: complete ? "complete" : "streaming",
        markdown: "**Still visible**",
        order: 0,
      }],
    });

    try {
      await workspace.setAgentSnapshot(snapshot(false));
      const textPart = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-text")!;
      const rawText = textPart.firstChild;
      const completion = workspace.setAgentSnapshot(snapshot(true));
      await started;

      expect(textPart.firstChild).toBe(rawText);
      expect(textPart.textContent).toBe("**Still visible**");

      releaseRender();
      await completion;
      expect(textPart.firstChild).not.toBe(rawText);
      expect(textPart.textContent).toBe("**Still visible**");
    } finally {
      releaseRender();
      await workspace.setAgentSnapshot(null);
      workspace.unload();
      markdownRender.mockRestore();
    }
  });

  it("retains streamed text when completed Markdown rendering rejects", async () => {
    const parent = document.body.createDiv();
    const markdownRender = jest.spyOn(MarkdownRenderer, "render");
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
    const running: AgentConversationSnapshot = {
      runId: "run-markdown-reject",
      turnId: "user-markdown-reject",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-markdown-reject",
        role: "assistant",
        partIds: ["text-markdown-reject"],
      }],
      parts: [{
        id: "text-markdown-reject",
        kind: "text",
        messageId: "assistant-markdown-reject",
        state: "streaming",
        markdown: "Visible response",
        order: 0,
      }],
    };

    try {
      await workspace.setAgentSnapshot(running);
      const textPart = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-text")!;
      const rawText = textPart.firstChild;
      markdownRender.mockRejectedValueOnce(new Error("postprocessor failed"));

      await expect(workspace.setAgentSnapshot({
        ...running,
        status: "completed",
        phase: "complete",
        parts: [{
          ...running.parts[0] as Extract<AgentPart, { kind: "text" }>,
          state: "complete",
        }],
      })).rejects.toThrow("postprocessor failed");

      expect(textPart.firstChild).toBe(rawText);
      expect(textPart.textContent).toBe("Visible response");
    } finally {
      workspace.unload();
      markdownRender.mockRestore();
    }
  });

  it("streams a reasoning suffix without remounting its disclosure, icon, focus, or selection", async () => {
    const markdownRender = jest.spyOn(MarkdownRenderer, "render");
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

    const snapshot = (
      summary: string,
      state: "streaming" | "complete" = "streaming",
    ): AgentConversationSnapshot => ({
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "submitted",
      statusLabel: "Starting",
      messages: [{
        id: "assistant-reasoning-identity",
        role: "assistant",
        partIds: ["reasoning-identity"],
      }],
      parts: [{
        id: "reasoning-identity",
        kind: "reasoning",
        messageId: "assistant-reasoning-identity",
        state,
        summary,
        order: 0,
      }],
    });
    await workspace.setAgentSnapshot(snapshot("Reading the note"));
    expect(markdownRender).not.toHaveBeenCalled();

    const details = parent.querySelector<HTMLDetailsElement>(
      ".systemsculpt-agent-reasoning-details",
    )!;
    const header = details.querySelector<HTMLElement>(
      ".systemsculpt-agent-reasoning-header",
    )!;
    const icon = details.querySelector<HTMLElement>(
      ".systemsculpt-agent-reasoning-icon",
    )!;
    const body = details.querySelector<HTMLElement>(
      ".systemsculpt-agent-reasoning-body",
    )!;
    const bodyText = body.firstChild!;
    expect(bodyText.nodeType).toBe(Node.TEXT_NODE);
    const iconCalls = () => (setIcon as jest.Mock).mock.calls
      .filter(([element]) => element === icon).length;
    const initialIconCalls = iconCalls();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(bodyText, 0);
    range.setEnd(bodyText, 7);
    selection.removeAllRanges();
    selection.addRange(range);

    const formattedSummary = [
      "Reading the note and checking links",
      "",
      "## Checks",
      "",
      "- preserve *selection*",
      "",
      "```text",
      "stream safely",
      "```",
    ].join("\n");
    await workspace.setAgentSnapshot(snapshot(formattedSummary));

    expect(parent.querySelector(".systemsculpt-agent-reasoning-details")).toBe(details);
    expect(parent.querySelector(".systemsculpt-agent-reasoning-header")).toBe(header);
    expect(parent.querySelector(".systemsculpt-agent-reasoning-icon")).toBe(icon);
    expect(body.firstChild).toBe(bodyText);
    expect(body.textContent).toBe(formattedSummary);
    expect(iconCalls()).toBe(initialIconCalls);
    expect(selection.toString()).toBe("Reading");
    expect(selection.anchorNode).toBe(bodyText);
    expect(selection.focusNode).toBe(bodyText);
    expect(markdownRender).not.toHaveBeenCalled();

    header.focus();
    const finalSummary = `${formattedSummary}\n\n[Source](https://help.obsidian.md)`;
    await workspace.setAgentSnapshot(snapshot(finalSummary));
    expect(parent.querySelector(".systemsculpt-agent-reasoning-details")).toBe(details);
    expect(parent.querySelector(".systemsculpt-agent-reasoning-header")).toBe(header);
    expect(parent.querySelector(".systemsculpt-agent-reasoning-icon")).toBe(icon);
    expect(body.firstChild).toBe(bodyText);
    expect(document.activeElement).toBe(header);
    expect(iconCalls()).toBe(initialIconCalls);
    expect(markdownRender).not.toHaveBeenCalled();

    await workspace.setAgentSnapshot(
      snapshot(finalSummary, "complete"),
    );
    expect(parent.querySelector(".systemsculpt-agent-reasoning-details")).toBe(details);
    expect(parent.querySelector(".systemsculpt-agent-reasoning-header")).toBe(header);
    expect(parent.querySelector(".systemsculpt-agent-reasoning-icon")).toBe(icon);
    expect(details.open).toBe(false);
    expect(iconCalls()).toBe(initialIconCalls + 1);
    expect(markdownRender).toHaveBeenCalledTimes(1);
    markdownRender.mockRestore();
    workspace.unload();
  });

  it("shows Thinking before the first snapshot and clears it on admission failure", async () => {
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

    workspace.setRunPending(true, "user-1");
    await workspace.setAgentSnapshot(null);

    expect(parent.querySelectorAll(".systemsculpt-agent-activity")).toHaveLength(1);
    expect(parent.querySelector(".systemsculpt-agent-activity-state")?.textContent)
      .toBe("Thinking");
    expect(parent.querySelector(".systemsculpt-agent-empty")?.hasAttribute("hidden")).toBe(true);
    expect(parent.querySelector(".systemsculpt-agent-composer")?.classList.contains("is-running"))
      .toBe(true);
    const pendingTurn = parent.querySelector(".systemsculpt-agent-turn.is-active");

    const active: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "submitted",
      statusLabel: "Starting",
      messages: [],
      parts: [],
    };
    await workspace.setAgentSnapshot(active);
    expect(parent.querySelectorAll(".systemsculpt-agent-activity")).toHaveLength(1);
    expect(parent.querySelector(".systemsculpt-agent-turn.is-active")).toBe(pendingTurn);
    expect(parent.querySelector(".systemsculpt-agent-turn")?.getAttribute("data-turn-id"))
      .toBe("user-1");

    await workspace.setAgentSnapshot(null);
    workspace.setRunPending(false);
    await workspace.setAgentSnapshot(null);
    expect(parent.querySelector(".systemsculpt-agent-active-run")?.childElementCount).toBe(0);
    expect(parent.querySelector(".systemsculpt-agent-composer")?.classList.contains("is-running"))
      .toBe(false);
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

    let snapshot: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "submitted",
      statusLabel: "Starting",
      messages: [{
        id: "assistant-stable",
        role: "assistant",
        partIds: ["text-stable"],
      }],
      parts: [{
        id: "text-stable",
        kind: "text",
        messageId: "assistant-stable",
        state: "streaming",
        markdown: "I will check that.",
        order: 0,
      }],
    };
    await workspace.setAgentSnapshot(snapshot);
    const turn = parent.querySelector(".systemsculpt-agent-turn.is-active");
    const text = turn?.querySelector(".systemsculpt-agent-part.is-text");

    snapshot = {
      ...snapshot,
      messages: [{
        id: "assistant-stable",
        role: "assistant",
        partIds: ["text-stable", "tool-stable"],
      }],
      parts: [{
        ...snapshot.parts[0],
        state: "complete",
      } as AgentPart, {
        id: "tool-stable",
        kind: "tool",
        messageId: "assistant-stable",
        callId: "call-stable",
        name: "read",
        location: "vault",
        input: undefined,
        state: "input-streaming",
        order: 1,
      }],
    };
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

    const toolParts: readonly AgentPart[] = [{
      id: "read-live-part-1",
      kind: "tool",
      messageId: "assistant-group-live",
      callId: "read-live-1",
      name: "read",
      location: "vault",
      input: { paths: ["One.md"] },
      state: "succeeded",
      output: { data: { files: [{ path: "One.md", content: "one" }] } },
      order: 0,
    }, {
      id: "read-live-part-2",
      kind: "tool",
      messageId: "assistant-group-live",
      callId: "read-live-2",
      name: "read",
      location: "vault",
      input: { paths: ["Two.md"] },
      state: "succeeded",
      output: { data: { files: [{ path: "Two.md", content: "two" }] } },
      order: 1,
    }];
    const running: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "submitted",
      statusLabel: "Starting",
      messages: [{
        id: "assistant-group-live",
        role: "assistant",
        partIds: ["read-live-part-1", "read-live-part-2"],
      }],
      parts: toolParts,
    };
    await workspace.setAgentSnapshot(running);

    expect(parent.querySelectorAll(
      ".systemsculpt-agent-active-run .systemsculpt-agent-part.is-tool",
    )).toHaveLength(2);

    await workspace.setAgentSnapshot({
      ...running,
      status: "completed",
      phase: "complete",
      statusLabel: undefined,
    });
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

    const snapshot: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "completed",
      phase: "complete",
      messages: [{
        id: "assistant-settle",
        role: "assistant",
        partIds: ["text-settle"],
      }],
      parts: [{
        id: "text-settle",
        kind: "text",
        messageId: "assistant-settle",
        state: "complete",
        markdown: "Final answer",
        order: 0,
      }],
    };
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

  it("keeps the completed response and a safe fallback when durable history rendering rejects", async () => {
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
    const user = {
      role: "user" as const,
      message_id: "user-settlement-rejection",
      content: "Finish this",
    };
    await workspace.setHistory([user]);
    await workspace.setAgentSnapshot({
      runId: "run-settlement-rejection",
      turnId: user.message_id,
      status: "completed",
      phase: "complete",
      messages: [{
        id: "assistant-settlement-rejection",
        role: "assistant",
        partIds: ["text-settlement-rejection"],
      }],
      parts: [{
        id: "text-settlement-rejection",
        kind: "text",
        messageId: "assistant-settlement-rejection",
        state: "complete",
        markdown: "Final answer",
        order: 0,
      }],
    });
    expect(parent.querySelector(".systemsculpt-agent-active-run")?.textContent)
      .toContain("Final answer");

    const renderError = new Error("Durable history rendering failed.");
    jest.spyOn(workspace.renderer, "renderHistory").mockRejectedValueOnce(renderError);

    await expect(workspace.settleCompletedRun([
      user,
      {
        role: "assistant",
        message_id: "assistant-settlement-rejection",
        content: "Final answer",
      },
    ])).rejects.toBe(renderError);

    const active = parent.querySelector(".systemsculpt-agent-active-run")!;
    expect(active.textContent).toContain("Final answer");
    expect(active.textContent).toContain(
      "The response completed, but part of this chat could not be displayed. Reopen the chat to try again.",
    );
    expect(active.textContent).not.toContain(renderError.message);
    expect(active.querySelector(".systemsculpt-agent-render-fallback")?.getAttribute("role"))
      .toBe("alert");
    expect((workspace as any).snapshot).toBeNull();
    expect((workspace as any).pendingSnapshotRender).toBeUndefined();

    await expect(workspace.settleCompletedRun([
      user,
      {
        role: "assistant",
        message_id: "assistant-settlement-rejection",
        content: "Final answer",
      },
    ])).resolves.toBeUndefined();
    expect(active.childElementCount).toBe(0);
    expect(parent.querySelector(".systemsculpt-agent-render-fallback")).toBeNull();
    expect(parent.textContent?.match(/Final answer/g)).toHaveLength(1);
    workspace.unload();
  });

  it("discards a pending stale snapshot when terminal history settles", async () => {
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
    const user = { role: "user" as const, message_id: "user-stale", content: "Finish this" };
    await workspace.setHistory([user]);

    let releaseRender: () => void = () => {};
    const renderBlocked = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let enteredRender: () => void = () => {};
    const renderEntered = new Promise<void>((resolve) => {
      enteredRender = resolve;
    });
    const originalRenderActive = workspace.renderer.renderActive.bind(workspace.renderer);
    jest.spyOn(workspace.renderer, "renderActive").mockImplementation(async (...args) => {
      enteredRender();
      await renderBlocked;
      return originalRenderActive(...args);
    });

    const snapshot: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "submitted",
      statusLabel: "Starting",
      messages: [{
        id: "assistant-stale",
        role: "assistant",
        partIds: ["text-stale"],
      }],
      parts: [{
        id: "text-stale",
        kind: "text",
        messageId: "assistant-stale",
        state: "streaming",
        markdown: "Stale live answer",
        order: 0,
      }],
    };
    const firstRender = workspace.setAgentSnapshot(snapshot);
    await renderEntered;

    const stalePendingRender = workspace.setAgentSnapshot(snapshot);
    const settlement = workspace.settleCompletedRun([
      user,
      { role: "assistant", message_id: "assistant-stale", content: "Final durable answer" },
    ]);
    releaseRender();
    await Promise.all([firstRender, stalePendingRender, settlement]);

    expect(parent.querySelector(".systemsculpt-agent-active-run")?.childElementCount).toBe(0);
    expect(parent.textContent).not.toContain("Stale live answer");
    expect(parent.textContent?.match(/Final durable answer/g)).toHaveLength(1);
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

    const snapshot: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "completed",
      phase: "complete",
      messages: [],
      parts: [],
    };
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

    const approvalTool: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-write",
      kind: "tool",
      messageId: "assistant-1",
      callId: "call-write",
      name: "write",
      location: "vault",
      input: { path: "Projects/Plan.md", content: "# Plan\n\nReady" },
      state: "approval-required",
      approvalId: "approval-write",
      order: 0,
    };
    let snapshot: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "waiting",
      phase: "waiting",
      statusLabel: "Starting",
      waitingReason: "approval",
      messages: [{
        id: "assistant-1",
        role: "assistant",
        partIds: ["tool-write"],
      }],
      parts: [approvalTool],
    };
    await workspace.setAgentSnapshot(snapshot);

    expect(parent.querySelector(".systemsculpt-agent-approval-preview .systemsculpt-diff-viewer")).not.toBeNull();
    expect(parent.textContent).toContain("Projects/Plan.md");
    expect(parent.textContent).toContain("Ready");

    snapshot = {
      ...snapshot,
      status: "running",
      phase: "working",
      waitingReason: undefined,
      parts: [{
        ...approvalTool,
        state: "succeeded",
        output: {
          summary: "Created Plan.md",
          data: { path: "Projects/Plan.md", bytes: 13 },
        },
      }],
    };
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
    const started: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "submitted",
      statusLabel: "Starting",
      messages: [],
      parts: [],
    };
    const thinking: AgentConversationSnapshot = {
      ...started,
      phase: "thinking",
      statusLabel: "Thinking",
    };
    const working: AgentConversationSnapshot = {
      ...thinking,
      phase: "working",
      statusLabel: "Working",
    };

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
    expect(parent.textContent).toContain("Thinking");
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
    const started: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "submitted",
      statusLabel: "Starting",
      messages: [],
      parts: [],
    };

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

    const reasoningPart: Extract<AgentPart, { kind: "reasoning" }> = {
      id: "reasoning-1",
      kind: "reasoning",
      messageId: "assistant-reasoning",
      state: "streaming",
      summary: "Checking the active note. ",
      order: 0,
    };
    let snapshot: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "thinking",
      statusLabel: "Thinking",
      messages: [{
        id: "assistant-reasoning",
        role: "assistant",
        partIds: ["reasoning-1"],
      }],
      parts: [reasoningPart],
    };
    await workspace.setAgentSnapshot(snapshot);

    const active = parent.querySelector<HTMLElement>(".systemsculpt-agent-active-run")!;
    let details = active.querySelector<HTMLDetailsElement>(".systemsculpt-agent-reasoning-details")!;
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("Thinking");
    expect(details.textContent).toContain("Checking the active note.");
    expect(active.querySelector(".systemsculpt-agent-part.is-status.is-thinking")).toBeNull();

    details.open = false;
    snapshot = {
      ...snapshot,
      parts: [{
        ...reasoningPart,
        summary: "Checking the active note. Planning one safe edit.",
      }],
    };
    await workspace.setAgentSnapshot(snapshot);
    details = active.querySelector<HTMLDetailsElement>(".systemsculpt-agent-reasoning-details")!;
    expect(details.open).toBe(false);

    details.open = true;
    snapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "completed",
      phase: "complete",
      messages: [{
        id: "assistant-reasoning",
        role: "assistant",
        partIds: ["reasoning-1", "text-1"],
      }],
      parts: [{
        ...reasoningPart,
        state: "complete",
        summary: "Checking the active note. Planning one safe edit.",
      }, {
        id: "text-1",
        kind: "text",
        messageId: "assistant-reasoning",
        state: "complete",
        markdown: "Done.",
        order: 1,
      }],
    };
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
    const continuing: AgentConversationSnapshot = {
      runId: "run-1",
      turnId: "user-1",
      status: "running",
      phase: "working",
      statusLabel: "Continuing",
      messages: [],
      parts: [],
    };
    await workspace.setAgentSnapshot(continuing);
    expect(parent.querySelector(".systemsculpt-agent-activity-state")?.textContent)
      .toContain("Continuing");

    const interruptedError = {
      code: "transport",
      message: "Connection lost.",
      retryable: true,
    };
    const failed: AgentConversationSnapshot = {
      ...continuing,
      status: "failed",
      phase: "complete",
      statusLabel: undefined,
      terminalError: interruptedError,
      parts: [{
        id: "error:user-1",
        kind: "error",
        error: interruptedError,
        retryable: true,
        retryMessageId: "user-1",
        order: 0,
      }],
    };

    await workspace.setAgentSnapshot(failed);

    expect(parent.textContent).toContain("Retry this message to continue.");
    expect(parent.textContent).not.toMatch(/connection/i);
    expect(parent.querySelector(".systemsculpt-agent-part.is-status")).toBeNull();
    parent.querySelector<HTMLButtonElement>(".systemsculpt-agent-error-retry")!.click();
    expect(onRetryMessage).toHaveBeenCalledWith("user-1");
    workspace.unload();
  });

  it("shows an exact tool and terminal failure only once while retaining the failed activity row", async () => {
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
      onNewChat: jest.fn(),
      onOpenHistory: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    workspace.load();

    const repeatedError = {
      code: "TOOL_EXECUTION_FAILED",
      message: "Could not update Plan.md.",
    };
    const failedTool: Extract<AgentPart, { kind: "tool" }> = {
      id: "tool-failed-once",
      kind: "tool",
      messageId: "assistant-failed-once",
      callId: "call-failed-once",
      name: "write",
      location: "vault",
      input: { path: "Plan.md" },
      state: "failed",
      error: repeatedError,
      order: 0,
    };
    const running: AgentConversationSnapshot = {
      runId: "run-failed-once",
      turnId: "user-failed-once",
      status: "running",
      phase: "working",
      messages: [{
        id: "assistant-failed-once",
        role: "assistant",
        partIds: [failedTool.id],
      }],
      parts: [failedTool],
    };
    await workspace.setAgentSnapshot(running);

    const toolNode = parent.querySelector<HTMLElement>(".systemsculpt-agent-part.is-tool")!;
    expect(toolNode.querySelector(".systemsculpt-agent-tool-error")?.textContent)
      .toBe(repeatedError.message);

    await workspace.setAgentSnapshot({
      ...running,
      status: "failed",
      phase: "complete",
      terminalError: {
        ...repeatedError,
        status: 503,
        requestId: "req-terminal-only",
        retryable: true,
      },
      parts: [
        failedTool,
        {
          id: "error:user-failed-once",
          kind: "error",
          error: {
            ...repeatedError,
            status: 503,
            requestId: "req-terminal-only",
            retryable: true,
          },
          retryable: true,
          retryMessageId: "user-failed-once",
          order: 1,
        },
      ],
    });

    expect(parent.querySelector(".systemsculpt-agent-part.is-tool")).toBe(toolNode);
    expect(toolNode.querySelector(".systemsculpt-agent-tool-state")?.textContent).toBe("Failed");
    expect(toolNode.querySelector(".systemsculpt-agent-tool-error")).toBeNull();
    expect(parent.querySelectorAll(".systemsculpt-agent-part.is-error")).toHaveLength(1);
    expect(parent.textContent?.match(/Could not update Plan\.md\./g)).toHaveLength(1);
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
    const savedHistory: ChatMessage[] = [{
      role: "assistant",
      content: "Updated the project note.",
      message_id: "assistant-1",
      tool_calls: [writeCall],
      messageParts: [
        { id: "write-part", type: "tool_call", timestamp: 1, data: writeCall },
        { id: "content-part", type: "content", timestamp: 2, data: "Updated the project note." },
      ],
    }];
    await workspace.setHistory(reloadSavedMessages(savedHistory));

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
    const nativeMessages: UIMessage[] = [{
      id: "user-partial",
      role: "user",
      parts: [{ type: "text", text: "Edit both notes." }],
    }, {
      id: "assistant-partial",
      role: "assistant",
      parts: [{
        type: "tool-multi_edit",
        toolCallId: "call-partial",
        state: "output-available",
        input: { files: [{ path: "Changed.md" }, { path: "Failed.md" }] },
        output: {
          success: false,
          data: {
            results: [
              { path: "Changed.md", success: true },
              { path: "Failed.md", success: false, error: "Conflict" },
            ],
          },
          error: { code: "TOOL_PARTIAL_FAILURE", message: "One file changed; one conflicted." },
        },
      }, {
        type: "text",
        text: "One file changed; one conflicted.",
        state: "done",
      }],
    }];
    const projected = projectThinAgentChat({
      runId: "run-partial",
      turnId: "user-partial",
      statusPhase: "working",
      statusLabel: "Working",
      terminalOutcome: { kind: "completed" },
      chat: { messages: nativeMessages },
      executingToolIds: new Set(),
    });
    await workspace.setAgentSnapshot(projected);
    expect(parent.querySelectorAll(".systemsculpt-agent-artifact")).toHaveLength(1);
    expect(parent.textContent).toContain("Changed.md");
    expect(parent.textContent).not.toContain("Failed.md");

    const savedHistory = [durableAssistant(projected, nativeMessages, 100)];
    await workspace.setAgentSnapshot(null);
    await workspace.setHistory(reloadSavedMessages(savedHistory));

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
