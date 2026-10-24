/** @jest-environment jsdom */

import { App, Menu, TFile } from "obsidian";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { AgentWorkspace } from "../AgentWorkspace";

function key(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function type(input: HTMLTextAreaElement, text: string): void {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const settle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

function pending(id: string, order: number): AgentToolPart {
  return {
    id: `tool-${id}`, callId: `call-${id}`, messageId: "assistant", kind: "tool", order,
    name: "edit", location: "vault", input: { path: `${id}.md` },
    state: "approval-required", approvalId: id,
  };
}

describe("ChatView keyboard map (spec 6.1, composed R2/R4/R5 surfaces)", () => {
  let workspace: AgentWorkspace;
  let input: HTMLTextAreaElement;
  let onSubmit: jest.Mock;
  let onStop: jest.Mock;
  let onApprove: jest.Mock;
  const query = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const element = workspace.element.querySelector<T>(selector);
    if (!element) throw new Error(`Missing keyboard target: ${selector}`);
    return element;
  };
  const card = (id: string) => query(`.systemsculpt-agent-approval[data-approval-id="${id}"]`);
  const primary = (id: string) => card(id).querySelector('[data-focus-key="tool-allow-once"]');
  const showCards = async (parts = [pending("one", 0), pending("two", 1), pending("three", 2)]) => {
    await workspace.setAgentSnapshot({
      runId: "run", turnId: "user", status: "waiting", phase: "waiting", waitingReason: "approval",
      messages: [{ id: "assistant", role: "assistant", partIds: parts.map((part) => part.id) }], parts,
    });
  };

  beforeEach(() => {
    const app = new App();
    (app.vault.getFiles as jest.Mock).mockReturnValue([new TFile({ path: "Plan.md" })]);
    onSubmit = jest.fn();
    onStop = jest.fn();
    onApprove = jest.fn(() => true);
    workspace = new AgentWorkspace(document.body.createDiv(), {
      app, sourcePath: () => "", reducedMotion: () => true,
      onSubmit, onStop, onApprove,
      onAttach: jest.fn(), onRemoveAttachment: jest.fn(), onOpenArtifact: jest.fn(),
      onCopyArtifactPath: jest.fn(), onNewChat: jest.fn(), onOpenHistory: jest.fn(),
      history: {
        loadRows: async () => [{
          chatId: "saved", title: "Saved chat", chatPath: "Chats/saved.md",
          timestampMs: Date.now(), backend: "systemsculpt", favorite: false,
        }],
        loadSearchText: async () => "", isCurrent: () => true, isRunning: () => false,
        onOpen: jest.fn(), onNewChat: jest.fn(), onClose: () => workspace.hideHistory(),
        onToggleFavorite: async () => undefined, onRename: async () => undefined,
        onDelete: async () => false,
      },
    });
    workspace.load();
    input = query<HTMLTextAreaElement>('[data-testid="chat.composer.input"]');
    workspace.focus();
  });

  afterEach(async () => {
    workspace.unload();
    await settle();
    document.body.empty();
    (Menu as unknown as { instances: Menu[] }).instances.length = 0;
    jest.restoreAllMocks();
  });

  it("Send — Enter sends one desktop message and keeps composer focus", async () => {
    type(input, "Summarize the plan");
    expect(key(input, { key: "Enter" }).defaultPrevented).toBe(true);
    await settle();
    expect(onSubmit.mock.calls).toEqual([[{ text: "Summarize the plan", mode: "send" }]]);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("Newline — Shift+Enter leaves native textarea editing alone and never submits", async () => {
    type(input, "Line one");
    expect(key(input, { key: "Enter", shiftKey: true }).defaultPrevented).toBe(false);
    // jsdom does not perform the browser's default newline insertion.
    type(input, "Line one\nLine two");
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
    key(input, { key: "Enter" });
    await settle();
    expect(onSubmit).toHaveBeenCalledWith({ text: "Line one\nLine two", mode: "send" });
  });

  it("Queue follow-up — Enter queues rather than sending or stopping while running", async () => {
    workspace.composer.setRunning(true);
    type(input, "Then check the links");
    expect(key(input, { key: "Enter" }).defaultPrevented).toBe(true);
    await settle();
    expect(onSubmit.mock.calls).toEqual([[{ text: "Then check the links", mode: "queue" }]]);
    expect(onStop).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("Stop response — Escape closes the mention popover first, then stops the run", () => {
    workspace.composer.setRunning(true);
    type(input, "Read @Pl");
    const popover = query('[data-testid="chat.composer.mention"]');
    expect(popover.hidden).toBe(false);
    expect(key(input, { key: "Escape" }).defaultPrevented).toBe(true);
    expect(popover.hidden).toBe(true);
    expect(onStop).not.toHaveBeenCalled();
    expect(input.value).toBe("Read @Pl");
    expect(document.activeElement).toBe(input);
    expect(key(input, { key: "Escape" }).defaultPrevented).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
  });

  it("Menus — an Escape consumed by the host menu cannot also stop the run", () => {
    workspace.composer.setRunning(true);
    // Obsidian owns Menu's key scope. Model its consumed Escape, not Menu's implementation.
    const dismissMenu = (event: KeyboardEvent) => event.preventDefault();
    workspace.element.addEventListener("keydown", dismissMenu, { capture: true, once: true });
    expect(key(input, { key: "Escape" }).defaultPrevented).toBe(true);
    expect(onStop).not.toHaveBeenCalled();
    key(input, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("Recall previous / next prompt — arrows recall only at the empty/start/end boundary", () => {
    workspace.composer.setPromptHistory([
      { role: "user", content: "First", message_id: "first" },
      { role: "user", content: "Second", message_id: "second" },
    ]);
    key(input, { key: "ArrowUp" });
    expect(input.value).toBe("Second");
    key(input, { key: "ArrowUp" });
    expect(input.value).toBe("First");
    input.setSelectionRange(input.value.length, input.value.length);
    key(input, { key: "ArrowDown" });
    expect(input.value).toBe("Second");
    key(input, { key: "ArrowDown" });
    expect(input.value).toBe("");
    type(input, "My unsent draft");
    expect(key(input, { key: "ArrowUp" }).defaultPrevented).toBe(false);
    expect(input.value).toBe("My unsent draft");
  });

  it.each(["@", "[["])("Mention a note — %s opens suggestions without sending", (trigger) => {
    type(input, `Read ${trigger}Pl`);
    expect(query('[data-testid="chat.composer.mention"]').hidden).toBe(false);
    expect(input.getAttribute("role")).toBe("combobox");
    expect(query('[role="option"]').textContent).toContain("Plan");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["metaKey", "ctrlKey"] as const)("Approve — %s+Enter overrides Deny focus without submitting the draft", async (modifier) => {
    type(input, "Keep this draft");
    await showCards();
    const deny = card("one").querySelector<HTMLButtonElement>('[data-focus-key="tool-deny"]')!;
    deny.focus();
    key(deny, { key: "Enter", [modifier]: true });
    await settle();
    expect(onApprove.mock.calls).toEqual([["one", true]]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe("Keep this draft");
    expect(document.activeElement).toBe(primary("two"));
  });

  it("Deny — Escape denies only the focused card, not the running response", async () => {
    await showCards();
    card("one").focus();
    key(card("one"), { key: "Escape" });
    await settle();
    expect(onApprove.mock.calls).toEqual([["one", false]]);
    expect(onStop).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(primary("two"));
  });

  it.each(["metaKey", "ctrlKey"] as const)("Approve all in this chat — %s+Shift+Enter grants the focused request's session scope once", async (modifier) => {
    await showCards();
    card("one").focus();
    key(card("one"), { key: "Enter", shiftKey: true, [modifier]: true });
    key(card("one"), { key: "Enter", shiftKey: true, [modifier]: true, repeat: true });
    await settle();
    // This forwards the native/hosted session grant; it must not batch-answer other pending requests.
    expect(onApprove.mock.calls).toEqual([["one", true, true]]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(primary("two"));
  });

  it("Previous / next pending card — arrows wrap in order and skip an answered card", async () => {
    await showCards();
    card("one").focus();
    key(card("one"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(primary("three"));
    key(card("three"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(primary("one"));
    key(card("one"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(primary("two"));
    key(card("two"), { key: "Enter" });
    await settle();
    key(card("three"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(primary("one"));
    expect(onApprove.mock.calls).toEqual([["two", true]]);
  });

  it.each(["ArrowUp", "ArrowDown"])("Go to pending card — Alt+%s reviews from the composer or header, but never outside the view", async (arrow) => {
    type(input, "Keep typing");
    expect(key(input, { key: arrow, altKey: true }).defaultPrevented).toBe(false);
    await showCards();
    expect(document.activeElement).toBe(input);
    expect(query('[data-testid="chat.approval.review"]').hidden).toBe(false);
    expect(key(input, { key: arrow, altKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(primary("one"));
    expect(input.value).toBe("Keep typing");
    const header = query('[data-testid="chat.header.more"]');
    header.focus();
    expect(key(header, { key: arrow, altKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(primary("one"));
    card("three").focus();
    expect(key(card("three"), { key: arrow, altKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(primary("one"));
    const outside = document.body.createEl("textarea");
    outside.focus();
    expect(key(outside, { key: arrow, altKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it.each([
    ["ArrowUp", "history.search"], ["ArrowDown", "history.search"],
    ["ArrowUp", "history.close"], ["ArrowDown", "history.close"],
  ])("Go to pending card — Alt+%s closes history from %s before focusing the card", async (arrow, testId) => {
    type(input, "Keep this draft");
    await showCards();
    workspace.showHistory();
    await settle();
    const target = query(`[data-testid="${testId}"]`);
    target.focus();
    expect(workspace.isHistoryOpen).toBe(true);
    expect(key(target, { key: arrow, altKey: true }).defaultPrevented).toBe(true);
    expect(workspace.isHistoryOpen).toBe(false);
    expect(workspace.element.classList.contains("is-history-open")).toBe(false);
    expect(document.activeElement).toBe(primary("one"));
    expect(input.value).toBe("Keep this draft");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it.each(["ArrowUp", "ArrowDown"])("Go to pending card — Alt+%s reviews from a history row's rename field", async (arrow) => {
    type(input, "Keep this draft");
    await showCards();
    workspace.showHistory();
    await settle();
    key(query('[data-testid="history.search"]'), { key: "F10", shiftKey: true });
    const menus = (Menu as unknown as { instances: Array<Menu & { select: (title: string) => void }> }).instances;
    menus.at(-1)!.select("Rename");
    const rename = query<HTMLInputElement>('[data-testid="history.row.rename"]');
    // Let the row's native animation-frame focus restoration finish first.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(document.activeElement).toBe(rename);
    expect(key(rename, { key: arrow, altKey: true }).defaultPrevented).toBe(true);
    await settle();
    expect(workspace.isHistoryOpen).toBe(false);
    expect(document.activeElement).toBe(primary("one"));
    expect(input.value).toBe("Keep this draft");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("Go to pending card — history stays open until an explicit review of a pending card", async () => {
    type(input, "Keep this draft");
    workspace.showHistory();
    await settle();
    const search = query('[data-testid="history.search"]');
    for (const arrow of ["ArrowUp", "ArrowDown"]) {
      expect(key(search, { key: arrow, altKey: true }).defaultPrevented).toBe(false);
      expect(workspace.isHistoryOpen).toBe(true);
      expect(document.activeElement).toBe(search);
    }
    await showCards();
    expect(workspace.isHistoryOpen).toBe(true);
    expect(document.activeElement).toBe(search);
    for (const init of [{ isComposing: true }, { repeat: true }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(key(search, { key: "ArrowUp", altKey: true, ...init }).defaultPrevented).toBe(false);
      expect(workspace.isHistoryOpen).toBe(true);
      expect(document.activeElement).toBe(search);
    }
    search.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    key(search, { key: "ArrowUp", altKey: true });
    expect(workspace.isHistoryOpen).toBe(true);
    expect(document.activeElement).toBe(search);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("Go to pending card — leaves composing, held, modified and already-consumed keys alone", async () => {
    type(input, "未送信");
    await showCards();
    for (const init of [{ isComposing: true }, { repeat: true }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(key(input, { key: "ArrowUp", altKey: true, ...init }).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(input);
    }
    input.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    key(input, { key: "ArrowUp", altKey: true });
    expect(document.activeElement).toBe(input);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it.each(["number", "typed", "skip"])("Answer a question — %s uses the card without sending a chat message", async (answer) => {
    await showCards([{
      ...pending("question", 0), name: "request_user_input",
      native: { agent: "codex", workingDirectory: "/vault" },
      input: { questions: [{ id: "folder", question: "Which folder?", options: [{ label: "Notes" }, { label: "Inbox" }] }] },
    }]);
    const question = card("question");
    question.focus();
    if (answer === "typed") {
      const field = question.querySelector("input")!;
      field.focus();
      field.value = "Projects";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      key(field, { key: "Enter" });
    } else {
      key(question, { key: answer === "number" ? "2" : "Escape" });
    }
    await settle();
    expect(onApprove.mock.calls).toEqual([[
      "question", answer !== "skip", false,
      answer === "skip" ? {} : { folder: [answer === "number" ? "Inbox" : "Projects"] },
    ]]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("Expand / collapse a tool line — %s leaves native disclosure activation intact", async (name) => {
    await showCards([{
      ...pending("read", 0), name: "read", input: { paths: ["Plan.md"] },
      state: "succeeded", approvalId: undefined,
    }]);
    const summary = query(".systemsculpt-agent-tool-header");
    const details = summary.parentElement as HTMLDetailsElement;
    expect(summary.tagName).toBe("SUMMARY");
    summary.focus();
    expect(key(summary, { key: name }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(summary);
    // jsdom has no default keyboard activation; click exercises the native disclosure.
    const wasOpen = details.open;
    summary.click();
    expect(details.open).toBe(!wasOpen);
    summary.click();
    expect(details.open).toBe(wasOpen);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it.each(["x", "Escape"])("Back to the composer — %s from the conversation preserves the draft", (name) => {
    type(input, "Draft");
    const viewport = query(".systemsculpt-agent-viewport");
    viewport.focus();
    expect(key(viewport, { key: name }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(name === "x" ? "Draftx" : "Draft");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([false, true])("Move through the view — Tab (shift=%s) is never captured", async (shiftKey) => {
    await showCards();
    for (const target of [query('[data-testid="chat.header.more"]'), card("one"), input, query('[data-testid="chat.composer.add"]')]) {
      target.focus();
      expect(key(target, { key: "Tab", shiftKey }).defaultPrevented).toBe(false);
    }
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it.each([false, true])("IME — composing Enter never sends or queues (running=%s)", async (running) => {
    workspace.composer.setRunning(running);
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type(input, "日本語で計画を書く");
    expect(key(input, { key: "Enter", isComposing: true }).defaultPrevented).toBe(false);
    await settle();
    expect(input.value).toBe("日本語で計画を書く");
    expect(onSubmit).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    key(input, { key: "Enter" });
    await settle();
    expect(onSubmit.mock.calls).toEqual([[{ text: "日本語で計画を書く", mode: running ? "queue" : "send" }]]);
  });

  it("IME — composing Enter does not accept a mention, mutate the draft or steal candidate keys", async () => {
    type(input, "日本語 @Pl");
    const popover = query('[data-testid="chat.composer.mention"]');
    const option = query('[role="option"]');
    expect(popover.hidden).toBe(false);
    for (const name of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
      expect(key(input, { key: name, isComposing: true }).defaultPrevented).toBe(false);
    }
    await settle();
    expect(popover.hidden).toBe(false);
    expect(input.value).toBe("日本語 @Pl");
    expect(query('[role="option"]')).toBe(option);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(workspace.getMessageAttachments()).toEqual([]);
  });
});
