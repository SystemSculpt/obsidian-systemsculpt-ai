import SystemSculptPlugin from "../../main";
import {
  SystemSculptRecorderSettings,
  DEFAULT_RECORDER_SETTINGS,
} from "./settings/RecorderSettings";
import { normalizePath, TFile } from "obsidian";
import { showCustomNotice } from "../../modals";
import { SystemSculptRecorderSettingTab } from "./settings/RecorderSettingTab";
import { getMicrophones } from "./functions/getMicrophones";
import { getSelectedMicrophone } from "./functions/getSelectedMicrophone";
import { startRecording } from "./functions/startRecording";
import { stopRecording } from "./functions/stopRecording";
import { saveRecording } from "./functions/saveRecording";
import { handleTranscription } from "./functions/handleTranscription";
import { transcribeSelectedFile } from "./functions/transcribeSelectedFile";
import { RecordingNotice } from "./views/RecordingNotice";
import { AIService } from "../../api/AIService";
import { updateRecorderButtonStatusBar } from "./functions/updateRecorderButtonStatusBar";

export class RecorderModule {
  plugin: SystemSculptPlugin;
  settings!: SystemSculptRecorderSettings;
  recordingNotice: RecordingNotice | null = null;
  AIService: AIService;
  recordingStatusBarItem: HTMLElement | null = null;

  constructor(plugin: SystemSculptPlugin, AIService: AIService) {
    this.plugin = plugin;
    this.AIService = AIService;
  }

  async load() {
    await this.loadSettings();

    this.plugin.addCommand({
      id: "record-audio-note",
      name: "Record audio note",
      callback: () => this.toggleRecording(),
    });

    this.plugin.addCommand({
      id: "transcribe-selected-file",
      name: "Transcribe selected file",
      callback: () => {},
    });

    if (!this.plugin.recorderToggleStatusBarItem) {
      this.plugin.recorderToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.recorderToggleStatusBarItem.setText("R");
      this.plugin.recorderToggleStatusBarItem.addClass("status-bar-button");
      this.plugin.recorderToggleStatusBarItem.addClass(
        "recorder-toggle-button"
      );
    }

    updateRecorderButtonStatusBar(this);

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
    await this.plugin.saveSettings(this.settings);
    updateRecorderButtonStatusBar(this);
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

    if (!directory) {
      try {
        await vault.createFolder(normalizedPath);
        this.plugin.app.workspace.trigger("refresh-files");
      } catch (error) {
        if (
          error instanceof Error &&
          !error.message.includes("Folder already exists")
        ) {
          console.error("Error ensuring recordings directory:", error);
        }
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
      await this.showRecordingNotice();
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
      throw new Error("Failed to save recording");
    }
    return result;
  }

  async handleTranscription(
    arrayBuffer: ArrayBuffer,
    recordingFile: TFile,
    skipPaste: boolean = false
  ): Promise<string> {
    return handleTranscription(this, arrayBuffer, recordingFile, skipPaste);
  }

  handleError(error: Error, message: string): void {
    showCustomNotice(`${message}. Please try again.`);
  }

  async transcribeSelectedFile(file: TFile): Promise<void> {
    return transcribeSelectedFile(this, file);
  }

  async readFileAsArrayBuffer(file: TFile): Promise<ArrayBuffer> {
    return await this.plugin.app.vault.readBinary(file);
  }

  showRecordingStatusBar(): void {
    if (!this.recordingStatusBarItem) {
      this.recordingStatusBarItem = this.plugin.addStatusBarItem();
      this.recordingStatusBarItem.setText("Recording...");
      this.recordingStatusBarItem.addClass("recorder-notice-toggle-button");
      this.recordingStatusBarItem.addEventListener("click", () => {
        this.showRecordingNoticeWithoutStarting();
      });
    }
  }

  hideRecordingStatusBar(): void {
    if (this.recordingStatusBarItem) {
      this.recordingStatusBarItem.remove();
      this.recordingStatusBarItem = null;
    }
  }

  async showRecordingNotice(): Promise<void> {
    if (!this.recordingNotice) {
      this.recordingNotice = new RecordingNotice(this.plugin.app, this);
      await this.recordingNotice.show();
    }
    this.hideRecordingStatusBar();
  }

  showRecordingNoticeWithoutStarting(): void {
    if (this.recordingNotice) {
      this.recordingNotice.showWithoutStartingRecording();
    }
    this.hideRecordingStatusBar();
  }
}
