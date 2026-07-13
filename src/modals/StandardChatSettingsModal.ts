import { App, Notice } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import type { ChatApprovalMode } from "../views/chatview/storage/ChatPersistenceTypes";

export type ChatFontSize = "small" | "medium" | "large";

export interface ChatSettingsValues {
  approvalMode: ChatApprovalMode;
  chatFontSize: ChatFontSize;
}

export type ChatSettingsChange =
  | { kind: "approval-mode"; value: ChatApprovalMode }
  | { kind: "font-size"; value: ChatFontSize };

export interface ChatSettingsModalOptions {
  initialValues: ChatSettingsValues;
  onChange: (change: ChatSettingsChange) => void | Promise<void>;
}

interface Choice<T extends string> {
  value: T;
  label: string;
}

interface ChoiceGroupOptions<T extends string> {
  id: string;
  title: string;
  description?: string;
  value: T;
  choices: readonly Choice<T>[];
  onSelect: (value: T) => void | Promise<void>;
}

let nextModalId = 0;

/**
 * Per-chat preferences with live application semantics. The modal owns only
 * presentation state; persistence stays behind the caller's onChange seam.
 */
export class StandardChatSettingsModal extends StandardModal {
  private readonly options: ChatSettingsModalOptions;
  private readonly controlIdPrefix: string;
  private values: ChatSettingsValues;

  constructor(app: App, options: ChatSettingsModalOptions) {
    super(app);
    this.options = options;
    this.values = { ...options.initialValues };
    this.controlIdPrefix = `ss-chat-settings-${++nextModalId}`;
    this.setSize("small");
    this.modalEl.addClass("ss-chat-settings-modal");
  }

  onOpen(): void {
    super.onOpen();
    this.addTitle("Chat settings");

    const settingsEl = this.contentEl.createDiv({ cls: "ss-chat-settings" });

    this.createChoiceGroup(settingsEl, {
      id: "approval",
      title: "Tool access",
      value: this.values.approvalMode,
      choices: [
        { value: "ask", label: "Ask Approval" },
        { value: "full-access", label: "Full Access" },
      ],
      onSelect: async (approvalMode) => {
        await this.applyChange({ kind: "approval-mode", value: approvalMode });
        this.values.approvalMode = approvalMode;
      },
    });

    this.createChoiceGroup(settingsEl, {
      id: "font-size",
      title: "Text size",
      value: this.values.chatFontSize,
      choices: [
        { value: "small", label: "Small" },
        { value: "medium", label: "Medium" },
        { value: "large", label: "Large" },
      ],
      onSelect: async (chatFontSize) => {
        await this.applyChange({ kind: "font-size", value: chatFontSize });
        this.values.chatFontSize = chatFontSize;
      },
    });

    this.addActionButton("Done", () => this.close(), true);
  }

  private createChoiceGroup<T extends string>(
    container: HTMLElement,
    options: ChoiceGroupOptions<T>
  ): void {
    const titleId = `${this.controlIdPrefix}-${options.id}-title`;
    const section = container.createEl("section", {
      cls: "ss-chat-settings__row",
      attr: { "aria-labelledby": titleId },
    });
    const copy = section.createDiv({ cls: "ss-chat-settings__copy" });
    copy.createEl("h3", {
      text: options.title,
      cls: "ss-chat-settings__label",
      attr: { id: titleId },
    });
    if (options.description) {
      copy.createDiv({
        text: options.description,
        cls: "ss-chat-settings__description",
      });
    }

    const choices = section.createDiv({
      cls: "ss-chat-settings__choices",
      attr: {
        role: "radiogroup",
        "aria-labelledby": titleId,
      },
    });

    const buttons: HTMLButtonElement[] = [];
    let committedValue = options.value;
    let pending = false;
    options.choices.forEach((choice) => {
      const selected = choice.value === options.value;
      const button = choices.createEl("button", {
        text: choice.label,
        cls: `ss-chat-settings__choice${selected ? " is-selected" : ""}`,
        attr: {
          type: "button",
          role: "radio",
          "aria-checked": String(selected),
          "data-value": choice.value,
          tabindex: selected ? "0" : "-1",
        },
      });
      buttons.push(button);

      this.registerDomEvent(button, "click", () => {
        if (pending || choice.value === committedValue) return;
        const previousValue = committedValue;
        pending = true;
        this.selectChoice(choices, choice.value);
        this.setChoiceGroupPending(choices, buttons, true);
        let change: void | Promise<void>;
        try {
          change = options.onSelect(choice.value);
        } catch (error) {
          this.selectChoice(choices, previousValue);
          this.reportChangeFailure(error);
          pending = false;
          this.setChoiceGroupPending(choices, buttons, false);
          return;
        }
        void Promise.resolve(change).then(() => {
          committedValue = choice.value;
        }).catch((error) => {
          this.selectChoice(choices, previousValue);
          this.reportChangeFailure(error);
        }).finally(() => {
          pending = false;
          this.setChoiceGroupPending(choices, buttons, false);
        });
      });

      this.registerDomEvent(button, "keydown", (event: KeyboardEvent) => {
        const currentIndex = buttons.indexOf(button);
        let nextIndex: number | null = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          nextIndex = (currentIndex + 1) % buttons.length;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = buttons.length - 1;
        }
        if (nextIndex === null) return;
        event.preventDefault();
        buttons[nextIndex]?.click();
        buttons[nextIndex]?.focus();
      });
    });
  }

  private selectChoice(group: HTMLElement, value: string): void {
    group.querySelectorAll<HTMLButtonElement>(".ss-chat-settings__choice").forEach((button) => {
      const selected = button.dataset.value === value;
      button.toggleClass("is-selected", selected);
      button.setAttr("aria-checked", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }

  private setChoiceGroupPending(
    group: HTMLElement,
    buttons: readonly HTMLButtonElement[],
    pending: boolean,
  ): void {
    if (pending) group.setAttr("aria-busy", "true");
    else group.removeAttribute("aria-busy");
    buttons.forEach((button) => { button.disabled = pending; });
  }

  private async applyChange(change: ChatSettingsChange): Promise<void> {
    await this.options.onChange(change);
  }

  private reportChangeFailure(error: unknown): void {
    console.error("Unable to apply chat setting", error);
    new Notice("Couldn't update chat settings.", 4000);
  }
}

export function showStandardChatSettingsModal(
  app: App,
  options: ChatSettingsModalOptions
): StandardChatSettingsModal {
  const modal = new StandardChatSettingsModal(app, options);
  modal.open();
  return modal;
}
