import type { App } from "obsidian";
import { createUiAction, updateUiAction } from "../../core/ui/surface";
import type { PhoneHandoffItem } from "../../features/phone-captures/PhoneHandoffInbox";
import { hasHostCapability } from "../../platform/hostCapabilities";

export type PhoneHandoffPresentation = PhoneHandoffItem;

type Options = {
  container: HTMLElement;
  app: App;
  onRun: (id: string) => void | Promise<void>;
  onOpenSource: (path: string) => void | Promise<void>;
};

type Card = {
  item: PhoneHandoffPresentation;
  element: HTMLElement;
  agent: HTMLElement;
  state: HTMLElement;
  instruction: HTMLElement;
  summary: HTMLElement;
  source: HTMLElement;
  sourceLink: HTMLAnchorElement;
  unavailable: HTMLElement;
  message: HTMLElement;
  hostNotice: HTMLElement;
  error: HTMLElement;
  actions: HTMLElement;
  run: HTMLButtonElement;
  resultLink: HTMLAnchorElement;
  submitting: boolean;
};

const AGENT_LABELS: Record<PhoneHandoffPresentation["agent"], string> = {
  systemsculpt: "SystemSculpt AI",
  claude_code: "Claude Code",
  codex: "Codex",
};
const STATE_LABELS: Record<PhoneHandoffPresentation["state"], string> = {
  pending: "Ready to run",
  starting: "Starting",
  running: "Running",
  needs_approval: "Approval needed",
  completed: "Completed",
  failed: "Failed",
};

function setText(element: HTMLElement, text: string): void {
  // Unchanged text retains selection and does not reannounce on every inbox refresh.
  if (element.textContent !== text) element.textContent = text;
}

let handoffHeadingSequence = 0;

/** Presents inbox snapshots inside an existing PluginSurface; never owns execution. */
export class AgentPhoneHandoffCards {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly cards = new Map<string, Card>();
  private destroyed = false;

  constructor(private readonly options: Options) {
    const headingId = `systemsculpt-phone-handoffs-${++handoffHeadingSequence}`;
    this.root = options.container.createEl("section", {
      cls: "systemsculpt-agent-phone-handoffs",
      attr: { "aria-labelledby": headingId, hidden: "" },
    });
    this.root.createDiv({
      cls: "systemsculpt-agent-phone-handoffs-heading", text: "From your iPhone",
      attr: { id: headingId, role: "heading", "aria-level": "3" },
    });
    this.list = this.root.createDiv();
  }

  render(items: readonly PhoneHandoffPresentation[]): void {
    if (this.destroyed) return;
    const owner = this.root.ownerDocument;
    const focused = owner.activeElement as HTMLElement | null;
    const hadFocus = focused !== null && this.root.contains(focused);
    const ids = new Set(items.map(item => item.id));
    for (const [id, card] of this.cards) {
      if (!ids.has(id)) {
        this.remove(card);
        this.cards.delete(id);
      }
    }
    let previous: HTMLElement | null = null;
    for (const item of items) {
      let card = this.cards.get(item.id);
      if (!card) {
        card = this.create(item);
        this.cards.set(item.id, card);
      }
      if (card.item.state !== item.state) this.showError(card, "");
      card.item = item;
      this.update(card);
      const next: Element | null = previous ? previous.nextElementSibling : this.list.firstElementChild;
      if (next !== card.element) this.list.insertBefore(card.element, next);
      previous = card.element;
    }
    this.root.hidden = items.length === 0;
    // Reordering a retained node can blur it. Restore only that focus, never take
    // focus from the composer or another surface, and never scroll on refresh.
    if (hadFocus && focused && this.root.contains(focused) && owner.activeElement === owner.body
      && !focused.closest("[hidden]") && !focused.hasAttribute("disabled")) {
      focused.focus({ preventScroll: true });
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const card of this.cards.values()) this.remove(card);
    this.cards.clear();
    this.root.remove();
  }

  private create(item: PhoneHandoffPresentation): Card {
    const element = this.list.createEl("article", { cls: "systemsculpt-agent-phone-handoff" });
    element.dataset.handoffId = item.id;
    const header = element.createDiv({ cls: "systemsculpt-agent-phone-handoff-header" });
    const agent = header.createSpan({ cls: "systemsculpt-agent-phone-handoff-agent" });
    const state = header.createSpan({
      cls: "systemsculpt-agent-phone-handoff-state",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });
    const instruction = element.createDiv({ cls: "systemsculpt-agent-phone-handoff-instruction" });
    const details = element.createEl("details", { cls: "systemsculpt-agent-phone-handoff-details" });
    const summary = details.createEl("summary", { attr: { "data-testid": "chat.phone-handoff.details" } });
    const unavailable = details.createDiv({ cls: "systemsculpt-agent-phone-handoff-unavailable" });
    // Full, inert Markdown is the review evidence. Do not render embeds, execute
    // source HTML, or fetch remote content simply because a handoff arrived.
    const source = details.createEl("pre", { cls: "systemsculpt-agent-phone-handoff-source" });
    const sourceLink = details.createEl("a", {
      cls: "systemsculpt-agent-phone-handoff-link",
      attr: { href: "#", "data-testid": "chat.phone-handoff.source" },
    });
    const message = element.createDiv({ cls: "systemsculpt-agent-phone-handoff-message" });
    const hostNotice = element.createDiv({ cls: "systemsculpt-agent-phone-handoff-message" });
    const actions = element.createDiv({ cls: "systemsculpt-agent-phone-handoff-actions" });
    const run = createUiAction(actions, {
      label: "Run", testId: "chat.phone-handoff.run", tone: "primary", size: "small", tooltip: false,
    });
    const resultLink = actions.createEl("a", {
      cls: "systemsculpt-agent-phone-handoff-link",
      attr: { href: "#", "data-testid": "chat.phone-handoff.result" },
    });
    const error = element.createDiv({ cls: "systemsculpt-agent-phone-handoff-error", attr: { role: "alert", hidden: "" } });
    const card: Card = { item, element, agent, state, instruction, summary, source, sourceLink, unavailable, message, hostNotice, error, actions, run, resultLink, submitting: false };
    run.onclick = () => { void this.run(card); };
    sourceLink.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      void this.open(card, card.item.source?.path);
    };
    resultLink.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      if (card.item.state === "completed") void this.open(card, card.item.resultPath);
    };
    return card;
  }

  private update(card: Card): void {
    const { item } = card;
    card.element.dataset.state = item.state;
    card.element.setAttribute("aria-label", `iPhone handoff · ${AGENT_LABELS[item.agent]}`);
    setText(card.agent, AGENT_LABELS[item.agent]);
    setText(card.state, STATE_LABELS[item.state]);
    setText(card.instruction, item.instruction);
    setText(card.summary, item.source ? `Source · ${item.source.title}` : "Source unavailable");
    setText(card.unavailable, item.source ? "" : "Run is available once the full source is loaded.");
    card.unavailable.hidden = Boolean(item.source);
    setText(card.source, item.source?.markdown ?? "");
    card.source.hidden = !item.source;
    card.sourceLink.hidden = !item.source?.path;
    setText(card.sourceLink, item.source?.path ? `Open source · ${item.source.path}` : "");
    setText(card.message, item.message ?? "");
    card.message.hidden = !item.message;
    const supported = this.supportsAgent(card);
    setText(card.hostNotice, item.state === "pending" && !supported ? `Open this handoff on a computer with ${AGENT_LABELS[item.agent]}.` : "");
    card.hostNotice.hidden = item.state !== "pending" || supported;
    card.run.hidden = item.state !== "pending" || !supported;
    updateUiAction(card.run, { disabled: card.run.hidden || !item.source || card.submitting, busy: card.submitting });
    card.resultLink.hidden = item.state !== "completed" || !item.resultPath;
    card.actions.hidden = card.run.hidden && card.resultLink.hidden;
    setText(card.resultLink, item.state === "completed" && item.resultPath ? `Open result · ${item.resultPath}` : "");
  }

  private supportsAgent(card: Card): boolean {
    return card.item.agent === "systemsculpt" || hasHostCapability("local-cli", card.element);
  }

  private mounted(card: Card): boolean {
    return !this.destroyed && this.cards.get(card.item.id) === card;
  }

  private async run(card: Card): Promise<void> {
    if (!this.mounted(card) || card.item.state !== "pending" || !card.item.source || card.submitting || !this.supportsAgent(card)) return;
    card.submitting = true;
    this.showError(card, "");
    this.update(card);
    try {
      await this.options.onRun(card.item.id);
    } catch {
      if (this.mounted(card) && card.item.state === "pending") {
        this.showError(card, "Could not start this handoff. Try Run again.");
      }
    } finally {
      if (this.mounted(card)) {
        card.submitting = false;
        this.update(card);
      }
    }
  }

  private async open(card: Card, path: string | null | undefined): Promise<void> {
    if (!this.mounted(card) || !path) return;
    this.showError(card, "");
    try {
      await this.options.onOpenSource(path);
    } catch {
      if (this.mounted(card)) this.showError(card, "Could not open this note. It may have moved or been removed.");
    }
  }

  private showError(card: Card, message: string): void {
    setText(card.error, message);
    card.error.hidden = !message;
  }

  private remove(card: Card): void {
    card.run.onclick = null;
    card.sourceLink.onclick = null;
    card.resultLink.onclick = null;
    card.element.remove();
  }
}
