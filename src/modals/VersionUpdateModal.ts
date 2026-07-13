import { App } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";

export type VersionUpdateModalVariant = "available" | "updated";

export interface VersionUpdateModalOptions {
  currentVersion: string;
  latestVersion?: string;
  onPrimaryAction: () => void | Promise<void>;
  onClose?: () => void;
  variant: VersionUpdateModalVariant;
}

export class VersionUpdateModal extends StandardModal {
  private readonly options: VersionUpdateModalOptions;
  private settled = false;

  constructor(app: App, options: VersionUpdateModalOptions) {
    super(app);
    this.options = options;
    this.setSize("small");
    this.modalEl.addClass("ss-version-update-modal");
  }

  onOpen(): void {
    super.onOpen();
    const isAvailable = this.options.variant === "available";

    this.addTitle(isAvailable ? "Update available" : "SystemSculpt updated");

    const body = this.contentEl.createDiv({
      cls: "ss-modal__custom-content ss-modal__stack ss-version-update-modal__body",
    });
    body.createEl("p", {
      text: isAvailable
        ? `Version ${this.options.latestVersion} is available.`
        : "Update completed successfully.",
    });

    const versions = body.createDiv({
      cls: "ss-version-update-modal__versions",
      attr: {
        "aria-label": isAvailable ? "Version change" : "Current version",
      },
    });

    if (isAvailable) {
      versions.createSpan({
        cls: "ss-version-update-modal__version is-current",
        text: `v${this.options.currentVersion}`,
      });
      versions.createSpan({
        cls: "ss-version-update-modal__arrow",
        text: "→",
      });
      versions.createSpan({
        cls: "ss-version-update-modal__version is-latest",
        text: `v${this.options.latestVersion}`,
      });
    } else {
      versions.createSpan({
        cls: "ss-version-update-modal__version is-latest",
        text: `v${this.options.currentVersion}`,
      });
    }

    this.addActionButton(isAvailable ? "Not now" : "Close", () => this.close());
    this.addActionButton(
      isAvailable ? "Update" : "View changelog",
      () => {
        void this.options.onPrimaryAction();
        this.close();
      },
      true
    );
  }

  onClose(): void {
    super.onClose();
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.options.onClose?.();
  }
}
