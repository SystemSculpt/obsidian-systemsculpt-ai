import { App, Setting, Notice, DropdownComponent } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { PlatformContext } from "../services/PlatformContext";

export async function displayRecorderTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "workflow";
  }
  const { plugin } = tabInstance;
  const isMobile = PlatformContext.get().isMobile();

  containerEl.createEl("h3", { text: "Recording" });

  await renderMicrophoneSetting(containerEl, tabInstance);

  new Setting(containerEl)
    .setName("Auto-transcribe recordings")
    .setDesc("Transcribe recordings automatically when they finish.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoTranscribeRecordings)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoTranscribeRecordings: value });
        });
    });

  new Setting(containerEl)
    .setName("Auto-paste transcription")
    .setDesc("Paste the transcription into the active document when it completes.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoPasteTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoPasteTranscription: value });
        });
    });

  new Setting(containerEl)
    .setName("Keep recordings after transcription")
    .setDesc("Retain the source audio file after a successful transcription.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.keepRecordingsAfterTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ keepRecordingsAfterTranscription: value });
        });
    });

  new Setting(containerEl)
    .setName("Clean output only")
    .setDesc("Strip timestamps and metadata from transcription output.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.cleanTranscriptionOutput)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ cleanTranscriptionOutput: value });
        });
    });

  new Setting(containerEl)
    .setName("Auto-submit after transcription")
    .setDesc("Send the message automatically once transcription or post-processing finishes in chat views.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoSubmitAfterTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoSubmitAfterTranscription: value });
        });
    });

  new Setting(containerEl)
    .setName("Enable post-processing")
    .setDesc("Apply SystemSculpt clean-up after transcription completes.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.postProcessingEnabled)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ postProcessingEnabled: value });
        });
    });

  containerEl.createEl("h3", { text: "Transcription" });

  new Setting(containerEl)
    .setName("Transcription execution")
    .setDesc("Recordings always transcribe through SystemSculpt so desktop and mobile stay on the same path.");

  new Setting(containerEl)
    .setName("Default transcription output format")
    .setDesc("Choose whether transcriptions are saved as Markdown (.md) or SRT (.srt) by default.")
    .addDropdown((dropdown) => {
      dropdown
        .addOption("markdown", "Markdown (.md)")
        .addOption("srt", "SRT subtitle file (.srt)")
        .setValue(plugin.settings.transcriptionOutputFormat ?? "markdown")
        .onChange(async (value: "markdown" | "srt") => {
          await plugin.getSettingsManager().updateSettings({ transcriptionOutputFormat: value });
        });
    });

  new Setting(containerEl)
    .setName("Show output format chooser in transcribe modal")
    .setDesc('Keep the Markdown/SRT picker visible in the modal. Re-enable this here if you selected "Do not show this again".')
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.showTranscriptionFormatChooserInModal ?? true)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ showTranscriptionFormatChooserInModal: value });
        });
    });

  containerEl.createEl("p", {
    text: "Tip: You can always change transcription output format and modal behavior here.",
    cls: "setting-item-description",
  });

  if (!isMobile) {
    new Setting(containerEl)
      .setName("Automatic audio format conversion")
      .setDesc("Convert incompatible audio files before transcription.")
      .addToggle((toggle) => {
        toggle
          .setValue(plugin.settings.enableAutoAudioResampling ?? true)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({ enableAutoAudioResampling: value });
            new Notice(value ? "Audio conversion enabled" : "Audio conversion disabled");
          });
      });
  }
}

async function renderMicrophoneSetting(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  const { plugin } = tabInstance;

  const setting = new Setting(containerEl)
    .setName("Preferred microphone")
    .setDesc("Select which microphone to use for recordings.");

  let dropdownComponent: DropdownComponent | null = null;
  let dropdownEl: HTMLSelectElement | null = null;
  setting.addDropdown((dropdown) => {
    dropdownComponent = dropdown;
    dropdownEl = dropdown.selectEl;
    dropdown.addOption("default", "Default microphone");
    dropdown.setValue(plugin.settings.preferredMicrophoneId || "default");

    dropdown.onChange(async (value) => {
      await plugin.getSettingsManager().updateSettings({ preferredMicrophoneId: value });
      const label = dropdown.selectEl?.selectedOptions[0]?.text || value;
      new Notice(`Microphone preference saved: ${label}`);
    });
  });

  const statusEl = setting.descEl.createDiv({ cls: "ss-inline-note" });

  const loadDevices = async () => {
    if (!dropdownComponent || !dropdownEl) return;
    dropdownEl.innerHTML = "";
    const dropdown = dropdownComponent;
    const addOption = (value: string, label: string) => {
      dropdown.addOption(value, label);
    };

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      addOption("default", "Default microphone");
      dropdown.setValue(plugin.settings.preferredMicrophoneId || "default");
      statusEl.setText("Microphone selection unavailable in this environment.");
      return;
    }

    try {
      statusEl.setText("Loading microphones...");
      const devices = await navigator.mediaDevices.enumerateDevices();
      const labeled = devices.some((device) => device.kind === "audioinput" && device.label);
      if (!labeled) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
        } catch (_error: any) {
          statusEl.setText("Microphone access denied; using default device list.");
        }
      }

      const refreshed = await navigator.mediaDevices.enumerateDevices();
      const microphones = refreshed.filter((device) => device.kind === "audioinput");

      addOption("default", "Default microphone");
      microphones.forEach((mic) => {
        addOption(mic.deviceId, mic.label || `Microphone ${mic.deviceId.slice(0, 8)}`);
      });

      const current = plugin.settings.preferredMicrophoneId || "default";
      dropdown.setValue(current);
      statusEl.setText(microphones.length ? "" : "No microphones detected.");
    } catch (error: any) {
      statusEl.setText(`Unable to load microphones: ${error?.message || error}`);
      addOption("default", "Default microphone");
      dropdown.setValue("default");
    }
  };

  setting.addExtraButton((button) => {
    button
      .setIcon("refresh-cw")
      .setTooltip("Refresh microphones")
      .onClick(() => {
        loadDevices();
      });
  });
  await loadDevices();
}
