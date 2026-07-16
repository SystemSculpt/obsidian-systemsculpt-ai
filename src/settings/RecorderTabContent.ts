import { Setting, Notice, DropdownComponent } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { DEFAULT_SETTINGS } from "../types";
import { getSurfaceOwnerWindow } from "../core/ui/surface/SurfaceDomContext";
import { MicrophoneDeviceCatalog } from "../services/recorder/MicrophoneDeviceCatalog";

interface RecorderTabRenderScope {
  catalog: MicrophoneDeviceCatalog;
  isCurrent(): boolean;
  dispose(): void;
}

const activeRecorderTabRenders = new WeakMap<SystemSculptSettingTab, RecorderTabRenderScope>();

function beginRecorderTabRender(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab,
): RecorderTabRenderScope {
  activeRecorderTabRenders.get(tabInstance)?.dispose();

  const catalog = new MicrophoneDeviceCatalog(getSurfaceOwnerWindow(containerEl), {
    requestLabels: false,
  });
  let active = true;
  let unregisterCleanup: () => void = () => undefined;
  const scope: RecorderTabRenderScope = {
    catalog,
    isCurrent: () => active && activeRecorderTabRenders.get(tabInstance) === scope,
    dispose: () => {
      if (!active) return;
      active = false;
      catalog.dispose();
      if (activeRecorderTabRenders.get(tabInstance) === scope) {
        activeRecorderTabRenders.delete(tabInstance);
      }
      unregisterCleanup();
    },
  };
  activeRecorderTabRenders.set(tabInstance, scope);
  unregisterCleanup = tabInstance.registerRenderCleanup(() => scope.dispose());
  return scope;
}

export async function displayRecorderTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  const renderScope = beginRecorderTabRender(containerEl, tabInstance);
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "workflow";
  }
  const { plugin } = tabInstance;

  containerEl.createEl("h3", { text: "Recording" });

  const microphoneDevicesReady = renderMicrophoneSetting(containerEl, tabInstance, renderScope);

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
    .setDesc("Clean up the transcription with an LLM after it completes.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.postProcessingEnabled)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ postProcessingEnabled: value });
        });
    });

  let postProcessingPromptText: HTMLTextAreaElement | null = null;
  new Setting(containerEl)
    .setName("Transcription clean-up prompt")
    .setDesc("Optional. Adjust the instructions used for the transcription clean-up step.")
    .addTextArea((text) => {
      postProcessingPromptText = text.inputEl;
      text
        .setPlaceholder(DEFAULT_SETTINGS.postProcessingPrompt)
        .setValue(plugin.settings.postProcessingPrompt || DEFAULT_SETTINGS.postProcessingPrompt)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({
            postProcessingPrompt: value || DEFAULT_SETTINGS.postProcessingPrompt,
          });
        });
      text.inputEl.rows = 8;
      text.inputEl.addClass("ss-settings-textarea");
    })
    .addButton((button) => {
      button
        .setButtonText("Reset prompt")
        .onClick(async () => {
          await plugin.getSettingsManager().updateSettings({
            postProcessingPrompt: DEFAULT_SETTINGS.postProcessingPrompt,
          });
          if (postProcessingPromptText) {
            postProcessingPromptText.value = DEFAULT_SETTINGS.postProcessingPrompt;
          }
          new Notice("Transcription clean-up prompt reset.");
        });
    });

  containerEl.createEl("h3", { text: "Transcription" });

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

  await microphoneDevicesReady;
}

function renderMicrophoneSetting(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab,
  renderScope: RecorderTabRenderScope,
): Promise<void> {
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

  const statusEl = setting.descEl.createDiv({
    cls: "ss-inline-note",
    attr: { "aria-live": "polite" },
  });

  const loadDevices = async (requestLabelPermission = false) => {
    if (!renderScope.isCurrent() || !dropdownComponent || !dropdownEl) return;
    dropdownEl.empty();
    const dropdown = dropdownComponent;
    const addOption = (value: string, label: string) => {
      dropdown.addOption(value, label);
    };

    addOption("default", "Default microphone");
    statusEl.setText("Loading microphones...");
    const result = requestLabelPermission
      ? await renderScope.catalog.refreshWithLabelPermission()
      : await renderScope.catalog.refresh();
    if (!renderScope.isCurrent() || result.status === "cancelled") return;
    if (result.status === "unavailable") {
      dropdown.setValue(plugin.settings.preferredMicrophoneId || "default");
      statusEl.setText("Microphone selection unavailable in this environment.");
      return;
    }
    if (result.status === "error") {
      statusEl.setText(`Unable to load microphones: ${result.message}`);
      dropdown.setValue("default");
      return;
    }

    for (const microphone of result.devices) {
      addOption(microphone.id, microphone.label);
    }
    dropdown.setValue(plugin.settings.preferredMicrophoneId || "default");
    statusEl.setText(
      result.devices.length === 0
        ? "No microphones detected."
        : result.labelRefresh === "denied"
          ? "Microphone access denied; using default device list."
          : "",
    );
  };

  setting.addExtraButton((button) => {
    button
      .setIcon("refresh-cw")
      .setTooltip("Refresh microphones")
      .onClick(() => {
        void loadDevices(true);
      });
  });
  return loadDevices();
}
