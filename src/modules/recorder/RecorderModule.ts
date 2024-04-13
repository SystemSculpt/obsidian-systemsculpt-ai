import SystemSculptPlugin from '../../main';
import {
  SystemSculptRecorderSettings,
  DEFAULT_RECORDER_SETTINGS,
} from './settings/RecorderSettings';
import { normalizePath, TFile } from 'obsidian';
import { showCustomNotice } from '../../modals';
import { SystemSculptRecorderSettingTab } from './settings/RecorderSettingTab';
import { getMicrophones } from './functions/getMicrophones';
import { getSelectedMicrophone } from './functions/getSelectedMicrophone';
import { startRecording } from './functions/startRecording';
import { stopRecording } from './functions/stopRecording';
import { saveRecording } from './functions/saveRecording';
import { handleTranscription } from './functions/handleTranscription';
import { transcribeSelectedFile } from './functions/transcribeSelectedFile';
import { RecordingNotice } from './views/RecordingNotice';
import { OpenAIService } from '../../api/OpenAIService';
import { updateRecorderButtonStatusBar } from './functions/updateRecorderButtonStatusBar';

export class RecorderModule {
  plugin: SystemSculptPlugin;
  settings: SystemSculptRecorderSettings;
  recordingNotice: RecordingNotice | null = null;
  openAIService: OpenAIService;

  constructor(plugin: SystemSculptPlugin, openAIService: OpenAIService) {
    this.plugin = plugin;
    this.openAIService = openAIService;
  }

  async load() {
    await this.loadSettings();

    this.plugin.addCommand({
      id: 'record-audio-note',
      name: 'Record audio note',
      callback: () => this.toggleRecording(),
    });

    this.plugin.addCommand({
      id: 'transcribe-selected-file',
      name: 'Transcribe selected file',
      callback: () => {},
    });

    // Initialize status bar for Recorder Button
    if (!this.plugin.recorderToggleStatusBarItem) {
      this.plugin.recorderToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.recorderToggleStatusBarItem.setText('R'); // Set text to "R"
      this.plugin.recorderToggleStatusBarItem.addClass(
        'recorder-toggle-button'
      );
    }

    updateRecorderButtonStatusBar(this); // Update the status bar on load

    // Add click listener to toggle the Recording modal
    this.plugin.recorderToggleStatusBarItem.onClickEvent(() => {
      this.toggleRecording();
    });
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_RECORDER_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
    updateRecorderButtonStatusBar(this); // Update the status bar when settings are saved
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new SystemSculptRecorderSettingTab(
      this.plugin.app,
      this,
      containerEl
    ).display();
  }

  async ensureRecordingsDirectory(): Promise<void> {
    const { vault } = this.plugin.app;
    const { recordingsPath } = this.settings;

    const normalizedPath = normalizePath(recordingsPath);
    const directory = vault.getAbstractFileByPath(normalizedPath);

    if (directory) return;

    try {
      await vault.createFolder(normalizedPath);
      this.plugin.app.workspace.trigger('refresh-files');
    } catch (error) {
      if (error.message.includes('Folder already exists')) {
      } else {
        console.error('Error ensuring recordings directory:', error);
      }
    }
  }

  async getMicrophones(): Promise<MediaDeviceInfo[]> {
    return getMicrophones();
  }

  async getSelectedMicrophone(): Promise<MediaDeviceInfo | undefined> {
    return getSelectedMicrophone(this);
  }

  async toggleRecording(): Promise<void> {
    if (this.recordingNotice) {
      await this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  async startRecording(): Promise<void> {
    await this.ensureRecordingsDirectory();
    await startRecording(this);
  }

  async stopRecording(): Promise<void> {
    await stopRecording(this);
  }

  async saveRecording(arrayBuffer: ArrayBuffer): Promise<TFile> {
    const result = await saveRecording(this, arrayBuffer);
    if (!result) {
      throw new Error('Failed to save recording');
    }
    return result;
  }

  async handleTranscription(
    arrayBuffer: ArrayBuffer,
    recordingFile: TFile
  ): Promise<void> {
    return handleTranscription(this, arrayBuffer, recordingFile);
  }

  handleError(error: Error, message: string): void {
    console.error(message, error);
    showCustomNotice(`${message}. Please try again.`);
  }

  async transcribeSelectedFile(file: TFile): Promise<void> {
    return transcribeSelectedFile(this, file);
  }

  async readFileAsArrayBuffer(file: TFile): Promise<ArrayBuffer> {
    return await this.plugin.app.vault.readBinary(file);
  }
}
