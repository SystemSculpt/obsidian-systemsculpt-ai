import { App, PluginSettingTab, Setting } from "obsidian";
import { RecorderModule } from "../RecorderModule";
import { renderRecordingsPathSetting } from "./recordingsPathSetting";
import { renderMicrophoneDropdown } from "./microphoneSetting";
import { renderAutoTranscriptionToggle } from "./autoTranscriptionSetting";
import { renderSaveAudioClipsToggle } from "./saveAudioClipsSetting";
import { renderPasteOnTranscriptionToggle } from "./pasteOnTranscriptionSetting";
import { renderCopyToClipboardToggle } from "./copyToClipboardSetting";
import { renderSaveTranscriptionToFileToggle } from "./saveTranscriptionToFileSetting";
import { renderTranscriptionsPathSetting } from "./transcriptionsPathSetting";
import { updateRecorderButtonStatusBar } from "../functions/updateRecorderButtonStatusBar";
import { renderWhisperProviderSetting } from "./whisperProviderSetting";
import { renderCustomWhisperPromptSetting } from "./customWhisperPromptSetting";
import { renderPostProcessingPromptSetting } from "./postProcessingPromptSetting";
import { renderLanguageSetting } from "./languageSetting";
import { renderIncludeLinkToRecordingToggle } from "./includeLinkToRecordingSetting";

export class SystemSculptRecorderSettingTab extends PluginSettingTab {
  plugin: RecorderModule;

  constructor(app: App, plugin: RecorderModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl).setName("Recorder").setHeading();
    containerEl.createEl("p", {
      text: "Set defaults for the recorder, such as the microphone to use, whether or not to automatically transcribe recordings, and more.",
    });

    const infoBoxEl = containerEl.createDiv("systemsculpt-info-box");
    infoBoxEl.createEl("p", {
      text: "Please ensure that you have set your OpenAI API key in the Brain settings. The Recorder acts as a toggle - meaning you can hotkey it (I hotkey mine to CMD+SHIFT+R) to start, and then just hit the same hotkey again to end it.",
    });

    // Add toggle for showing Recorder Button on the status bar
    new Setting(containerEl)
      .setName("Show recorder button on status bar")
      .setDesc("Toggle the display of recorder button on the status bar")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showRecorderButtonOnStatusBar)
          .onChange(async (value) => {
            this.plugin.settings.showRecorderButtonOnStatusBar = value;
            updateRecorderButtonStatusBar(this.plugin);
            await this.plugin.saveSettings();
          });
      });

    renderWhisperProviderSetting(containerEl, this.plugin);
    renderRecordingsPathSetting(containerEl, this.plugin);
    renderTranscriptionsPathSetting(containerEl, this.plugin);
    renderMicrophoneDropdown(containerEl, this.plugin);
    renderLanguageSetting(containerEl, this.plugin);
    renderAutoTranscriptionToggle(containerEl, this.plugin);
    renderCustomWhisperPromptSetting(containerEl, this.plugin);
    renderPostProcessingPromptSetting(containerEl, this.plugin);
    renderSaveAudioClipsToggle(containerEl, this.plugin);
    renderSaveTranscriptionToFileToggle(containerEl, this.plugin);
    renderCopyToClipboardToggle(containerEl, this.plugin);
    renderPasteOnTranscriptionToggle(containerEl, this.plugin);
    renderIncludeLinkToRecordingToggle(containerEl, this.plugin);
  }
}
