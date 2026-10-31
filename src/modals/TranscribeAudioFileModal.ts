import { Notice, TFile, normalizePath } from "obsidian";
import { AudioSourcePicker, type AudioSourceSelection } from "../components/AudioSourcePicker";
import { normalizeFileExtension } from "../constants/fileTypes";
import { DEFAULT_DIRS } from "../core/settings/defaultDirectories";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import {
  createUiAction,
  createUiRadioGroup,
  updateUiAction,
  type UiRadioGroupHandle,
} from "../core/ui/surface";
import type SystemSculptPlugin from "../main";
import { createDeviceFileSource } from "../platform/fileSource";
import { getHostDeviceType } from "../platform/hostCapabilities";
import {
  captureNoteInsertionTarget,
  type NoteInsertionTarget,
} from "../services/transcription/NoteInsertionTarget";
import { getTranscriptionMaxFileSize } from "../services/transcription/TranscriptionCoordinator";
import type { SystemSculptSettings } from "../types";
import { formatFileSize, validateBrowserFileSize } from "../utils/FileValidator";
import { toSafeVaultFileName } from "../utils/vaultFileName";
import { launchAudioTranscriptionPanel } from "./AudioTranscriptionPanel";

type TranscriptionOutputFormat = "markdown" | "srt";

const DEFAULT_RECORDINGS_DIRECTORY = DEFAULT_DIRS.recordingsDirectory;
// A bounded copy window, not an additional input-size limit.
const DEVICE_IMPORT_SLICE_BYTES = 4 * 1024 * 1024;
// Preserve the pre-streaming limits only for legacy whole-buffer device imports.
const LEGACY_DESKTOP_DEVICE_IMPORT_MAX_BYTES = 128 * 1024 * 1024;
const LEGACY_MOBILE_DEVICE_IMPORT_MAX_BYTES = 32 * 1024 * 1024;

const sanitizeFileName = (name: string): string =>
  toSafeVaultFileName(name.replace(/\s+/g, " "), { replacement: "-", fallback: "" });

/**
 * A mobile-first handoff from a concrete audio source to the managed
 * transcription task. The active editor is captured when the modal opens so
 * switching notes while choosing audio cannot retarget the finished text.
 */
export class TranscribeAudioFileModal extends StandardModal {
  private static nextInstanceId = 0;

  private readonly plugin: SystemSculptPlugin;
  private readonly instanceId = ++TranscribeAudioFileModal.nextInstanceId;
  private readonly insertionTarget: NoteInsertionTarget;

  private outputFormat: TranscriptionOutputFormat;
  private rememberFormat = false;
  private isLaunching = false;
  private launchGeneration = 0;
  private launchSurfaceOpen = false;

  private picker: AudioSourcePicker | null = null;
  private outputGroup: UiRadioGroupHandle<TranscriptionOutputFormat> | null = null;
  private transcribeButton: HTMLButtonElement | null = null;

  constructor(plugin: SystemSculptPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.insertionTarget = captureNoteInsertionTarget(this.app);
    this.outputFormat = plugin.settings.transcriptionOutputFormat === "srt"
      ? "srt"
      : "markdown";

    this.setSize("medium");
    this.modalEl.addClass("ss-modal--scrollable", "ss-transcribe-audio-modal");
  }

  onOpen(): void {
    super.onOpen();
    this.launchSurfaceOpen = true;
    this.addTitle(
      "Transcribe audio",
      "Choose audio from your vault or device. The transcript is saved in your vault.",
    );

    this.transcribeButton = this.addActionButton(
      "transcribe.confirm",
      "Transcribe",
      () => void this.handleTranscribe(),
      true,
      "mic",
    );
    this.transcribeButton.addClass("ss-transcribe-audio__transcribe-btn");
    this.addActionButton("transcribe.cancel", "Cancel", () => this.close(), false, "x");

    this.renderLayout();
    this.syncTranscribeButton();
  }

  onClose(): void {
    this.launchSurfaceOpen = false;
    this.launchGeneration += 1;
    this.isLaunching = false;
    this.picker?.destroy();
    this.picker = null;
    this.outputGroup?.destroy();
    this.outputGroup = null;
    this.transcribeButton = null;
    super.onClose();
  }

  private renderLayout(): void {
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "ss-transcribe-audio" });
    this.picker = new AudioSourcePicker(shell, {
      app: this.app,
      listFiles: () => this.app.vault.getFiles(),
      acceptDeviceFile: (file) => this.acceptDeviceFile(file),
      deviceHint: "You can also drop a file here.",
      onChange: () => this.syncTranscribeButton(),
    });
    this.buildOutputPicker(shell);
  }

  private buildOutputPicker(container: HTMLElement): void {
    const section = container.createEl("section", {
      cls: "ss-transcribe-audio__section ss-transcribe-audio__output",
    });
    const titleId = `ss-transcribe-audio-format-${this.instanceId}`;
    section.createEl("h3", {
      cls: "ss-transcribe-audio__section-title",
      text: "Transcript format",
      attr: { id: titleId },
    });

    const options = section.createDiv({ cls: "ss-transcribe-audio__output-options" });
    const markdownButton = this.createOutputOption(
      options,
      "transcribe.output.markdown",
      "Markdown",
      "Readable note",
      "file-text",
    );
    const srtButton = this.createOutputOption(
      options,
      "transcribe.output.srt",
      "SRT",
      "Timed subtitles",
      "captions",
    );

    this.outputGroup = createUiRadioGroup(
      options,
      [
        { value: "markdown", button: markdownButton },
        { value: "srt", button: srtButton },
      ],
      {
        value: this.outputFormat,
        labelledBy: titleId,
        onChange: (format) => {
          this.outputFormat = format;
        },
      },
    );

    const rememberId = `ss-transcribe-audio-remember-${this.instanceId}`;
    const rememberRow = section.createDiv({ cls: "ss-transcribe-audio__remember" });
    const rememberInput = rememberRow.createEl("input", {
      cls: "ss-transcribe-audio__remember-checkbox",
      attr: { id: rememberId, type: "checkbox" },
    });
    rememberRow.createEl("label", {
      cls: "ss-transcribe-audio__remember-label",
      text: "Remember this format",
      attr: { for: rememberId },
    });
    rememberRow.createDiv({
      cls: "ss-transcribe-audio__remember-hint",
      text: "Otherwise, this choice applies once.",
    });
    this.registerDomEvent(rememberInput, "change", () => {
      this.rememberFormat = rememberInput.checked;
    });
  }

  private createOutputOption(
    container: HTMLElement,
    testId: string,
    label: string,
    detail: string,
    icon: string,
  ): HTMLButtonElement {
    const button = createUiAction(container, { label, testId, icon });
    button.addClass("ss-transcribe-audio__output-option");
    button.createSpan({ cls: "ss-transcribe-audio__output-detail", text: detail });
    return button;
  }

  private deviceImportMaxBytes(): number {
    if (this.portableBinaryAppend()) return getTranscriptionMaxFileSize();
    return Math.min(getTranscriptionMaxFileSize(), getHostDeviceType() === "Mobile"
      ? LEGACY_MOBILE_DEVICE_IMPORT_MAX_BYTES
      : LEGACY_DESKTOP_DEVICE_IMPORT_MAX_BYTES);
  }

  private portableBinaryAppend(): ((file: TFile, bytes: ArrayBuffer) => Promise<void>) | null {
    // Vault.appendBinary is portable from Obsidian 1.12.3; retain the older-host fallback.
    const append = (this.app.vault as {
      appendBinary?: (file: TFile, bytes: ArrayBuffer) => Promise<void>;
    }).appendBinary;
    return typeof append === "function" ? append.bind(this.app.vault) : null;
  }

  private acceptDeviceFile(file: File): Promise<boolean> {
    const maxBytes = this.deviceImportMaxBytes();
    return validateBrowserFileSize(file, this.app, {
      maxBytes,
      maxLabel: formatFileSize(maxBytes),
      title: "Audio File Size Limit Exceeded",
      description: "Choose a smaller audio file before importing it into the vault.",
    });
  }

  private syncTranscribeButton(): void {
    if (!this.transcribeButton) return;
    updateUiAction(this.transcribeButton, {
      label: this.isLaunching ? "Preparing…" : "Transcribe",
      disabled: !this.picker?.selection || this.isLaunching,
      busy: this.isLaunching,
    });
  }

  private async handleTranscribe(): Promise<void> {
    const selection = this.picker?.selection;
    if (!selection || this.isLaunching) return;
    const launchGeneration = ++this.launchGeneration;
    this.isLaunching = true;
    this.syncTranscribeButton();

    try {
      const file = await this.resolveAudioFile(selection, launchGeneration);
      if (!file || !this.isCurrentLaunch(launchGeneration)) return;
      await this.persistFormatIfRequested();
      if (!this.isCurrentLaunch(launchGeneration)) {
        await this.discardCancelledImport(selection, file);
        return;
      }
      this.close();
      launchAudioTranscriptionPanel(this.app, {
        file,
        timestamped: this.outputFormat === "srt",
        targetEditor: this.insertionTarget.editor,
        validateInsertionTarget: this.insertionTarget.validate,
        plugin: this.plugin,
      });
    } catch (error) {
      if (!this.isCurrentLaunch(launchGeneration)) return;
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not start transcription: ${message}`, 6500);
      this.isLaunching = false;
      this.syncTranscribeButton();
    }
  }

  private async persistFormatIfRequested(): Promise<void> {
    if (!this.rememberFormat) return;
    if (this.plugin.settings.transcriptionOutputFormat === this.outputFormat) return;

    const update: Partial<SystemSculptSettings> = {
      transcriptionOutputFormat: this.outputFormat,
    };
    try {
      await this.plugin.getSettingsManager().updateSettings(update);
    } catch (error) {
      console.warn("[SystemSculpt] Failed to save transcription format", error);
      new Notice("This transcription will use your choice, but the default was not saved.", 5000);
    }
  }

  private async resolveAudioFile(
    selection: AudioSourceSelection,
    launchGeneration: number,
  ): Promise<TFile | null> {
    if (selection.kind === "vault") return selection.file;

    const directory = normalizePath(
      this.plugin.settings.recordingsDirectory || DEFAULT_RECORDINGS_DIRECTORY,
    );
    const directoryManager = this.plugin.directoryManager;
    if (!directoryManager) throw new Error("Directory manager has not been initialized.");
    await directoryManager.ensureDirectoryByPath(directory);
    if (!this.isCurrentLaunch(launchGeneration)) return null;

    const safeName = sanitizeFileName(selection.file.name) || `audio.${this.extensionOf(selection.file.name)}`;
    const appendBinary = this.portableBinaryAppend();
    let created: TFile | null;
    if (selection.file.size > DEVICE_IMPORT_SLICE_BYTES && appendBinary) {
      created = await this.importAudioInParts(directory, safeName, selection, launchGeneration, appendBinary);
      if (!created) return null;
    } else {
      // Keep small imports and hosts predating portable binary append compatible.
      const bytes = await selection.file.arrayBuffer();
      if (!this.isCurrentLaunch(launchGeneration)) return null;
      created = await this.createImportedAudio(directory, safeName, path => this.app.vault.createBinary(path, bytes));
    }
    if (!(created instanceof TFile)) {
      throw new Error("The audio file could not be saved in the vault.");
    }
    if (!this.isCurrentLaunch(launchGeneration)) {
      await this.discardCancelledImport(selection, created);
      return null;
    }
    return created;
  }

  private async importAudioInParts(
    directory: string,
    safeName: string,
    selection: Extract<AudioSourceSelection, { kind: "device" }>,
    launchGeneration: number,
    appendBinary: (file: TFile, bytes: ArrayBuffer) => Promise<void>,
  ): Promise<TFile | null> {
    const source = createDeviceFileSource(selection.file);
    let staged: TFile | null = null;
    let complete = false;
    try {
      // An incomplete copy must not appear as playable/transcribable audio.
      staged = await this.createImportedAudio(directory, `${safeName}.partial`, path =>
        this.app.vault.createBinary(path, new ArrayBuffer(0)),
      );
      if (!(staged instanceof TFile)) throw new Error("The audio file could not be saved in the vault.");
      for (let start = 0; start < source.sizeBytes; start += DEVICE_IMPORT_SLICE_BYTES) {
        if (!this.isCurrentLaunch(launchGeneration)) return null;
        const end = Math.min(start + DEVICE_IMPORT_SLICE_BYTES, source.sizeBytes);
        const bytes = await source.readSlice(start, end);
        if (!this.isCurrentLaunch(launchGeneration)) return null;
        if (bytes.byteLength !== end - start) throw new Error("The selected audio file changed while it was being read.");
        await appendBinary(staged, bytes);
      }
      if (!this.isCurrentLaunch(launchGeneration)) return null;
      const file = staged;
      await this.createImportedAudio(directory, safeName, async path => {
        await this.app.vault.rename(file, path);
        return file;
      });
      if (!this.isCurrentLaunch(launchGeneration)) return null;
      complete = true;
      return file;
    } finally {
      source.release();
      if (staged && !complete) await this.discardCancelledImport(selection, staged);
    }
  }

  private isCurrentLaunch(launchGeneration: number): boolean {
    return this.launchSurfaceOpen && this.launchGeneration === launchGeneration;
  }

  private async discardCancelledImport(
    selection: AudioSourceSelection,
    file: TFile,
  ): Promise<void> {
    if (selection.kind !== "device") return;
    try {
      await this.app.fileManager.trashFile(file);
    } catch {
      // Cancellation remains authoritative even if the vault cannot remove the staged copy.
    }
  }

  private async createImportedAudio(
    directory: string,
    safeName: string,
    create: (path: string) => Promise<TFile>,
  ): Promise<TFile> {
    const dotIndex = safeName.lastIndexOf(".");
    const stem = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
    const suffix = dotIndex > 0 ? safeName.slice(dotIndex) : "";

    for (let attempt = 1; attempt <= 1_000; attempt += 1) {
      const candidateName = attempt === 1
        ? safeName
        : `${stem}-${attempt}${suffix}`;
      const path = normalizePath(`${directory}/${candidateName}`);
      if (this.app.vault.getAbstractFileByPath(path)) continue;

      try {
        return await create(path);
      } catch (error) {
        // Another vault operation may have claimed the path after our check.
        if (this.app.vault.getAbstractFileByPath(path)) continue;
        throw error;
      }
    }

    throw new Error("A unique vault path could not be created for this audio file.");
  }

  private extensionOf(name: string): string {
    const dotIndex = name.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
    return normalizeFileExtension(name.slice(dotIndex + 1));
  }
}
