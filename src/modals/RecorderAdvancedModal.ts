import { App, DropdownComponent, Modal, Notice, Platform, Setting } from "obsidian";
import type SystemSculptPlugin from "../main";

type RecorderAdvancedContext = "audio" | "video";

interface RecorderAdvancedModalOptions {
  context?: RecorderAdvancedContext;
}

export class RecorderAdvancedModal extends Modal {
  private readonly plugin: SystemSculptPlugin;
  private readonly context: RecorderAdvancedContext;

  constructor(app: App, plugin: SystemSculptPlugin, options: RecorderAdvancedModalOptions = {}) {
    super(app);
    this.plugin = plugin;
    this.context = options.context ?? "audio";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ss-recorder-advanced-modal");

    contentEl.createEl("h2", { text: "Recorder Advanced Controls" });
    const contextLabel = this.context === "video" ? "Video recorder active" : "Audio recorder active";
    contentEl.createEl("p", {
      text: `${contextLabel}. Update capture behavior below without leaving your workflow.`,
      cls: "setting-item-description",
    });

    this.renderAudioSection(contentEl);
    if (Platform.isDesktopApp) {
      this.renderVideoSection(contentEl);
    }

    new Setting(contentEl)
      .setName("Open full recording settings")
      .setDesc("Jump to the Recording tab for the full settings panel.")
      .addButton((button) => {
        button
          .setButtonText("Open settings")
          .setCta()
          .onClick(() => {
            this.close();
            this.plugin.openSettingsTab("recorder");
          });
      });
  }

  private renderAudioSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Audio Recording" });
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
      "Apply your post-processing prompt after transcription.",
      this.plugin.settings.postProcessingEnabled,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ postProcessingEnabled: value });
      }
    );
  }

  private renderVideoSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Video Recording" });

    this.addToggleSetting(
      containerEl,
      "Show video button in chat",
      "Expose the Obsidian-window video record action in chat composer.",
      this.plugin.settings.showVideoRecordButtonInChat ?? true,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ showVideoRecordButtonInChat: value });
      }
    );

    this.addToggleSetting(
      containerEl,
      "Include system audio",
      "Capture desktop/system audio when runtime support is available.",
      this.plugin.settings.videoCaptureSystemAudio ?? false,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ videoCaptureSystemAudio: value });
      }
    );

    this.addToggleSetting(
      containerEl,
      "Include microphone audio",
      "Capture microphone/input audio in video recordings.",
      this.plugin.settings.videoCaptureMicrophoneAudio ?? false,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ videoCaptureMicrophoneAudio: value });
      }
    );

    this.addToggleSetting(
      containerEl,
      "Show permission guidance popup",
      "Show setup guidance before recording if permission flow help is needed.",
      this.plugin.settings.showVideoRecordingPermissionPopup !== false,
      async (value) => {
        await this.plugin.getSettingsManager().updateSettings({ showVideoRecordingPermissionPopup: value });
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

    const statusEl = setting.descEl.createDiv({ cls: "ss-recorder-advanced-modal__inline-note" });

    const loadDevices = async () => {
      if (!dropdownComponent || !dropdownEl) return;
      dropdownEl.innerHTML = "";
      dropdownComponent.addOption("default", "Default microphone");

      if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
        dropdownComponent.setValue("default");
        statusEl.setText("Microphone selection is unavailable in this runtime.");
        return;
      }

      try {
        statusEl.setText("Loading microphones...");
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasLabeledMics = devices.some((device) => device.kind === "audioinput" && !!device.label);
        if (!hasLabeledMics) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((track) => track.stop());
          } catch {
            statusEl.setText("Microphone permission not granted yet; showing generic device labels.");
          }
        }

        const refreshed = await navigator.mediaDevices.enumerateDevices();
        const microphones = refreshed.filter((device) => device.kind === "audioinput");
        microphones.forEach((mic) => {
          dropdownComponent?.addOption(mic.deviceId, mic.label || `Microphone ${mic.deviceId.slice(0, 8)}`);
        });

        const selected = this.plugin.settings.preferredMicrophoneId || "default";
        dropdownComponent.setValue(selected);
        statusEl.setText(microphones.length > 0 ? "" : "No microphones detected.");
      } catch (error: any) {
        statusEl.setText(`Unable to load microphones: ${error?.message || error}`);
      }
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
  plugin: SystemSculptPlugin,
  options?: RecorderAdvancedModalOptions
): void => {
  new RecorderAdvancedModal(app, plugin, options).open();
};
