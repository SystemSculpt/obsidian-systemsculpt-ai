import { Notice } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptModel } from "../types/llm";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import {
  ensureCanonicalId,
  getModelLabelWithProvider,
  parseCanonicalId,
} from "../utils/modelUtils";
import { StandardModelSelectionModal } from "./StandardModelSelectionModal";

type PromptScope = "global" | "post-processing";

interface PostProcessingModelPromptOptions {
  missingModelId: string;
  reason: string;
  alternativeModel?: SystemSculptModel;
  scope: PromptScope;
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
      "Fix transcription post-processing",
      "The configured model is unavailable. Choose an alternative so clean-up can continue."
    );

    const container = this.contentEl.createDiv({ cls: "ss-modal__stack" });
    container.createEl("p", { text: this.options.reason });

    const details = container.createEl("div", { cls: "ss-modal__callout" });
    const targetLabel = getModelLabelWithProvider(this.options.missingModelId);
    details.createEl("p", { text: `Requested model: ${targetLabel}` });

    if (this.options.scope === "global") {
      container.createEl("p", {
        text: "We'll update your default chat model so post-processing matches your active provider.",
        cls: "ss-modal__muted",
      });
    } else {
      container.createEl("p", {
        text: "We'll store a dedicated post-processing model so transcription clean-up can succeed even if your chat model changes.",
        cls: "ss-modal__muted",
      });
    }

    this.renderActions();
  }

  private renderActions(): void {
    const quickFixModelId = this.getQuickFixModelId();

    if (quickFixModelId) {
      const label = getModelLabelWithProvider(quickFixModelId);
      this.addActionButton(`Use ${label}`, () => {
        void this.applyModel(quickFixModelId);
      }, true, "check");
    }

    this.addActionButton(
      "Choose model…",
      () => this.openModelSelection(),
      !quickFixModelId,
      "sliders"
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

  private getQuickFixModelId(): string | undefined {
    if (this.options.alternativeModel?.id) {
      return this.options.alternativeModel.id;
    }

    if (this.options.scope === "post-processing") {
      return this.plugin.settings.selectedModelId || undefined;
    }

    return undefined;
  }

  private async applyModel(modelId: string): Promise<void> {
    const canonicalId = ensureCanonicalId(modelId);
    const parsed = parseCanonicalId(canonicalId);
    if (!parsed) {
      new Notice("Failed to update model. Please try again.", 4000);
      return;
    }

    try {
      if (this.options.scope === "global") {
        await this.plugin.getSettingsManager().updateSettings({ selectedModelId: canonicalId });
        new Notice(`Default chat model set to ${getModelLabelWithProvider(canonicalId)}.`, 4000);
      } else {
        await this.plugin.getSettingsManager().updateSettings({
          postProcessingProviderId: parsed.providerId,
          postProcessingModelId: canonicalId,
          postProcessingEnabled: true,
        });
        new Notice(`Post-processing will use ${getModelLabelWithProvider(canonicalId)}.`, 4000);
      }
    } catch (error) {
      new Notice("Unable to save changes. Open settings to update manually.", 5000);
      return;
    }

    this.close();
  }

  private openModelSelection(): void {
    const currentModelId =
      this.options.scope === "global"
        ? this.plugin.settings.selectedModelId || ""
        : this.plugin.settings.postProcessingModelId || this.plugin.settings.selectedModelId || "";

    const modal = new StandardModelSelectionModal({
      app: this.app,
      plugin: this.plugin,
      currentModelId,
      title:
        this.options.scope === "global"
          ? "Select default chat model"
          : "Select post-processing model",
      description:
        this.options.scope === "global"
          ? "Pick the chat model that should power both conversations and transcription clean-up."
          : "Choose the model you want to use when cleaning up transcriptions.",
      onSelect: (result) => {
        void this.applyModel(result.modelId);
      },
    });

    modal.open();
    this.close();
  }

  private async disablePostProcessing(): Promise<void> {
    try {
      await this.plugin.getSettingsManager().updateSettings({ postProcessingEnabled: false });
      new Notice("Transcription post-processing disabled. Re-enable it from Settings → Models when you're ready.", 5000);
      this.close();
    } catch (error) {
      new Notice("Unable to disable post-processing. Please try again from settings.", 5000);
    }
  }
}
