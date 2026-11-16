import { Component, setIcon } from "obsidian";
import { createSurfaceElement, createUiAction, updateUiAction } from "../../core/ui/surface";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { presentAgentTool } from "./AgentToolPresentation";
import { nativeToolPresentation, noteDisplayName } from "./NativeToolPresentation";
import { getHostOperatingSystem } from "../../platform/hostCapabilities";
import { renderJsonLines } from "./ToolCardBlocks";

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
  onAnnounce?: (text: string) => void;
  onOpenPath?: (path: string) => void | Promise<void>;
  /** Whether a vault path already holds a file, so a write over it reads as replacing it. */
  exists?: (path: string) => boolean;
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

/** A shortcut written the way Obsidian lists hotkeys: "⌘ ⇧ Enter" on macOS, "Ctrl + Shift + Enter" elsewhere. */
function shortcut(key: string, ...modifiers: readonly ("Mod" | "Alt" | "Shift")[]): string {
  const mac = getHostOperatingSystem() === "macOS";
  const names = mac ? { Mod: "⌘", Alt: "⌥", Shift: "⇧" } : { Mod: "Ctrl", Alt: "Alt", Shift: "Shift" };
  return [...modifiers.map(modifier => names[modifier]), key].join(mac ? " " : " + ");
}

/** A name this short never breaks across lines, as in rows. */
const WHOLE_NAME_LENGTH = 32;

/** The file a title names, as Obsidian and its row name a note ("Garden", not "Garden.md"); Details keeps the path. */
function namedTarget(title: string, targetPath: string | undefined): { before: string; name: string; after: string } | undefined {
  const file = targetPath?.split(/[\\/]/u).pop();
  const offset = file ? title.lastIndexOf(file) : -1;
  return file && offset >= 0
    ? { before: title.slice(0, offset), name: noteDisplayName(file), after: title.slice(offset + file.length) }
    : undefined;
}

function folderOf(path: string | undefined): string | undefined {
  return path?.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
}

/** The meta line names a place one way, capitalised: "In Notes", "In vault". */
function placeMeta(meta: string | undefined, folder: string | undefined): string | undefined {
  if (meta?.startsWith("in ")) return `In ${meta.slice(3)}`;
  return meta && folder && (meta === folder || meta.startsWith(`${folder} · `)) ? `In ${meta}` : meta;
}

function sessionScope(part: AgentToolPart): string {
  if (!part.native) {
    const kind = presentAgentTool(part).groupKind;
    const scope = kind === "edit" || kind === "write" ? "edits" : kind === "move" ? "moves" : "this kind of vault action";
    return `SystemSculpt won't ask again for ${scope} in this chat. Moving notes to trash still asks.`;
  }
  if (part.native.agent === "claude") {
    const scopes = (part.native.permissionSuggestions ?? []).flatMap(update => {
      const rules = Array.isArray(update.rules) ? update.rules.map(rule => {
        const value = record(rule);
        return [value.toolName, value.ruleContent].filter(item => typeof item === "string").join(": ");
      }).filter(Boolean) : [];
      return rules;
    });
    return part.native.permissionSuggestions?.length
      ? `Claude Code won't ask again for ${scopes.join("; ") || "the suggested permissions shown in Details"} in this chat. Other actions may still ask. Closing the chat or resetting the agent clears this permission.`
      : "Claude Code supplied no reusable permission suggestion. This approves only the current request.";
  }
  const method = part.native.requestMethod ?? "";
  const scope = method.includes("commandExecution") ? "this command" : method.includes("fileChange") ? "changes to these files" : "the requested access";
  return `Codex won't ask again for ${scope} in this chat. Other actions may still ask. Closing the chat or resetting the agent clears this permission.`;
}

let approvalTitleSequence = 0;
const RAW_DISPLAY_CHARACTERS = 128_000;

/** Owns approval actions and focus; the renderer only reconciles card nodes. */
export class AgentApprovalCards extends Component {
  private pending = new Map<string, AgentToolPart>();
  private readonly answering = new Set<string>();
  private readonly announced = new Set<string>();
  private review: HTMLButtonElement | null = null;
  private reviewKind: "question" | "approval" = "approval";
  private announcement: HTMLElement | null;
  private composing = false;
  private composerEventTarget: HTMLElement | undefined;
  private cardObserver: IntersectionObserver | null = null;
  /** Whether each pending card is in the chat's scroller; a card not yet measured counts as on screen. */
  private readonly onScreen = new Map<Element, boolean>();

  constructor(private readonly root: HTMLElement, private readonly options: ApprovalOptions) {
    super();
    this.announcement = options.onAnnounce ? null : root.createDiv({
      cls: "systemsculpt-agent-approval-announcement",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });
    this.registerDomEvent(root, "keydown", event => this.handleKey(event));
    this.registerDomEvent(root, "focusin", () => this.syncReviewVisibility());
    this.registerDomEvent(root, "focusout", () => this.syncReviewVisibilityAfterFocusMoves());
    // A chat moved into a pop-out measures its cards with that window's observer.
    const detachMigration = root.onWindowMigrated?.(() => {
      this.disconnectCards();
      this.observeCards();
      this.syncReviewVisibility();
    });
    this.register(() => {
      detachMigration?.();
      this.disconnectCards();
      this.review?.remove();
      this.announcement?.remove();
    });
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
    // The whole leaf, so Obsidian's view header actions review cards too.
    const keyboardRoot = composer.closest<HTMLElement>(".workspace-leaf-content")
      ?? composer.closest<HTMLElement>(".systemsculpt-agent-workspace")
      ?? composer;
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
    const plan = part.native?.agent === "claude" && part.name === "ExitPlanMode";
    const questionList = questions(part);
    const targetPath = native?.targetPath ?? tool.targetPath;
    // A write over an existing note replaces it; the title and its icon both say so.
    const writes = native ? part.native?.agent === "claude" && part.name === "Write" : canonicalName === "write";
    const replaces = writes && Boolean(targetPath && this.options.exists?.(targetPath));
    const label = replaces && !native ? tool.label.replace(/^Create /u, "Replace ") : tool.label;
    const nativeTitle = replaces && native ? native.approvalTitle.replace(/^create /u, "replace ") : native?.approvalTitle;
    const actionTitle = nativeTitle ?? label.charAt(0).toLowerCase() + label.slice(1);
    const agent = native?.agentName ?? "SystemSculpt";
    const title = plan ? `${agent} has a plan` : questionList.length ? `${agent} asks: ${questionList.length === 1 ? questionList[0].question : "A few questions"}`
      : `${agent} wants to ${actionTitle}`;
    // One glyph per verb: creating adds a file; replacing or editing one changes it.
    const icon = replaces || (canonicalName === "multi_edit" && tool.targetPath) ? "file-pen-line" : native?.icon ?? tool.actionIcon;
    const header = card.createDiv({ cls: "systemsculpt-agent-approval-header" });
    setIcon(header.createSpan({ cls: "systemsculpt-agent-approval-icon", attr: { "aria-hidden": "true" } }), icon);
    const heading = header.createEl("strong", { cls: "systemsculpt-agent-approval-copy", text: title, attr: { id: titleId } });
    const target = namedTarget(title, targetPath);
    if (target && targetPath) {
      heading.empty(); heading.appendText(target.before);
      const cls = `systemsculpt-agent-approval-target${target.name.length <= WHOLE_NAME_LENGTH ? " is-whole" : ""}`;
      // A note that isn't there yet is plain text: opening it would create it.
      if (this.options.onOpenPath && this.options.exists?.(targetPath) !== false) {
        const link = heading.createEl("a", { text: target.name, cls: `internal-link ${cls}`, attr: { href: targetPath, "data-href": targetPath } });
        link.onclick = event => { event.preventDefault(); void this.options.onOpenPath?.(targetPath); };
      } else heading.createSpan({ cls, text: target.name });
      heading.appendText(target.after);
    }
    header.createSpan({ cls: "systemsculpt-agent-approval-counter" });
    const meta = placeMeta(native?.meta ?? folderOf(targetPath), native?.meta ? folderOf(native.path) : folderOf(targetPath));
    const metaId = `${titleId}-meta`;
    card.createDiv({ cls: "systemsculpt-agent-approval-meta", text: meta ?? "", attr: { id: metaId, ...(!meta ? { hidden: "" } : {}) } });
    card.setAttribute("aria-describedby", metaId);
    card.createDiv({ cls: "systemsculpt-agent-approval-preview", attr: { hidden: "", "data-testid": "chat.approval.preview" } });
    card.dataset.questionCount = String(questionList.length);
    const answers: Record<string, string[]> = {};
    // Send waits for a chosen option or typed words. It stays in the tab order, announced as unavailable.
    let send: HTMLButtonElement | undefined;
    const syncSend = (): void => {
      send?.setAttribute("aria-disabled", String(!Object.values(answers).some(values => values.length > 0)));
    };
    // One question with one choice: a click on an option answers it at once, so Send sits
    // beside the typed answer, the only thing it sends.
    const optionAnswers = questionList.length === 1 && !questionList[0].multiSelect;
    let answerField: HTMLElement | undefined;
    for (const question of questionList) {
      const group = card.createEl("fieldset", { cls: "systemsculpt-agent-approval-question" });
      group.createEl("legend", { text: question.question, ...(questionList.length === 1 ? { cls: "systemsculpt-agent-approval-question-legend" } : {}) });
      const choices = group.createDiv({ cls: "systemsculpt-agent-approval-options" });
      // One prompt, worded as the alternative to the options.
      const prompt = question.options.length ? "Or type an answer" : "Type an answer";
      answerField = group.createDiv({ cls: "systemsculpt-agent-approval-answer" });
      const input = answerField.createEl("input", { attr: { type: question.isSecret ? "password" : "text", autocomplete: "off", placeholder: `${prompt}…`, "aria-label": prompt, "data-testid": "chat.approval.answer" } });
      input.addEventListener("input", () => {
        answers[question.id] = input.value ? [input.value] : [];
        choices.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", "false"));
        syncSend();
      });
      for (const option of question.options) {
        const choice = createUiAction(choices, { label: option.label, testId: "chat.approval.option", size: "small", tooltip: false });
        choice.setAttribute("aria-pressed", "false");
        if (questionList.length === 1 && question.options.indexOf(option) < 9) {
          const number = String(question.options.indexOf(option) + 1);
          choice.setAttribute("aria-keyshortcuts", number);
          choice.dataset.optionNumber = number;
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
          syncSend();
          if (optionAnswers) void this.answer(card, true, false, answers);
        };
      }
    }

    // The same quiet "› Details" disclosure every tool card ends with.
    const details = card.createEl("details", { cls: "systemsculpt-agent-approval-details systemsculpt-agent-tool-raw" });
    const summary = details.createEl("summary");
    setIcon(summary.createSpan({ cls: "systemsculpt-agent-tool-raw-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
    summary.appendText("Details");
    // Secret answers are never copied into this disclosure or the conversation.
    const raw = JSON.stringify(part.native?.permissionSuggestions?.length
      ? { input: part.input, permissionSuggestions: part.native.permissionSuggestions }
      : part.input ?? {}, null, 2);
    // The tool cards' Details box: the code scrolls inside the frame's padding, so the frame keeps
    // its border and inset at both ends while the code fades out above its bottom edge.
    const code = details.createEl("pre").createEl("code", { attr: { tabindex: "0" } });
    // Line by line, as in tool cards: a long value wraps under its own indent, never back to the edge.
    renderJsonLines(code, raw.length > RAW_DISPLAY_CHARACTERS ? `${raw.slice(0, RAW_DISPLAY_CHARACTERS)}\n… Preview shortened; the full request is sent unchanged.` : raw);
    // A block taller than its frame fades out at the bottom until it is scrolled to its end, so a cut line reads as more below.
    const syncOverflow = (): void => {
      const overflowing = code.scrollHeight > code.clientHeight + 1;
      code.classList.toggle("is-overflowing", overflowing);
      code.classList.toggle("is-at-end", !overflowing || code.scrollTop + code.clientHeight >= code.scrollHeight - 1);
    };
    code.addEventListener("scroll", syncOverflow, { passive: true });
    details.addEventListener("toggle", () => { if (details.open) syncOverflow(); });
    const actions = card.createDiv({ cls: "systemsculpt-agent-approval-actions" });
    const action = (label: string, hint: string, identity: { testId: string }, focusKey: string, keys: string, approved: boolean, remember = false) => {
      const button = createUiAction(actions, { label, ...identity, size: "small", ...(approved && !remember ? { tone: "primary" as const } : {}), tooltip: remember, ...(remember ? { title: sessionScope(part) } : {}) });
      button.setAttrs({ "data-focus-key": focusKey, "aria-keyshortcuts": keys });
      // In the label's own line, so the smaller hint sits on its words' baseline, not centred beside them.
      (button.querySelector<HTMLElement>(".ss-button__label") ?? button).createEl("kbd", { text: hint, attr: { "aria-hidden": "true" } });
      button.onclick = () => {
        if (button.getAttribute("aria-disabled") === "true") return;
        void this.answer(card, approved, remember, questionList.length ? approved ? answers : {} : undefined);
      };
      return button;
    };
    const allowOnce = action(plan ? "Start" : questionList.length ? "Send" : "Approve", shortcut("Enter"), { testId: "chat.approval.allow-once" }, "tool-allow-once", "Enter Meta+Enter Control+Enter", true);
    if (questionList.length) {
      send = allowOnce;
      syncSend();
      if (optionAnswers) answerField?.appendChild(allowOnce);
    }
    action(plan ? "Keep planning" : questionList.length ? "Skip" : "Deny", shortcut("Esc"), { testId: "chat.approval.deny" }, "tool-deny", "Escape", false);
    // Neither deleting files nor approving a plan grants ongoing permission.
    const deletesFiles = canonicalName === "trash" || (Array.isArray(record(part.input).changes) && (record(part.input).changes as unknown[]).some(change => {
      const operation = record(change).kind;
      return operation === "delete" || record(operation).type === "delete";
    }));
    if (!questionList.length && !plan && !deletesFiles) {
      action("Approve all in this chat", shortcut("Enter", "Mod", "Shift"), { testId: "chat.approval.allow-for-chat" }, "tool-allow-chat", "Shift+Meta+Enter Shift+Control+Enter", true, true);
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
      const retained = this.cards().find(card => card.dataset.approvalId === previouslyFocused);
      if (retained) this.focusCard(retained);
    }
    if (!newParts.length) return;
    const first = newParts[0];
    const native = nativeToolPresentation(first);
    const tool = presentAgentTool(first);
    const title = native?.approvalTitle ?? tool.label.charAt(0).toLowerCase() + tool.label.slice(1);
    // The note is named as on its card.
    const target = namedTarget(title, native?.targetPath ?? tool.targetPath);
    const questionList = questions(first);
    const announcement = first.name === "ExitPlanMode" ? `${native?.agentName ?? "Claude Code"} has a plan. Enter to start, Escape to keep planning.`
      : questionList.length ? `${native?.agentName ?? "Codex"} asks: ${questionList[0].question}`
        : `${native?.agentName ?? "SystemSculpt"} wants to ${target ? `${target.before}${target.name}${target.after}` : title}. Enter to approve, Escape to deny.`;
    this.announce(announcement);
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

  private announce(text: string): void {
    if (this.options.onAnnounce) this.options.onAnnounce(text);
    else this.announcement?.setText(text);
  }

  private focusCard(card: HTMLElement): void {
    const primary = card.querySelector<HTMLElement>('[data-option-number="1"], [data-testid="chat.approval.answer"], [data-focus-key="tool-allow-once"]');
    (primary ?? card).focus({ preventScroll: true });
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
      this.focusCard(card);
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
    if (next) { this.focusCard(next); next.scrollIntoView?.({ block: "nearest" }); }
    else this.focusFirst();
  }

  private cards(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>(".systemsculpt-agent-approval[data-approval-id]"))
      .filter(card => this.pending.has(card.dataset.approvalId!) && !this.answering.has(card.dataset.approvalId!));
  }

  private updateReview(): void {
    this.bindComposerEvents();
    const composer = this.options.composer?.();
    // A question is not an approval: the pill names what is waiting, as the card and status row do.
    const kind = this.pending.size > 0 && [...this.pending.values()].every(part => questions(part).length > 0) ? "question" : "approval";
    if (!this.review && composer) {
      this.review = createUiAction(composer, { label: "Approval needed · Review", icon: "shield-question", size: "small", testId: "chat.approval.review", tooltip: false });
      composer.prepend(this.review);
      this.review.addClass("systemsculpt-agent-approval-review");
      this.review.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
      this.review.createEl("kbd", {
        cls: "systemsculpt-agent-approval-review-key",
        text: shortcut("↑", "Alt"),
        attr: { "aria-hidden": "true" },
      });
      this.review.onclick = () => this.reviewFirst();
      this.reviewKind = "approval";
    }
    if (this.review && kind !== this.reviewKind) {
      this.reviewKind = kind;
      updateUiAction(this.review, kind === "question"
        ? { label: "Answer needed · Review", icon: "message-circle-question" }
        : { label: "Approval needed · Review", icon: "shield-question" });
    }
    this.observeCards();
    this.syncReviewVisibility();
  }

  /** Watches each pending card, so the pill shows only while one is scrolled out of view. */
  private observeCards(): void {
    const Observer = this.root.ownerDocument.defaultView?.IntersectionObserver;
    if (typeof Observer !== "function") return;
    if (!this.cardObserver) {
      this.cardObserver = new Observer(entries => {
        for (const entry of entries) this.onScreen.set(entry.target, entry.isIntersecting);
        this.syncReviewVisibility();
      });
    }
    const cards = new Set<Element>(this.cards());
    for (const card of [...this.onScreen.keys()]) {
      if (cards.has(card)) continue;
      this.cardObserver.unobserve(card);
      this.onScreen.delete(card);
    }
    for (const card of cards) {
      if (this.onScreen.has(card)) continue;
      this.onScreen.set(card, true);
      this.cardObserver.observe(card);
    }
  }

  private disconnectCards(): void {
    this.cardObserver?.disconnect();
    this.cardObserver = null;
    this.onScreen.clear();
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
    // A card the person can see is its own prompt; a second pill would say it twice.
    const cards = this.cards();
    if (this.cardObserver && cards.length > 0 && cards.every(card => this.onScreen.get(card) !== false)) return false;
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
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    const card = target?.closest<HTMLElement>(".systemsculpt-agent-approval[data-approval-id]");
    if (!card || !this.pending.has(card.dataset.approvalId!)) return;
    if (event.repeat) {
      if (["Enter", " ", "Escape"].includes(event.key) && !editable(target)) event.preventDefault();
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !editable(target)
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const cards = this.cards();
      const index = cards.indexOf(card);
      const next = cards[(index + (event.key === "ArrowDown" ? 1 : -1) + cards.length) % cards.length];
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      this.focusCard(next);
      return;
    }
    const modified = event.metaKey || event.ctrlKey;
    if (!modified && !event.altKey && !editable(target) && card.dataset.questionCount === "1" && /^[1-9]$/.test(event.key)) {
      const option = card.querySelector<HTMLButtonElement>(`[data-option-number="${event.key}"]`);
      if (option) {
        event.preventDefault();
        event.stopPropagation();
        option.click();
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
        this.announce(answers ? approved ? "Answer sent" : "Skipped" : approved ? remember ? "Approved for this chat" : "Approved" : "Denied");
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
