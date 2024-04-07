import { App, PluginSettingTab, Setting } from 'obsidian';
import { RecorderModule } from '../RecorderModule';
import { renderRecordingsPathSetting } from './recordingsPathSetting';
import { renderMicrophoneDropdown } from './microphoneSetting';
import { renderAutoTranscriptionToggle } from './autoTranscriptionSetting';
import { renderSaveAudioClipsToggle } from './saveAudioClipsSetting';
import { renderPasteOnTranscriptionToggle } from './pasteOnTranscriptionSetting';
import { renderCopyToClipboardToggle } from './copyToClipboardSetting'; // Added import for the new setting
import { renderSaveTranscriptionToFileToggle } from './saveTranscriptionToFileSetting';
import { renderTranscriptionsPathSetting } from './transcriptionsPathSetting';

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

    const recorderSettingsH3 = containerEl.createEl('h3', {
      text: 'Recorder Settings',
    });
    recorderSettingsH3.addClass('ss-h3');
    containerEl.createEl('p', {
      text: 'Set defaults for the recorder, such as the microphone to use, whether or not to automatically transcribe recordings, and more.',
    });

    const infoBoxEl = containerEl.createDiv('info-box');
    infoBoxEl.createEl('p', {
      text: 'Please ensure that you have set your OpenAI API key in the Brain settings.',
    });

    renderRecordingsPathSetting(containerEl, this.plugin);
    renderTranscriptionsPathSetting(containerEl, this.plugin);
    renderMicrophoneDropdown(containerEl, this.plugin);
    renderAutoTranscriptionToggle(containerEl, this.plugin);
    renderSaveAudioClipsToggle(containerEl, this.plugin);
    renderSaveTranscriptionToFileToggle(containerEl, this.plugin);
    renderCopyToClipboardToggle(containerEl, this.plugin);
    renderPasteOnTranscriptionToggle(containerEl, this.plugin);

    // Upcoming Features
    const upcomingFeaturesEl = containerEl.createDiv('upcoming-features');
    const upcomingRecorderFeaturesH3 = upcomingFeaturesEl.createEl('h3', {
      text: 'Upcoming Recorder Features',
    });
    upcomingRecorderFeaturesH3.addClass('ss-h3');
    const featuresListEl = upcomingFeaturesEl.createEl('ul');
    featuresListEl.createEl('li', {
      text: '100% local, offline Whisper AI transcription integration',
    });
    featuresListEl.createEl('li', {
      text: 'Custom words, phrases; things that Whisper usually gets wrong, you can provide Whisper with the correct spelling within this Custom Words box that it will reference and fix before giving you the final transcription',
    });
  }
}
