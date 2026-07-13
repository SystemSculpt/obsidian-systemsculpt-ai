import { App } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";

export interface UpdateNotificationWarningResult {
  confirmed: boolean;
}

/** A small, explicit confirmation on the shared modal shell. */
export class UpdateNotificationWarningModal extends StandardModal {
  private result: UpdateNotificationWarningResult = { confirmed: false };
  private resolveResult: (value: UpdateNotificationWarningResult) => void = () => undefined;
  private settled = false;

  constructor(app: App) {
    super(app);
    this.setSize("small");
    this.modalEl.addClass("ss-update-warning-modal");
  }

  open(): Promise<UpdateNotificationWarningResult> {
    this.result = { confirmed: false };
    this.settled = false;
    return new Promise((resolve) => {
      this.resolveResult = resolve;
      super.open();
    });
  }

  onOpen(): void {
    super.onOpen();
    this.addTitle("Disable update notifications");
    this.contentEl.createEl("p", {
      cls: "ss-update-warning-modal__copy",
      text: "You won't be notified when fixes or Obsidian compatibility updates are available. You can turn notifications back on in settings.",
    });
    this.addActionButton("Cancel", () => this.close());
    const disable = this.addActionButton("Disable", () => {
      this.result = { confirmed: true };
      this.close();
    });
    disable.addClass("mod-warning");
  }

  onClose(): void {
    super.onClose();
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(this.result);
  }
}
