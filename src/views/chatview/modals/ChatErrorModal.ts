import type { App } from "obsidian";
import { setIcon } from "obsidian";
import { StandardModal } from "../../../core/ui/modals/standard/StandardModal";

export interface ChatErrorModalOptions {
  app: App;
  title: string;
  message: string;
  description?: string;
  icon?: string;
  primaryActionLabel?: string;
  secondaryActionLabel?: string;
  onPrimaryAction?: () => void | Promise<void>;
}

// Prominent dismissable modal for chat errors that the user needs to read at
// their own pace (quota exhaustion, auth failure, model unavailable, etc).
// Replaces transient Notices for any error that is too important to flash by.
export class ChatErrorModal extends StandardModal {
  private readonly options: ChatErrorModalOptions;

  constructor(options: ChatErrorModalOptions) {
    super(options.app);
    this.options = options;
  }

  onOpen(): void {
    super.onOpen();
    this.setSize("medium");
    this.modalEl.addClass("ss-chat-error-modal");

    this.addTitle(this.options.title, this.options.description);

    const body = this.contentEl.createDiv({ cls: "ss-chat-error-modal__body" });

    if (this.options.icon) {
      const iconWrap = body.createDiv({ cls: "ss-chat-error-modal__icon" });
      setIcon(iconWrap, this.options.icon);
    }

    body.createDiv({
      cls: "ss-chat-error-modal__message",
      text: this.options.message,
    });

    if (this.options.onPrimaryAction && this.options.primaryActionLabel) {
      this.addActionButton(
        this.options.primaryActionLabel,
        async () => {
          this.close();
          try {
            await this.options.onPrimaryAction!();
          } catch {}
        },
        true,
      );
    }

    this.addActionButton(
      this.options.secondaryActionLabel ?? "Dismiss",
      () => this.close(),
      !this.options.onPrimaryAction,
    );
  }
}
