import { setIcon } from "obsidian";

export interface ChatStatusChipSpec {
  label: string;
  value: string;
  icon: string;
}

export interface ChatStatusActionSpec {
  label: string;
  icon: string;
  onClick?: () => void | Promise<void>;
  primary?: boolean;
  title?: string;
}

export interface ChatStatusPanelSpec {
  eyebrow: string;
  title: string;
  description?: string;
  chips: readonly ChatStatusChipSpec[];
  actions: readonly ChatStatusActionSpec[];
  note?: string;
}

export type ChatStatusRegisterDomEvent = <
  K extends keyof HTMLElementEventMap
>(
  el: HTMLElement,
  type: K | string,
  callback: (event: Event) => void
) => void;

const bindAction = (
  button: HTMLButtonElement,
  action: ChatStatusActionSpec,
  registerDomEvent?: ChatStatusRegisterDomEvent
) => {
  if (!action.onClick) {
    return;
  }

  const handler = async (event: Event) => {
    event.preventDefault();
    await action.onClick?.();
  };

  if (registerDomEvent) {
    registerDomEvent(button, "click", handler);
    return;
  }

  button.addEventListener("click", handler as EventListener);
};

export function renderChatStatusSurface(
  container: HTMLElement,
  spec: ChatStatusPanelSpec,
  options?: {
    registerDomEvent?: ChatStatusRegisterDomEvent;
  }
): void {
  container.empty();

  container.createDiv({
    cls: "systemsculpt-chat-status-eyebrow",
    text: spec.eyebrow,
  });

  container.createEl("h3", {
    cls: "systemsculpt-chat-status-title",
    text: spec.title,
  });

  if (spec.description) {
    container.createEl("p", {
      cls: "systemsculpt-chat-status-description",
      text: spec.description,
    });
  }

  const summary = container.createDiv({ cls: "systemsculpt-chat-status-summary" });
  spec.chips.forEach((chip) => {
    const chipEl = summary.createDiv({ cls: "systemsculpt-chat-status-chip" });
    const iconEl = chipEl.createSpan({ cls: "systemsculpt-chat-status-chip-icon" });
    setIcon(iconEl, chip.icon);
    chipEl.createSpan({ cls: "systemsculpt-chat-status-chip-label", text: chip.label });
    chipEl.createSpan({ cls: "systemsculpt-chat-status-chip-value", text: chip.value });
  });

  const actions = container.createDiv({ cls: "systemsculpt-chat-status-actions" });
  spec.actions.forEach((action) => {
    const button = actions.createEl("button", {
      cls: `systemsculpt-chat-status-action${action.primary ? " mod-cta" : ""}`,
      attr: {
        type: "button",
      },
    }) as HTMLButtonElement;
    if (action.title) {
      button.setAttr("title", action.title);
    }
    const iconEl = button.createSpan({ cls: "systemsculpt-chat-status-action-icon" });
    setIcon(iconEl, action.icon);
    button.createSpan({
      cls: "systemsculpt-chat-status-action-label",
      text: action.label,
    });
    bindAction(button, action, options?.registerDomEvent);
  });

  if (spec.note) {
    container.createEl("p", {
      cls: "systemsculpt-chat-status-note",
      text: spec.note,
    });
  }
}
