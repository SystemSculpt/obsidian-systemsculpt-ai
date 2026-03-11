import { Notice } from "obsidian";
import SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";

interface PostProcessingModelPromptOptions {
  missingModelId: string;
  reason: string;
  onClose?: () => void;
}

export class PostProcessingModelPromptModal extends StandardModal {
  constructor(
    private plugin: SystemSculptPlugin,
    private options: PostProcessingModelPromptOptions
  ) {
    super(plugin.app);
    this.setSize("medium");
  }

  onOpen(): void {
    super.onOpen();
    this.render();
  }

  onClose(): void {
    super.onClose();
    this.options.onClose?.();
  }

  private render(): void {
    this.addTitle(
      "Transcription clean-up unavailable",
      "SystemSculpt transcription clean-up is unavailable right now."
    );

    const container = this.contentEl.createDiv({ cls: "ss-modal__stack" });
    container.createEl("p", { text: this.options.reason });

    const details = container.createEl("div", { cls: "ss-modal__callout" });
    details.createEl("p", {
      text: "SystemSculpt handles transcription clean-up automatically, so there is nothing to change here in the plugin.",
    });

    container.createEl("p", {
      text: "Open Account to check your license, or disable post-processing until SystemSculpt is available again.",
      cls: "ss-modal__muted",
    });

    this.renderActions();
  }

  private renderActions(): void {
    this.addActionButton(
      "Open Account",
      () => this.openSetup(),
      true,
      "settings"
    );

    this.addActionButton(
      "Disable post-processing",
      () => {
        void this.disablePostProcessing();
      },
      false,
      "slash"
    );

    this.addActionButton("Later", () => this.close(), false, "x");
  }

  private openSetup(): void {
    this.plugin.openSettingsTab("account");
    this.close();
  }

  private async disablePostProcessing(): Promise<void> {
    try {
      await this.plugin.getSettingsManager().updateSettings({ postProcessingEnabled: false });
      new Notice("Transcription post-processing disabled. Re-enable it from Settings when you're ready.", 5000);
      this.close();
    } catch (error) {
      new Notice("Unable to disable post-processing. Please try again from settings.", 5000);
    }
  }
}
