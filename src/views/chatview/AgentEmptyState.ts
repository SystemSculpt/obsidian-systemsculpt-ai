import { setIcon } from "obsidian";
import { createUiAction } from "../../core/ui/surface";
import type {
  ChromeStarter,
  EmptyStateNote,
  EmptyStatePresentation,
  EmptyStatePro,
  ProCapability,
} from "./AgentChatChrome";

export type AgentEmptyStateAction =
  | "start-free"
  | "sign-in"
  | "see-plans"
  | "detect-again"
  | "subscribe-pro"
  | `try-${ProCapability}`
  | NonNullable<EmptyStateNote["action"]>["id"];

export type AgentEmptyStateOptions = Readonly<{
  onStarter: (starter: ChromeStarter) => void;
  onAction: (action: AgentEmptyStateAction) => void;
}>;

const OFFER_ACTIONS = {
  "start-free": { label: "Start free", testId: "chat.empty.start-free", tone: "primary" },
  "sign-in": { label: "Sign in", testId: "chat.empty.sign-in", tone: "default" },
  "see-plans": { label: "See plans", testId: "chat.empty.see-plans", tone: "primary" },
} as const;

/** Appends text whose `backticked` parts are commands, shown as code. */
function appendWithCode(parent: HTMLElement, text: string): void {
  text.split("`").forEach((part, index) => {
    if (!part) return;
    if (index % 2 === 1) parent.createEl("code", { text: part });
    else parent.appendText(part);
  });
}

/** Each chat view's Pro heading needs its own id for aria-labelledby. */
let proTitleSequence = 0;

const NOTE_ACTIONS = {
  "switch-below": { testId: "chat.empty.switch-below" },
  "back-to-previous": { testId: "chat.empty.back-to-previous" },
} as const;

/**
 * The empty conversation: what runs here, the starters, and the account or
 * install guidance for the current detection result. It renders whatever
 * presentation it is given and owns no state of its own.
 */
export class AgentEmptyState {
  public readonly element: HTMLElement;
  private rendered = "";

  constructor(parent: HTMLElement, private readonly options: AgentEmptyStateOptions) {
    this.element = parent.createDiv({
      cls: "systemsculpt-agent-empty",
      attr: { "data-testid": "chat.empty" },
    });
  }

  public render(presentation: EmptyStatePresentation): void {
    // Re-rendering identical copy would drop keyboard focus from a starter.
    const key = JSON.stringify(presentation);
    if (key === this.rendered) return;
    this.rendered = key;
    const focused = this.element.contains(this.element.ownerDocument.activeElement)
      ? (this.element.ownerDocument.activeElement as HTMLElement).dataset.testid
      : undefined;
    this.element.empty();
    const body = this.element.createDiv({ cls: "systemsculpt-agent-empty-body" });
    body.createEl("h2", { cls: "systemsculpt-agent-empty-title", text: presentation.title });
    for (const note of presentation.notes.filter((entry) => entry.id === "switched")) this.renderNote(body, note);
    if (presentation.lead) {
      body.createEl("p", { cls: "systemsculpt-agent-empty-lead", text: presentation.lead });
    }
    for (const note of presentation.notes.filter((entry) => entry.id !== "switched")) this.renderNote(body, note);
    if (presentation.offer) {
      const offer = body.createDiv({ cls: "systemsculpt-agent-empty-offer" });
      if (presentation.offer.text) offer.createEl("p", { text: presentation.offer.text });
      const actions = offer.createDiv({ cls: "systemsculpt-agent-empty-actions" });
      for (const action of presentation.offer.actions) {
        const spec = OFFER_ACTIONS[action];
        const button = createUiAction(actions, {
          label: spec.label,
          testId: spec.testId,
          tone: spec.tone,
          size: "small",
        });
        button.onclick = () => this.options.onAction(action);
      }
    }
    for (const hint of presentation.hints) {
      const line = body.createEl("p", {
        cls: "systemsculpt-agent-empty-hint",
        attr: { "data-hint": hint.id },
      });
      appendWithCode(line, `${hint.before} `);
      const detect = line.createEl("button", {
        cls: "systemsculpt-agent-empty-link",
        text: "Detect again",
        attr: { type: "button", "data-testid": "chat.empty.detect-again" },
      });
      detect.onclick = () => this.options.onAction("detect-again");
      line.appendText(hint.after);
    }
    if (presentation.starters.length > 0) {
      const list = body.createDiv({
        cls: "systemsculpt-agent-starters",
        attr: { role: "group", "aria-label": "Suggested prompts" },
      });
      for (const starter of presentation.starters) {
        const button = createUiAction(list, {
          label: starter.label,
          testId: `chat.empty.starter.${starter.id}`,
          size: "small",
        });
        button.addClass("systemsculpt-agent-starter");
        button.onclick = () => this.options.onStarter(starter);
      }
    }
    if (presentation.pro) this.renderPro(body, presentation.pro);
    if (focused) {
      this.element.querySelector<HTMLElement>(`[data-testid="${focused}"]`)?.focus();
    }
  }

  /** What a subscription adds: one line each, then one Subscribe tap; a subscriber gets one tap into each. */
  private renderPro(parent: HTMLElement, pro: EmptyStatePro): void {
    const section = parent.createDiv({
      cls: "systemsculpt-agent-pro",
      attr: { "data-testid": "chat.empty.pro", "data-kind": pro.kind },
    });
    const titleId = `systemsculpt-agent-pro-${++proTitleSequence}`;
    section.createEl("p", { cls: "systemsculpt-agent-pro-title", text: pro.title, attr: { id: titleId } });
    const list = section.createEl(pro.kind === "offer" ? "ul" : "div", {
      cls: "systemsculpt-agent-pro-rows",
      attr: pro.kind === "offer" ? { "aria-labelledby": titleId } : { role: "group", "aria-labelledby": titleId },
    });
    for (const row of pro.rows) {
      if (pro.kind === "offer") {
        const item = list.createEl("li", { cls: "systemsculpt-agent-pro-row", attr: { "data-capability": row.id } });
        setIcon(item.createSpan({ cls: "systemsculpt-agent-pro-icon", attr: { "aria-hidden": "true" } }), row.icon);
        item.createSpan({ cls: "systemsculpt-agent-pro-label", text: row.label });
        continue;
      }
      const button = createUiAction(list, {
        label: row.label,
        icon: row.icon,
        testId: `chat.empty.pro.${row.id}`,
        size: "small",
      });
      button.addClass("systemsculpt-agent-starter", "systemsculpt-agent-pro-try");
      button.dataset.capability = row.id;
      button.onclick = () => this.options.onAction(`try-${row.id}`);
    }
    if (pro.subscribe) {
      const subscribe = section.createEl("button", {
        cls: "systemsculpt-agent-empty-link systemsculpt-agent-pro-subscribe",
        text: pro.subscribe,
        attr: { type: "button", "data-testid": "chat.empty.pro.subscribe" },
      });
      subscribe.onclick = () => this.options.onAction("subscribe-pro");
    }
  }

  private renderNote(parent: HTMLElement, note: EmptyStateNote): void {
    const line = parent.createEl("p", {
      cls: "systemsculpt-agent-empty-note",
      attr: { "data-note": note.id },
    });
    line.appendText(note.text);
    if (!note.action) return;
    const action = note.action;
    line.appendText(" ");
    const link = line.createEl("button", {
      cls: "systemsculpt-agent-empty-link",
      text: action.label,
      attr: { type: "button", "data-testid": NOTE_ACTIONS[action.id].testId },
    });
    link.onclick = () => this.options.onAction(action.id);
    if (action.after) line.appendText(action.after);
  }
}
