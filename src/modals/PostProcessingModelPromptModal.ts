import { Notice } from "obsidian";
import SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";

interface PostProcessingModelPromptOptions {
  missingModelId: string;
  reason: string;
  /**
   * Whether the unavailable model is the managed SystemSculpt model. Managed
   * problems are about licensing/availability (fix in Account); a user-chosen
   * (BYOK) model is about provider config or picking another model (fix in
   * Recording settings). Defaults to managed for back-compat. (#97)
   */
  isManaged?: boolean;
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

  private isManaged(): boolean {
    // Back-compat: callers that don't specify treat the model as managed.
    return this.options.isManaged !== false;
  }

  private render(): void {
    const managed = this.isManaged();

    this.addTitle(
      "Transcription clean-up unavailable",
      managed
        ? "SystemSculpt transcription clean-up is unavailable right now."
        : "The post-processing model is unavailable right now."
    );

    const container = this.contentEl.createDiv({ cls: "ss-modal__stack" });
    container.createEl("p", { text: this.options.reason });

    const details = container.createEl("div", { cls: "ss-modal__callout" });
    details.createEl("p", {
      text: managed
        ? "SystemSculpt still handles transcription clean-up automatically, but you can change the clean-up prompt in Recording settings."
        : "Pick a different post-processing model, or fix the selected model's provider, in Recording settings.",
    });

    container.createEl("p", {
      text: managed
        ? "Open Account to fix license or availability problems, open Recording settings to adjust the prompt, or disable post-processing until SystemSculpt is available again."
        : "Open Recording settings to choose another model or fix the provider, or disable post-processing for now.",
      cls: "ss-modal__muted",
    });

    this.renderActions();
  }

  private renderActions(): void {
    const managed = this.isManaged();

    // For the managed model, licensing/availability is the likely fix, so
    // Account leads. For a user-chosen (BYOK) model, the model/provider lives in
    // Recording settings, so that leads and Account is irrelevant (#97).
    if (managed) {
      this.addActionButton(
        "Open Account",
        () => this.openAccountSetup(),
        true,
        "settings"
      );
    }

    this.addActionButton(
      "Open Recording Settings",
      () => this.openRecordingSettings(),
      !managed,
      "mic"
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

  private openAccountSetup(): void {
    this.plugin.openSettingsTab("account");
    this.close();
  }

  private openRecordingSettings(): void {
    this.plugin.openSettingsTab("workflow");
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
