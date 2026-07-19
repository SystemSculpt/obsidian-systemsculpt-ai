import { Setting, Notice, DropdownComponent, type ToggleComponent } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { DEFAULT_SETTINGS } from "../types";
import { getSurfaceOwnerWindow } from "../core/ui/surface/SurfaceDomContext";
import { MicrophoneDeviceCatalog } from "../services/recorder/MicrophoneDeviceCatalog";
import {
  getCurrentHostPreferredMicrophoneId,
  setCurrentHostPreferredMicrophoneId,
} from "../services/recorder/RecorderPreferenceStore";

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

export async function displayRecorderTabContent(
  containerEl: HTMLElement,
  tabInstance: SystemSculptSettingTab,
) {
  containerEl.empty();
  const renderScope = beginRecorderTabRender(containerEl, tabInstance);
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "workflow";
  }
  const { plugin } = tabInstance;

  containerEl.createEl("h3", { text: "Capture" });
  const microphoneDevicesReady = renderMicrophoneSetting(containerEl, tabInstance, renderScope);

  containerEl.createEl("h3", { text: "After recording" });

  new Setting(containerEl)
    .setName("Transcribe automatically")
    .setDesc("Start transcription when a recording ends.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoTranscribeRecordings)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoTranscribeRecordings: value });
          if (value) {
            try {
              plugin.getRecorderService().recoverPendingCaptures();
            } catch {
              new Notice("Automatic transcription is on. Saved pending recordings will retry after Obsidian reloads.", 5000);
            }
          }
        });
    });

  new Setting(containerEl)
    .setName("Keep source audio")
    .setDesc("Keep the recording in your vault after transcription succeeds.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.keepRecordingsAfterTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ keepRecordingsAfterTranscription: value });
        });
    });

  containerEl.createEl("h3", { text: "Transcript output" });

  let submitAfterDictationToggle: ToggleComponent | null = null;

  new Setting(containerEl)
    .setName("Insert transcript at origin")
    .setDesc("Add the finished text only if its exact note insertion target remains unchanged, or if the original chat conversation is still active.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoPasteTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoPasteTranscription: value });
          submitAfterDictationToggle?.setDisabled(!value);
        });
    });

  new Setting(containerEl)
    .setName("Default file format")
    .setDesc("Choose the format used when you transcribe an audio file.")
    .addDropdown((dropdown) => {
      dropdown
        .addOption("markdown", "Markdown note (.md)")
        .addOption("srt", "Subtitle file (.srt)")
        .setValue(plugin.settings.transcriptionOutputFormat ?? "markdown")
        .onChange(async (value: "markdown" | "srt") => {
          await plugin.getSettingsManager().updateSettings({ transcriptionOutputFormat: value });
        });
    });

  new Setting(containerEl)
    .setName("Clean transcript output")
    .setDesc("Save only the transcript text, without source details or metadata.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.cleanTranscriptionOutput)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ cleanTranscriptionOutput: value });
        });
    });

  const cleanupSetting = new Setting(containerEl);
  const cleanupPromptContainer = containerEl.createDiv({ cls: "ss-recorder-cleanup-settings" });
  const renderCleanupPrompt = (enabled: boolean): void => {
    cleanupPromptContainer.empty();
    if (!enabled) return;

    let promptText: HTMLTextAreaElement | null = null;
    new Setting(cleanupPromptContainer)
      .setName("Cleanup instructions")
      .setDesc("Tell SystemSculpt how to improve readability. Cleanup always keeps the original languages, names, and code-switches.")
      .addTextArea((text) => {
        promptText = text.inputEl;
        text
          .setPlaceholder(DEFAULT_SETTINGS.postProcessingPrompt)
          .setValue(plugin.settings.postProcessingPrompt || DEFAULT_SETTINGS.postProcessingPrompt);
        text.inputEl.rows = 8;
        text.inputEl.addClass("ss-settings-textarea");
        tabInstance.registerListener(text.inputEl, "change", () => {
          const value = text.inputEl.value.trim()
            ? text.inputEl.value
            : DEFAULT_SETTINGS.postProcessingPrompt;
          text.inputEl.value = value;
          void plugin.getSettingsManager().updateSettings({ postProcessingPrompt: value });
        });
      })
      .addButton((button) => {
        button
          .setButtonText("Reset")
          .onClick(async () => {
            await plugin.getSettingsManager().updateSettings({
              postProcessingPrompt: DEFAULT_SETTINGS.postProcessingPrompt,
            });
            if (promptText) promptText.value = DEFAULT_SETTINGS.postProcessingPrompt;
            new Notice("Cleanup instructions reset.");
          });
      });
  };

  cleanupSetting
    .setName("Clean up transcript")
    .setDesc("Fix punctuation, remove filler words, and format the transcript after transcription.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.postProcessingEnabled)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ postProcessingEnabled: value });
          renderCleanupPrompt(value);
        });
    });
  renderCleanupPrompt(plugin.settings.postProcessingEnabled);

  containerEl.createEl("h3", { text: "Chat dictation" });

  new Setting(containerEl)
    .setName("Send after dictation")
    .setDesc("Send the dictated chat message after the transcript is inserted.")
    .addToggle((toggle) => {
      submitAfterDictationToggle = toggle;
      toggle
        .setValue(plugin.settings.autoSubmitAfterTranscription)
        .setDisabled(!plugin.settings.autoPasteTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoSubmitAfterTranscription: value });
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
  const ownerWindow = getSurfaceOwnerWindow(containerEl);
  const vaultIdentity = plugin.settings.vaultInstanceId || plugin.app.vault.getName();

  const setting = new Setting(containerEl)
    .setName("Microphone")
    .setDesc("Choose the microphone used for new recordings on this device.");

  let dropdownComponent: DropdownComponent | null = null;
  let dropdownEl: HTMLSelectElement | null = null;
  setting.addDropdown((dropdown) => {
    dropdownComponent = dropdown;
    dropdownEl = dropdown.selectEl;
    dropdown.addOption("", "Default microphone");
    dropdown.setValue(getCurrentHostPreferredMicrophoneId(ownerWindow, vaultIdentity));

    dropdown.onChange((value) => {
      setCurrentHostPreferredMicrophoneId(ownerWindow, vaultIdentity, value);
      const label = dropdown.selectEl?.selectedOptions[0]?.text || value;
      new Notice(`Microphone set to ${label}.`);
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

    addOption("", "Default microphone");
    statusEl.setText("Loading microphones...");
    const result = requestLabelPermission
      ? await renderScope.catalog.refreshWithLabelPermission()
      : await renderScope.catalog.refresh();
    if (!renderScope.isCurrent() || result.status === "cancelled") return;
    // A user can change the dropdown while enumeration or permission is in
    // flight. Read after the await so that choice wins over the stale load.
    const savedMicrophoneId = getCurrentHostPreferredMicrophoneId(ownerWindow, vaultIdentity);
    if (result.status === "unavailable") {
      if (savedMicrophoneId) addOption(savedMicrophoneId, "Saved microphone (unavailable)");
      dropdown.setValue(savedMicrophoneId);
      statusEl.setText("Microphone selection unavailable in this environment.");
      return;
    }
    if (result.status === "error") {
      if (savedMicrophoneId) addOption(savedMicrophoneId, "Saved microphone (unavailable)");
      statusEl.setText(`Unable to load microphones: ${result.message}`);
      dropdown.setValue(savedMicrophoneId);
      return;
    }

    for (const microphone of result.devices) {
      addOption(microphone.id, microphone.label);
    }
    const savedMicrophoneUnavailable = Boolean(
      savedMicrophoneId
      && !result.devices.some((microphone) => microphone.id === savedMicrophoneId),
    );
    if (savedMicrophoneUnavailable) {
      addOption(savedMicrophoneId, "Saved microphone (unavailable)");
    }
    dropdown.setValue(savedMicrophoneId);
    statusEl.setText(
      savedMicrophoneUnavailable
        ? "The saved microphone is unavailable. Recording will fall back to the default microphone."
        : result.labelRefresh === "skipped"
          ? "Tap Refresh microphone list to reveal named microphones."
        : result.devices.length === 0
          ? "No microphones detected."
        : result.labelRefresh === "denied"
          ? "Microphone access was denied. Device names may be hidden."
          : "",
    );
  };

  setting.addExtraButton((button) => {
    button.extraSettingsEl.addClass("ss-recorder-microphone-refresh");
    button
      .setIcon("refresh-cw")
      .setTooltip("Refresh microphone list")
      .onClick(() => {
        void loadDevices(true);
      });
  });
  return loadDevices();
}
