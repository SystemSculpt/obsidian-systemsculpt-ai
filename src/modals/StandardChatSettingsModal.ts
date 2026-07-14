import { App, Notice } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import {
  createUiRadioGroup,
  type UiRadioGroupHandle,
} from "../core/ui/surface/SurfaceRadioGroup";
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
  approvalModeDisabled?: boolean;
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
  disabled?: boolean;
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
  private radioGroups: UiRadioGroupHandle[] = [];
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
    this.destroyRadioGroups();
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
      disabled: this.options.approvalModeDisabled === true,
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

  onClose(): void {
    this.destroyRadioGroups();
    super.onClose();
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
      attr: { "aria-labelledby": titleId },
    });

    const bindings: Array<{ value: T; button: HTMLButtonElement }> = [];
    options.choices.forEach((choice) => {
      const selected = choice.value === options.value;
      const button = choices.createEl("button", {
        text: choice.label,
        cls: `ss-chat-settings__choice${selected ? " is-selected" : ""}`,
        attr: {
          type: "button",
          "data-value": choice.value,
        },
      });
      bindings.push({ value: choice.value, button });
    });

    this.radioGroups.push(createUiRadioGroup(choices, bindings, {
      value: options.value,
      labelledBy: titleId,
      disabled: options.disabled,
      onChange: async (value) => {
        await options.onSelect(value);
      },
      onError: (error) => {
        this.reportChangeFailure(error);
      },
    }));
  }

  private destroyRadioGroups(): void {
    this.radioGroups.forEach((group) => group.destroy());
    this.radioGroups = [];
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
