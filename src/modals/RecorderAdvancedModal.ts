import { App, DropdownComponent, Notice, Setting } from "obsidian";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { getSurfaceOwnerWindow } from "../core/ui/surface/SurfaceDomContext";
import { MicrophoneDeviceCatalog } from "../services/recorder/MicrophoneDeviceCatalog";

export class RecorderAdvancedModal extends StandardModal {
  private readonly plugin: SystemSculptPlugin;
  private microphoneCatalog: MicrophoneDeviceCatalog | null = null;

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
    this.setSize("medium");
    this.modalEl.addClass("ss-recorder-advanced-modal-shell");
  }

  onOpen(): void {
    super.onOpen();
    const { contentEl } = this;
    contentEl.addClass("ss-recorder-advanced-modal");
    this.addTitle("Recorder controls");

    this.renderAudioSection(contentEl);
    this.addActionButton("Done", () => this.close());
    this.addActionButton("Open Settings", () => {
      this.close();
      this.plugin.openSettingsTab("workflow");
    }, true);
  }

  onClose(): void {
    this.microphoneCatalog?.dispose();
    this.microphoneCatalog = null;
    super.onClose();
  }

  private renderAudioSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Audio recording" });
    this.renderMicrophoneSetting(containerEl);

    this.addToggleSetting(
      containerEl,
      "Auto-transcribe recordings",
      "Start transcription immediately after recording stops.",
      this.plugin.settings.autoTranscribeRecordings,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ autoTranscribeRecordings: value });
      }
    );

    this.addToggleSetting(
      containerEl,
      "Auto-paste transcription",
      "Paste transcript output into the active note/chat context.",
      this.plugin.settings.autoPasteTranscription,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ autoPasteTranscription: value });
      }
    );

    this.addToggleSetting(
      containerEl,
      "Clean transcript output",
      "Remove timestamps/metadata and keep plain cleaned text.",
      this.plugin.settings.cleanTranscriptionOutput,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ cleanTranscriptionOutput: value });
      }
    );

    this.addToggleSetting(
      containerEl,
      "Auto-submit after transcription",
      "Automatically send the message when transcript cleanup finishes.",
      this.plugin.settings.autoSubmitAfterTranscription,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ autoSubmitAfterTranscription: value });
      }
    );

    this.addToggleSetting(
      containerEl,
      "Enable post-processing",
      "Apply SystemSculpt clean-up after transcription.",
      this.plugin.settings.postProcessingEnabled,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ postProcessingEnabled: value });
      }
    );
  }

  private addToggleSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    value: boolean,
    onChange: (value: boolean) => Promise<void>
  ): void {
    let currentValue = value;
    new Setting(containerEl).setName(name).setDesc(desc).addToggle((toggle) => {
      toggle.setValue(value).onChange(async (nextValue) => {
        try {
          await onChange(nextValue);
          currentValue = nextValue;
        } catch (error: any) {
          new Notice(`Unable to update setting: ${error?.message || error}`);
          toggle.setValue(currentValue);
        }
      });
    });
  }

  private renderMicrophoneSetting(containerEl: HTMLElement): void {
    this.microphoneCatalog?.dispose();
    const catalog = new MicrophoneDeviceCatalog(getSurfaceOwnerWindow(containerEl));
    this.microphoneCatalog = catalog;
    const setting = new Setting(containerEl)
      .setName("Preferred microphone")
      .setDesc("Select which microphone should be used for recordings.");

    let dropdownComponent: DropdownComponent | null = null;
    let dropdownEl: HTMLSelectElement | null = null;
    setting.addDropdown((dropdown) => {
      dropdownComponent = dropdown;
      dropdownEl = dropdown.selectEl;
      dropdown.addOption("default", "Default microphone");
      dropdown.setValue(this.plugin.settings.preferredMicrophoneId || "default");
      dropdown.onChange(async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ preferredMicrophoneId: value });
      });
    });

    const statusEl = setting.descEl.createDiv({
      cls: "ss-recorder-advanced-modal__inline-note",
      attr: { "aria-live": "polite" },
    });

    const loadDevices = async () => {
      if (!dropdownComponent || !dropdownEl) return;
      const task = this.beginAsyncTask("microphone-devices");
      dropdownEl.empty();
      dropdownComponent.addOption("default", "Default microphone");
      statusEl.setText("Loading microphones...");

      const result = await catalog.refresh(task.signal);
      if (!task.isCurrent() || this.microphoneCatalog !== catalog) return;
      if (result.status === "cancelled") return;
      if (result.status === "unavailable") {
        dropdownComponent.setValue("default");
        statusEl.setText("Microphone selection is unavailable in this runtime.");
        return;
      }
      if (result.status === "error") {
        dropdownComponent.setValue("default");
        statusEl.setText(`Unable to load microphones: ${result.message}`);
        return;
      }

      for (const microphone of result.devices) {
        dropdownComponent.addOption(microphone.id, microphone.label);
      }
      dropdownComponent.setValue(this.plugin.settings.preferredMicrophoneId || "default");
      statusEl.setText(
        result.devices.length === 0
          ? "No microphones detected."
          : result.labelRefresh === "denied"
            ? "Microphone permission not granted yet; showing generic device labels."
            : "",
      );
    };

    setting.addExtraButton((button) => {
      button
        .setIcon("refresh-cw")
        .setTooltip("Refresh microphones")
        .onClick(() => {
          void loadDevices();
        });
    });

    void loadDevices();
  }
}

export const openRecorderAdvancedModal = (
  app: App,
  plugin: SystemSculptPlugin
): void => {
  new RecorderAdvancedModal(app, plugin).open();
};
