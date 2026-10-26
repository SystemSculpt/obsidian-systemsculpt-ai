/** @jest-environment jsdom */
import { AgentApprovalCards } from "../AgentApprovalCards";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { claudePermissionResponse } from "../../../services/claude/LocalClaudeClient";

function tool(id: string, extra: Partial<AgentToolPart> = {}): AgentToolPart {
  return { id, callId: id, messageId: "m", order: 1, kind: "tool", name: "Edit", location: "vault", input: { file_path: "/vault/Notes/Plan.md", old_string: "Draft", new_string: "Ready" }, state: "approval-required", approvalId: id, native: { agent: "claude", workingDirectory: "/vault" }, ...extra };
}

function setup(owner = document, onApprove = jest.fn((): boolean => true), isVisible = () => true) {
  const host = owner.body.createDiv();
  const root = host.createDiv();
  const composer = host.createDiv();
  const input = composer.createEl("textarea");
  const onHiddenApproval = jest.fn();
  const cards = new AgentApprovalCards(root, { composer: () => composer, onApprove, isVisible, onHiddenApproval });
  cards.load();
  const add = (part: AgentToolPart) => {
    const card = cards.create(part, part.name.toLowerCase());
    root.appendChild(card);
    return card;
  };
  return { root, composer, input, cards, add, onApprove, onHiddenApproval, dispose: () => { cards.unload(); host.remove(); } };
}

function primary(card: HTMLElement): HTMLElement {
  return card.querySelector<HTMLElement>('[data-option-number="1"], [data-testid="chat.approval.answer"], [data-focus-key="tool-allow-once"]')!;
}

function key(target: HTMLElement, name: string, options: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options }));
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

afterEach(() => { document.body.empty(); });

describe("inline approval keyboard ownership", () => {
  it("focuses a new card, labels it and announces the proposed action", () => {
    const ui = setup();
    const part = tool("one");
    const card = ui.add(part);
    ui.cards.sync([part]);
    expect(document.activeElement).toBe(primary(card));
    expect(card.getAttribute("role")).toBe("group");
    expect(document.getElementById(card.getAttribute("aria-labelledby")!)?.textContent).toBe("Claude Code wants to edit Plan.md");
    expect(document.getElementById(card.getAttribute("aria-describedby")!)?.textContent).toBe("Notes");
    expect(ui.root.querySelector('[role="status"]')?.textContent).toBe("Claude Code wants to edit Plan.md. Enter to approve, Escape to deny.");
    expect(card.querySelector('[data-focus-key="tool-allow-once"]')?.getAttribute("aria-keyshortcuts")).toContain("Enter");
    ui.dispose();
  });

  // Spec 3.5 / product review item 1: the basename titles the card, the folder is the meta line.
  it.each([
    ["/tmp/vault/Notes/Plan.md", "Plan.md", "Notes"],
    ["/private/tmp/vault/Notes/Plan.md", "Plan.md", "Notes"],
    ["/external/Notes/Plan.md", "Plan.md (outside vault)", "/external/Notes"],
  ])("presents %s consistently without changing the request or approval answer", async (file_path, displayed, folder) => {
    const ui = setup();
    try {
      const part = tool("one", { location: "server", input: { file_path, old_string: "Draft", new_string: "Ready" },
        native: { agent: "claude", workingDirectory: "/private/tmp/vault", vaultRoot: "/private/tmp/vault", vaultRootAlias: "/tmp/vault" } });
      const original = JSON.stringify(part);
      const card = ui.add(part);
      ui.cards.sync([part]);
      const title = `Claude Code wants to edit ${displayed}`;
      expect(card.querySelector(".systemsculpt-agent-approval-copy")?.textContent).toBe(title);
      expect(ui.root.querySelector('[role="status"]')?.textContent).toBe(`${title}. Enter to approve, Escape to deny.`);
      expect(document.getElementById(card.getAttribute("aria-describedby")!)?.textContent).toBe(folder);
      expect(card.querySelector("details pre")?.textContent).toBe(JSON.stringify(part.input, null, 2));
      expect(JSON.stringify(part)).toBe(original);
      expect(ui.onApprove).not.toHaveBeenCalled();
      key(card, "Enter");
      await tick();
      expect(ui.onApprove.mock.calls).toEqual([["one", true]]);
    } finally { ui.dispose(); }
  });

  it("never steals composer focus, and Alt+Up reviews the pending card", () => {
    const ui = setup();
    ui.input.value = "Still typing";
    ui.input.focus();
    const part = tool("one");
    const card = ui.add(part);
    ui.cards.sync([part]);
    expect(document.activeElement).toBe(ui.input);
    expect(ui.composer.querySelector('[data-testid="chat.approval.review"]')?.hasAttribute("hidden")).toBe(false);
    key(ui.input, "ArrowDown", { altKey: true });
    expect(document.activeElement).toBe(primary(card));
    ui.input.focus();
    key(ui.input, "ArrowUp", { altKey: true });
    expect(document.activeElement).toBe(primary(card));
    expect(ui.input.value).toBe("Still typing");
    ui.dispose();
  });

  it("shows the review pill only while the person types, and leaves Alt+Up alone with nothing pending", () => {
    const ui = setup();
    const pill = () => ui.composer.querySelector<HTMLButtonElement>('[data-testid="chat.approval.review"]');
    ui.input.focus();
    const idle = new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true });
    ui.input.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    // An empty composer gives focus to the card's Approve (spec 6.2 (3)); no pill is needed.
    const part = tool("one");
    const card = ui.add(part);
    ui.cards.sync([part]);
    expect(document.activeElement).toBe(card.querySelector('[data-focus-key="tool-allow-once"]'));
    expect(pill()?.hidden).toBe(true);
    expect(pill()?.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
    expect(pill()?.querySelector("kbd")?.getAttribute("aria-hidden")).toBe("true");

    // Back in the composer, typing brings the pill; clearing the text hides it.
    ui.input.focus();
    expect(pill()?.hidden).toBe(true);
    ui.input.value = "One more thing";
    ui.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(pill()?.hidden).toBe(false);
    ui.input.value = "";
    ui.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(pill()?.hidden).toBe(true);
    ui.input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(pill()?.hidden).toBe(false);
    ui.input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    // Focus elsewhere in Obsidian: the pill waits for the person's return.
    const editor = document.body.createEl("textarea");
    editor.focus();
    ui.cards.sync([part]);
    expect(pill()?.hidden).toBe(false);

    ui.cards.sync([]);
    expect(pill()?.hidden).toBe(true);
    ui.dispose();
  });

  it("focuses a card from an empty composer but not during composition or outside the view", () => {
    const ui = setup();
    ui.input.focus();
    ui.input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const first = tool("one"), card = ui.add(first);
    ui.cards.sync([first]);
    expect(document.activeElement).toBe(ui.input);
    ui.input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    const second = tool("two"); ui.add(second);
    ui.cards.sync([first, second]);
    expect(document.activeElement).toBe(primary(card));
    const outside = document.body.createEl("button"); outside.focus();
    const third = tool("three"); ui.add(third); ui.cards.sync([first, second, third]);
    expect(document.activeElement).toBe(outside);
    ui.dispose();
  });

  it("answers the middle card then focuses below it before returning to older requests", async () => {
    const ui = setup();
    const parts = [tool("one"), tool("two"), tool("three")];
    const [one, two, three] = parts.map(ui.add);
    ui.cards.sync(parts);
    two.focus(); key(two, "Enter"); await tick();
    expect(document.activeElement).toBe(primary(three));
    key(three, "Escape"); await tick();
    expect(document.activeElement).toBe(primary(one));
    ui.dispose();
  });

  it("restores the next pending card after timeline regrouping reparents it", async () => {
    const ui = setup();
    const parts = [tool("one"), tool("two")];
    const [one, two] = parts.map(ui.add);
    ui.cards.sync(parts);
    key(one, "Enter"); await tick();
    expect(document.activeElement).toBe(primary(two));
    const focused = ui.cards.captureFocus();
    const group = ui.root.createDiv();
    group.appendChild(two);
    expect(document.activeElement).toBe(document.body);
    ui.cards.sync([parts[1]], focused);
    expect(document.activeElement).toBe(primary(two));
    const outside = document.body.createEl("button"); outside.focus();
    ui.cards.sync([parts[1]], focused);
    expect(document.activeElement).toBe(outside);
    ui.dispose();
  });

  it("sends a single question option by its numbered shortcut without treating input digits as actions", async () => {
    const ui = setup();
    const part = tool("question", { native: { agent: "codex", workingDirectory: "/vault" }, input: { questions: [{ id: "folder", question: "Which folder?", options: [{ label: "Notes" }, { label: "Inbox" }] }] } });
    const card = ui.add(part); ui.cards.sync([part]);
    const input = card.querySelector("input")!; input.focus(); key(input, "1");
    expect(ui.onApprove).not.toHaveBeenCalled();
    expect(card.querySelector('[data-focus-key="tool-allow-chat"]')).toBeNull();
    card.focus(); key(card, "2"); await tick();
    expect(ui.onApprove).toHaveBeenCalledWith("question", true, false, { folder: ["Inbox"] });
    ui.dispose();
  });

  it.each(['choice', 'typed'])('answers a Claude single question by %s with its original question key', async method => {
    const ui = setup();
    const questions = [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Blue" }, { label: "Green" }] }];
    const part = tool("question", { name: "AskUserQuestion", input: { questions } });
    const card = ui.add(part); ui.cards.sync([part]);
    if (method === 'choice') {
      key(primary(card), "2");
    } else {
      const input = card.querySelector("input")!;
      input.focus();
      input.value = "A shade of turquoise";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      key(input, "Enter", { isComposing: true });
      expect(ui.onApprove).not.toHaveBeenCalled();
      key(input, "Enter");
    }
    await tick();
    const answer = method === 'choice' ? 'Green' : 'A shade of turquoise';
    const answers = { 'Which color?': [answer] };
    expect(ui.onApprove.mock.calls).toEqual([["question", true, false, answers]]);
    expect(claudePermissionResponse({ toolName: "AskUserQuestion", description: "", input: { questions } }, { approved: true, answers })).toEqual({
      behavior: "allow", updatedInput: { questions, answers: { "Which color?": answer } },
    });
    expect(document.activeElement).toBe(ui.input);
    ui.dispose();
  });

  it("uses Claude question text as the native answer key and preserves multiple selections", async () => {
    const ui = setup();
    const questions = [{ question: "Which sections?", header: "Sections", multiSelect: true, options: [{ label: "Summary" }, { label: "Tasks" }] }];
    const part = tool("question", { name: "AskUserQuestion", input: { questions } });
    const card = ui.add(part); ui.cards.sync([part]);
    expect(card.querySelector("legend")?.textContent).toBe("Which sections?");
    expect(card.querySelector('[data-focus-key="tool-allow-chat"]')).toBeNull();
    key(card, "1"); key(card, "2");
    expect(ui.onApprove).not.toHaveBeenCalled();
    key(card, "1"); key(card, "1");
    key(card, "Enter"); await tick();
    const answers = { "Which sections?": ["Tasks", "Summary"] };
    expect(ui.onApprove).toHaveBeenCalledWith("question", true, false, answers);
    expect(claudePermissionResponse({ toolName: "AskUserQuestion", description: "", input: { questions } }, { approved: true, answers })).toEqual({
      behavior: "allow", updatedInput: { questions, answers: { "Which sections?": "Tasks, Summary" } },
    });
    ui.dispose();
  });

  it("arrows navigate pending cards; Enter, Escape and session shortcut send exactly one answer", async () => {
    const ui = setup();
    const parts = [tool("one"), tool("two"), tool("three")];
    const [one, two, three] = parts.map(ui.add);
    ui.cards.sync(parts);
    key(one, "ArrowDown");
    expect(document.activeElement).toBe(primary(two));
    key(two, "ArrowUp");
    expect(document.activeElement).toBe(primary(one));
    key(one, "Enter");
    key(one, "Enter");
    await tick();
    expect(ui.onApprove.mock.calls).toEqual([["one", true]]);
    expect(document.activeElement).toBe(primary(two));
    key(two, "Escape");
    await tick();
    expect(ui.onApprove).toHaveBeenLastCalledWith("two", false);
    expect(document.activeElement).toBe(primary(three));
    key(three, "Enter", { ctrlKey: true, shiftKey: true });
    await tick();
    expect(ui.onApprove).toHaveBeenLastCalledWith("three", true, true);
    expect(document.activeElement).toBe(ui.input);
    ui.dispose();
  });

  it("supports Cmd+Enter and does not reinterpret Enter on Deny or Details", async () => {
    const ui = setup();
    const part = tool("one");
    const card = ui.add(part);
    ui.cards.sync([part]);
    const deny = card.querySelector<HTMLButtonElement>('[data-focus-key="tool-deny"]')!;
    key(deny, "Enter");
    key(card.querySelector("summary")!, "Enter");
    expect(ui.onApprove).not.toHaveBeenCalled();
    key(card, "Enter", { metaKey: true });
    await tick();
    expect(ui.onApprove).toHaveBeenCalledWith("one", true);
    ui.dispose();
  });

  it("ignores repeats and IME composition, and leaves arrow keys inside answer fields", () => {
    const ui = setup();
    const part = tool("one", { native: { agent: "codex", workingDirectory: "/vault" }, input: { questions: [{ id: "q", question: "Which heading?", options: [] }] } });
    const card = ui.add(part);
    ui.cards.sync([part]);
    key(card, "Enter", { repeat: true });
    key(card, "Enter", { isComposing: true });
    expect(ui.onApprove).not.toHaveBeenCalled();
    const input = card.querySelector("input")!;
    input.focus();
    key(input, "ArrowDown");
    expect(document.activeElement).toBe(input);
    ui.dispose();
  });

  it("withdraws a focused card and refuses stale handlers", async () => {
    const ui = setup();
    const one = tool("one"), two = tool("two");
    const card = ui.add(one), next = ui.add(two);
    ui.cards.sync([one, two]);
    const focused = ui.cards.captureFocus();
    card.remove();
    ui.cards.sync([{ ...one, state: "cancelled", approvalDecision: "withdrawn" }, two], focused);
    expect(document.activeElement).toBe(primary(next));
    card.querySelector<HTMLButtonElement>('[data-focus-key="tool-allow-once"]')!.click();
    await tick();
    expect(ui.onApprove).not.toHaveBeenCalled();
    next.remove();
    ui.cards.sync([], "two");
    expect(document.activeElement).toBe(ui.input);
    ui.dispose();
  });

  it("does not move focus from a card already under review when another arrives", () => {
    const ui = setup();
    const one = tool("one"), two = tool("two");
    const card = ui.add(one);
    ui.cards.sync([one]);
    ui.add(two);
    ui.cards.sync([one, two]);
    expect(document.activeElement).toBe(primary(card));
    ui.dispose();
  });

  it("announces a hidden request once without focusing the background chat", () => {
    const ui = setup(document, jest.fn(() => true), () => false);
    const part = tool("one");
    const card = ui.add(part);
    ui.cards.sync([part]);
    ui.cards.sync([part]);
    expect(ui.onHiddenApproval).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(primary(card));
    ui.dispose();
  });

  it("uses its pop-out document, never a focused composer in the other window", () => {
    const otherInput = document.body.createEl("textarea");
    otherInput.focus();
    const owner = document.implementation.createHTMLDocument("Chat pop-out");
    const ui = setup(owner);
    const part = tool("one"), card = ui.add(part);
    const ownFocus = jest.spyOn(primary(card), "focus");
    ui.cards.sync([part]);
    expect(card.ownerDocument).toBe(owner);
    expect(ownFocus).toHaveBeenCalled();
    expect(document.activeElement).toBe(otherInput);
    expect(ui.composer.querySelector("button")?.ownerDocument).toBe(owner);
    ui.dispose();
  });

  it("keeps Review and composition listeners with an existing chat moved to another document", () => {
    const ui = setup();
    const part = tool("one"), card = ui.add(part);
    ui.cards.sync([part]);
    const owner = document.implementation.createHTMLDocument("Moved chat");
    owner.body.appendChild(ui.root.parentElement!);
    expect(ui.input.ownerDocument).toBe(owner);
    const focus = jest.spyOn(primary(card), "focus");
    key(ui.input, "ArrowUp", { altKey: true });
    expect(focus).toHaveBeenCalledTimes(1);
    key(ui.input, "ArrowUp", { altKey: true, isComposing: true });
    key(ui.input, "ArrowUp", { altKey: true, repeat: true });
    expect(focus).toHaveBeenCalledTimes(1);
    const active = jest.spyOn(owner, "activeElement", "get").mockReturnValue(ui.input);
    ui.input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const second = tool("two"); ui.add(second); ui.cards.sync([part, second]);
    expect(focus).toHaveBeenCalledTimes(1);
    ui.input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    const third = tool("three"); ui.add(third); ui.cards.sync([part, second, third]);
    expect(focus).toHaveBeenCalledTimes(2);
    active.mockRestore();
    ui.dispose();
  });

  it("sends question options and typed answers through the same inline action", async () => {
    const ui = setup();
    const part = tool("question", { name: "requestUserInput", native: { agent: "codex", workingDirectory: "/vault" }, input: { questions: [
      { id: "format", header: "Format", question: "Which format?", options: [{ label: "Bullets", description: "An easy-to-scan list" }] },
      { id: "title", header: "Title", question: "What title?", options: [] },
    ] } });
    const card = ui.add(part);
    ui.cards.sync([part]);
    card.querySelector<HTMLButtonElement>('.systemsculpt-agent-approval-options button')!.click();
    const inputs = card.querySelectorAll("input");
    inputs[1].value = "Plan";
    inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    key(inputs[1], "Enter", { ctrlKey: true });
    await tick();
    expect(ui.onApprove).toHaveBeenCalledWith("question", true, false, { format: ["Bullets"], title: ["Plan"] });
    ui.dispose();
  });

  it("uses Start and Keep planning without granting session permissions", async () => {
    const ui = setup();
    const part = tool("plan", { name: "ExitPlanMode", input: { plan: "## Plan\nCreate the note" } });
    const card = ui.add(part); ui.cards.sync([part]);
    expect(card.querySelector("strong")?.textContent).toBe("Claude Code has a plan");
    expect(primary(card).textContent).toBe("Start⏎");
    expect(card.querySelector('[data-focus-key="tool-deny"]')?.textContent).toBe("Keep planningesc");
    expect(card.querySelector('[data-focus-key="tool-allow-chat"]')).toBeNull();
    key(card, "Escape"); await tick();
    expect(ui.onApprove).toHaveBeenCalledWith("plan", false);
    ui.dispose();
  });

  it("routes announcements through the workspace and opens safe vault title links", () => {
    const root = document.body.createDiv();
    const onAnnounce = jest.fn(), onOpenPath = jest.fn();
    const cards = new AgentApprovalCards(root, { onApprove: jest.fn(), onAnnounce, onOpenPath });
    cards.load();
    const part = tool("one"), card = cards.create(part, "edit"); root.appendChild(card);
    cards.sync([part]);
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(onAnnounce).toHaveBeenCalledWith("Claude Code wants to edit Plan.md. Enter to approve, Escape to deny.");
    card.querySelector<HTMLAnchorElement>("strong a")!.click();
    expect(onOpenPath).toHaveBeenCalledWith("Notes/Plan.md");
    cards.unload();
  });

  it("sends a clicked single option once and skips a typed answer without sharing it", async () => {
    const ui = setup();
    const request = (id: string) => tool(id, { name: "requestUserInput", native: { agent: "codex", workingDirectory: "/vault" }, input: { questions: [{ id: "folder", question: "Which folder?", options: [{ label: "Notes" }] }] } });
    const first = request("one"), card = ui.add(first); ui.cards.sync([first]);
    expect(primary(card).dataset.optionNumber).toBe("1");
    primary(card).click(); await tick();
    expect(ui.onApprove.mock.calls).toEqual([["one", true, false, { folder: ["Notes"] }]]);
    const second = request("two"), next = ui.add(second); ui.cards.sync([second]);
    const input = next.querySelector("input")!;
    input.value = "Private answer"; input.dispatchEvent(new Event("input"));
    key(input, "Escape"); await tick();
    expect(ui.onApprove).toHaveBeenLastCalledWith("two", false, false, {});
    ui.dispose();
  });

  it("prevents repeated keyboard activation of a focused action", () => {
    const ui = setup();
    const part = tool("one"), card = ui.add(part); ui.cards.sync([part]);
    const event = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    primary(card).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(ui.onApprove).not.toHaveBeenCalled();
    ui.dispose();
  });

  it("keeps hosted chat trust and trash's existing always-ask behavior", async () => {
    const ui = setup();
    const part = tool("hosted", { native: undefined, name: "edit", input: { path: "Plan.md", edits: [] } });
    const card = ui.add(part);
    ui.cards.sync([part]);
    card.querySelector<HTMLButtonElement>('[data-focus-key="tool-allow-chat"]')!.click();
    await tick();
    expect(ui.onApprove).toHaveBeenCalledWith("hosted", true, true);
    const trash = ui.add(tool("trash", { name: "trash", native: undefined }));
    expect(trash.querySelector('[data-focus-key="tool-allow-chat"]')).toBeNull();
    ui.dispose();
  });

  it("shows a shortened large input only in Details without denying or truncating the request", () => {
    const ui = setup();
    const content = "a".repeat(128_001);
    const part = tool("write", { name: "Write", input: { file_path: "/vault/Long.md", content } });
    const card = ui.add(part);
    ui.cards.sync([part]);
    expect(card.querySelector("details")!.open).toBe(false);
    expect(card.querySelector("details pre")?.textContent).toContain("Preview shortened");
    expect(part.input).toEqual({ file_path: "/vault/Long.md", content });
    expect(ui.onApprove).not.toHaveBeenCalled();
    ui.dispose();
  });
});
