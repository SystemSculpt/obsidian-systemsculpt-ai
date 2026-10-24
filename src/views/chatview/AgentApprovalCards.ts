import { Component, setIcon } from "obsidian";
import { createSurfaceElement, createUiAction } from "../../core/ui/surface";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { presentAgentTool } from "./AgentToolPresentation";
import { nativeToolPresentation } from "./NativeToolPresentation";
import { getHostOperatingSystem } from "../../platform/hostCapabilities";

export type ApprovalAnswer = (
  approvalId: string,
  approved: boolean,
  rememberForSession?: boolean,
  answers?: Record<string, string[]>,
) => boolean | void | Promise<boolean | void>;

type ApprovalOptions = {
  onApprove: ApprovalAnswer;
  onReview?: () => void;
  composer?: () => HTMLElement | undefined;
  isVisible?: () => boolean;
  onHiddenApproval?: (part: AgentToolPart) => void;
};

type Question = { id: string; header: string; question: string; isSecret: boolean; multiSelect: boolean; options: { label: string; description: string }[] };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function questions(part: AgentToolPart): Question[] {
  if (!part.native || !Array.isArray(record(part.input).questions)) return [];
  return (record(part.input).questions as unknown[]).flatMap(value => {
    const q = record(value);
    if (typeof q.question !== "string") return [];
    const id = part.native?.agent === "claude" ? q.question : q.id;
    if (typeof id !== "string") return [];
    return [{
      id,
      header: typeof q.header === "string" ? q.header : "Question",
      question: q.question,
      isSecret: q.isSecret === true,
      multiSelect: part.native?.agent === "claude" && q.multiSelect === true,
      options: Array.isArray(q.options) ? q.options.flatMap(value => {
        const option = record(value);
        return typeof option.label === "string" ? [{ label: option.label, description: String(option.description ?? "") }] : [];
      }) : [],
    }];
  });
}

function editable(element: Element | null): boolean {
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'));
}

function sessionScope(part: AgentToolPart): string {
  if (!part.native) return "SystemSculpt won't ask again for this kind of vault action in this chat. Moving notes to trash still asks.";
  if (part.native.agent === "claude") {
    const scopes = (part.native.permissionSuggestions ?? []).flatMap(update => {
      const rules = Array.isArray(update.rules) ? update.rules.map(rule => {
        const value = record(rule);
        return [value.toolName, value.ruleContent].filter(item => typeof item === "string").join(": ");
      }).filter(Boolean) : [];
      return rules;
    });
    return part.native.permissionSuggestions?.length
      ? `Claude Code will remember ${scopes.join("; ") || "the suggested permissions shown in Details"} for this open chat session. Other actions may still ask. Closing the chat or resetting the agent clears this permission.`
      : "Claude Code supplied no reusable permission suggestion. This approves only the current request.";
  }
  const method = part.native.requestMethod ?? "";
  const scope = method.includes("commandExecution") ? "this command" : method.includes("fileChange") ? "changes to these files" : "the requested access";
  return `Codex will remember approval for ${scope} in this open chat session. Other actions may still ask. Closing the chat or resetting the agent clears this permission.`;
}

let approvalTitleSequence = 0;
const RAW_DISPLAY_CHARACTERS = 128_000;

/** Owns approval actions and focus; the renderer only reconciles card nodes. */
export class AgentApprovalCards extends Component {
  private pending = new Map<string, AgentToolPart>();
  private readonly answering = new Set<string>();
  private readonly announced = new Set<string>();
  private review: HTMLButtonElement | null = null;
  private announcement: HTMLElement;
  private composing = false;
  private composerEventTarget: HTMLElement | undefined;

  constructor(private readonly root: HTMLElement, private readonly options: ApprovalOptions) {
    super();
    this.announcement = root.createDiv({
      cls: "systemsculpt-agent-approval-announcement",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });
    this.registerDomEvent(root, "keydown", event => this.handleKey(event));
    this.registerDomEvent(root, "focusin", () => this.syncReviewVisibility());
    this.registerDomEvent(root, "focusout", () => this.syncReviewVisibilityAfterFocusMoves());
    this.register(() => { this.review?.remove(); this.announcement.remove(); });
  }

  onload(): void { this.bindComposerEvents(); }

  private bindComposerEvents(): void {
    const composer = this.options.composer?.();
    if (!composer || composer === this.composerEventTarget) return;
    this.composerEventTarget = composer;
    // Element listeners follow the chat when Obsidian moves it into a pop-out.
    this.registerDomEvent(composer, "compositionstart", () => { this.composing = true; this.syncReviewVisibility(); });
    this.registerDomEvent(composer, "compositionend", () => { this.composing = false; this.syncReviewVisibility(); });
    this.registerDomEvent(composer, "input", () => this.syncReviewVisibility());
    this.registerDomEvent(composer, "focusin", () => this.syncReviewVisibility());
    this.registerDomEvent(composer, "focusout", () => this.syncReviewVisibilityAfterFocusMoves());
    const keyboardRoot = composer.closest<HTMLElement>(".systemsculpt-agent-workspace") ?? composer;
    this.registerDomEvent(keyboardRoot, "keydown", event => {
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")
        && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && !event.defaultPrevented && !event.repeat && !event.isComposing && this.pending.size) {
        event.preventDefault();
        event.stopPropagation();
        this.reviewFirst();
      }
    });
  }

  create(part: AgentToolPart, canonicalName: string): HTMLElement {
    const card = createSurfaceElement(this.root.ownerDocument, "div");
    const id = part.approvalId!;
    card.className = "systemsculpt-agent-approval";
    card.dataset.approvalId = id;
    const titleId = `systemsculpt-agent-approval-title-${++approvalTitleSequence}`;
    card.setAttrs({ role: "group", tabindex: "0", "aria-labelledby": titleId, "data-focus-key": "tool-approval" });
    const native = nativeToolPresentation(part);
    const tool = presentAgentTool(part);
    const actionTitle = native?.title ?? [tool.label, tool.summary].filter(Boolean).join(" · ");
    const title = `${native?.agentName ?? "SystemSculpt"} wants to ${actionTitle.charAt(0).toLowerCase()}${actionTitle.slice(1)}`;
    const header = card.createDiv({ cls: "systemsculpt-agent-approval-header" });
    setIcon(header.createSpan({ cls: "systemsculpt-agent-approval-icon", attr: { "aria-hidden": "true" } }), native?.icon ?? tool.actionIcon);
    header.createEl("strong", { cls: "systemsculpt-agent-approval-copy", text: title, attr: { id: titleId } });
    header.createSpan({ cls: "systemsculpt-agent-approval-counter" });
    card.createDiv({ cls: "systemsculpt-agent-approval-preview", attr: { hidden: "" } });

    const questionList = questions(part);
    card.dataset.questionCount = String(questionList.length);
    const answers: Record<string, string[]> = {};
    for (const question of questionList) {
      const group = card.createEl("fieldset", { cls: "systemsculpt-agent-approval-question" });
      group.createEl("legend", { text: question.question });
      const choices = group.createDiv({ cls: "systemsculpt-agent-approval-options" });
      const inputId = `${titleId}-${questionList.indexOf(question)}`;
      const label = group.createEl("label", { text: "Your answer", attr: { for: inputId } });
      const input = group.createEl("input", { attr: { id: inputId, type: question.isSecret ? "password" : "text", autocomplete: "off", "data-testid": "chat.approval.answer" } });
      label.addClass("systemsculpt-agent-approval-answer-label");
      input.addEventListener("input", () => {
        answers[question.id] = input.value ? [input.value] : [];
        choices.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", "false"));
      });
      for (const option of question.options) {
        const choice = createUiAction(choices, { label: option.label, testId: "chat.approval.option", size: "small", tooltip: false });
        choice.setAttribute("aria-pressed", "false");
        if (questionList.length === 1 && question.options.indexOf(option) < 9) {
          const number = String(question.options.indexOf(option) + 1);
          choice.setAttribute("aria-keyshortcuts", number);
          choice.dataset.optionNumber = number;
          choice.dataset.sendOnSelection = String(!question.multiSelect);
          choice.createEl("kbd", { text: number, attr: { "aria-hidden": "true" } });
        }
        if (option.description) choice.createSpan({ cls: "systemsculpt-agent-approval-option-description", text: option.description });
        choice.onclick = () => {
          const selected = input.value ? [] : answers[question.id] ?? [];
          answers[question.id] = question.multiSelect
            ? selected.includes(option.label) ? selected.filter(label => label !== option.label) : [...selected, option.label]
            : [option.label];
          input.value = "";
          choices.querySelectorAll("button").forEach((button, index) => {
            button.setAttribute("aria-pressed", String(answers[question.id].includes(question.options[index].label)));
          });
        };
      }
    }

    const details = card.createEl("details", { cls: "systemsculpt-agent-approval-details" });
    details.createEl("summary", { text: "Details" });
    // Secret answers are never copied into this disclosure or the conversation.
    const raw = JSON.stringify(part.native?.permissionSuggestions?.length
      ? { input: part.input, permissionSuggestions: part.native.permissionSuggestions }
      : part.input ?? {}, null, 2);
    details.createEl("pre", { text: raw.length > RAW_DISPLAY_CHARACTERS ? `${raw.slice(0, RAW_DISPLAY_CHARACTERS)}\n… Preview shortened; the full request is sent unchanged.` : raw });
    const actions = card.createDiv({ cls: "systemsculpt-agent-approval-actions" });
    const action = (label: string, hint: string, identity: { testId: string }, focusKey: string, shortcut: string, approved: boolean, remember = false) => {
      const button = createUiAction(actions, { label, ...identity, size: "small", ...(approved && !remember ? { tone: "primary" as const } : {}), tooltip: remember, ...(remember ? { title: sessionScope(part) } : {}) });
      button.setAttrs({ "data-focus-key": focusKey, "aria-keyshortcuts": shortcut });
      button.createEl("kbd", { text: hint, attr: { "aria-hidden": "true" } });
      button.onclick = () => void this.answer(card, approved, remember, questionList.length ? answers : undefined);
      return button;
    };
    action(questionList.length ? "Send answer" : "Approve", "↵", { testId: "chat.approval.allow-once" }, "tool-allow-once", "Enter Meta+Enter Control+Enter", true);
    action(questionList.length ? "Skip" : "Deny", "Esc", { testId: "chat.approval.deny" }, "tool-deny", "Escape", false);
    // Keep the hosted trash policy: it always asks, even after chat trust.
    if (!questionList.length && (part.native || canonicalName !== "trash")) {
      const shortcut = getHostOperatingSystem() === "macOS" ? "⇧⌘↵" : "Ctrl+Shift+Enter";
      action("Approve all in this chat", shortcut, { testId: "chat.approval.allow-for-chat" }, "tool-allow-chat", "Shift+Meta+Enter Shift+Control+Enter", true, true);
    }
    return card;
  }

  captureFocus(): string | undefined {
    const focused = this.root.ownerDocument.activeElement;
    return focused && this.root.contains(focused)
      ? focused.closest<HTMLElement>("[data-approval-id]")?.dataset.approvalId
      : undefined;
  }

  sync(parts: readonly AgentToolPart[], previouslyFocused?: string): void {
    const previousOrder = [...this.pending.keys()];
    this.pending = new Map(parts.filter(part => part.state === "approval-required" && part.approvalId && (part.location === "vault" || part.native))
      .map(part => [part.approvalId!, part]));
    for (const id of this.answering) if (!this.pending.has(id)) this.answering.delete(id);
    const newParts = [...this.pending.values()].filter(part => !this.announced.has(part.approvalId!));
    for (const part of newParts) this.announced.add(part.approvalId!);
    this.updateReview();
    [...this.pending.keys()].forEach((id, index) => {
      const card = this.cards().find(candidate => candidate.dataset.approvalId === id);
      card?.querySelector(".systemsculpt-agent-approval-counter")?.setText(this.pending.size > 1 ? `${index + 1} of ${this.pending.size}` : "");
    });
    if (previouslyFocused && !this.pending.has(previouslyFocused)) {
      this.focusAfter(previouslyFocused, previousOrder);
      return;
    }
    // Grouping a newly resolved tool can reparent the next pending card and blur it.
    if (previouslyFocused && this.root.ownerDocument.activeElement === this.root.ownerDocument.body) {
      this.cards().find(card => card.dataset.approvalId === previouslyFocused)?.focus({ preventScroll: true });
    }
    if (!newParts.length) return;
    const first = newParts[0];
    const native = nativeToolPresentation(first);
    const tool = presentAgentTool(first);
    const title = native?.title ?? [tool.label, tool.summary].filter(Boolean).join(" ");
    this.announcement.setText(`${native?.agentName ?? "SystemSculpt"} wants to ${title.charAt(0).toLowerCase()}${title.slice(1)}`);
    if (this.options.isVisible?.() === false) {
      this.options.onHiddenApproval?.(first);
      return;
    }
    const active = this.root.ownerDocument.activeElement;
    const ownsFocus = active === this.root.ownerDocument.body || this.root.contains(active)
      || Boolean(this.options.composer?.()?.contains(active));
    const composer = this.options.composer?.();
    const emptyComposer = composer?.contains(active) && active?.tagName === "TEXTAREA"
      && !(active as HTMLTextAreaElement).value && !this.composing;
    if (ownsFocus && (!editable(active) || emptyComposer) && !this.captureFocus()) this.focusFirst();
  }

  clear(): void {
    this.pending.clear();
    this.answering.clear();
    this.announced.clear();
    this.updateReview();
  }

  focusFirst(): void {
    const card = this.cards()[0];
    if (card) {
      card.focus({ preventScroll: true });
      card.scrollIntoView?.({ block: "nearest" });
    } else {
      this.options.composer?.()?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    }
  }

  private reviewFirst(): void {
    this.options.onReview?.();
    this.focusFirst();
  }

  private focusAfter(id: string, order: readonly string[]): void {
    const index = order.indexOf(id);
    const candidates = [...order.slice(index + 1), ...order.slice(0, index).reverse()];
    const cards = this.cards();
    const next = candidates.map(candidate => cards.find(card => card.dataset.approvalId === candidate)).find(Boolean);
    if (next) { next.focus({ preventScroll: true }); next.scrollIntoView?.({ block: "nearest" }); }
    else this.focusFirst();
  }

  private cards(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>(".systemsculpt-agent-approval[data-approval-id]"))
      .filter(card => this.pending.has(card.dataset.approvalId!) && !this.answering.has(card.dataset.approvalId!));
  }

  private updateReview(): void {
    this.bindComposerEvents();
    const composer = this.options.composer?.();
    if (!this.review && composer) {
      this.review = createUiAction(composer, { label: "Approval needed · Review", icon: "shield-question", size: "small", testId: "chat.approval.review", tooltip: false });
      composer.prepend(this.review);
      this.review.addClass("systemsculpt-agent-approval-review");
      this.review.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
      this.review.createEl("kbd", {
        cls: "systemsculpt-agent-approval-review-key",
        text: getHostOperatingSystem() === "macOS" ? "⌥↑" : "Alt+↑",
        attr: { "aria-hidden": "true" },
      });
      this.review.onclick = () => this.reviewFirst();
    }
    this.syncReviewVisibility();
  }

  /**
   * The review pill shows only where a card could not take focus (spec 6.2.3):
   * while the person types in the composer (or composes with an IME), or
   * while focus is outside the chat. A card with focus, or an empty composer,
   * needs no pill.
   */
  private syncReviewVisibility(): void {
    if (!this.review) return;
    this.review.toggleAttribute("hidden", !this.reviewWanted());
  }

  private syncReviewVisibilityAfterFocusMoves(): void {
    // focusout fires before the next element takes focus.
    this.root.ownerDocument.defaultView?.setTimeout(() => this.syncReviewVisibility(), 0);
  }

  private reviewWanted(): boolean {
    if (this.pending.size === 0) return false;
    const ownerDocument = this.root.ownerDocument;
    const active = ownerDocument.activeElement;
    const composer = this.options.composer?.();
    if (active && composer?.contains(active)) {
      if (active === this.review) return true;
      const typed = active.tagName === "TEXTAREA" && (active as HTMLTextAreaElement).value.trim().length > 0;
      return typed || this.composing;
    }
    const view = this.root.closest(".systemsculpt-agent-workspace") ?? this.root;
    return !active || active === ownerDocument.body || !view.contains(active);
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const target = event.target as HTMLElement | null;
    const card = target?.closest<HTMLElement>(".systemsculpt-agent-approval[data-approval-id]");
    if (!card || !this.pending.has(card.dataset.approvalId!)) return;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !editable(target)
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const cards = this.cards();
      const index = cards.indexOf(card);
      const next = cards[(index + (event.key === "ArrowDown" ? 1 : -1) + cards.length) % cards.length];
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      next.focus();
      return;
    }
    const modified = event.metaKey || event.ctrlKey;
    if (!modified && !event.altKey && !editable(target) && card.dataset.questionCount === "1" && /^[1-9]$/.test(event.key)) {
      const option = card.querySelector<HTMLButtonElement>(`[data-option-number="${event.key}"]`);
      if (option) {
        event.preventDefault();
        event.stopPropagation();
        option.click();
        if (option.dataset.sendOnSelection === "true") {
          card.querySelector<HTMLButtonElement>('[data-focus-key="tool-allow-once"]')?.click();
        }
      }
      return;
    }
    if (event.key !== "Escape" && !(event.key === "Enter" && (target === card || modified || target?.tagName === "INPUT"))) return;
    event.preventDefault();
    event.stopPropagation();
    const selector = event.key === "Escape" ? '[data-focus-key="tool-deny"]'
      : event.shiftKey && modified ? '[data-focus-key="tool-allow-chat"]' : '[data-focus-key="tool-allow-once"]';
    card.querySelector<HTMLButtonElement>(selector)?.click();
  }

  private async answer(card: HTMLElement, approved: boolean, remember: boolean, answers?: Record<string, string[]>): Promise<void> {
    const id = card.dataset.approvalId!;
    if (!this.pending.has(id) || this.answering.has(id)) return;
    this.answering.add(id);
    const order = [...this.pending.keys()];
    const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>("button"));
    buttons.forEach(button => { button.disabled = true; });
    let accepted = false;
    try {
      const result = answers
        ? await this.options.onApprove(id, approved, remember, answers)
        : remember ? await this.options.onApprove(id, approved, true)
          : await this.options.onApprove(id, approved);
      accepted = result !== false;
      if (accepted) {
        this.announcement.setText(approved ? remember ? "Approved for this chat" : "Approved" : "Denied");
        this.focusAfter(id, order);
      }
    } catch {
      card.createDiv({ cls: "systemsculpt-agent-approval-answer-error", text: "The answer could not be sent. Try again.", attr: { role: "alert" } });
    } finally {
      if (!accepted) {
        this.answering.delete(id);
        buttons.forEach(button => { button.disabled = false; });
      }
    }
  }
}
