import { Notice, TFile, normalizePath, setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import type SystemSculptPlugin from "../main";
import {
  AUDIO_FILE_EXTENSIONS,
  isAudioFileExtension,
  normalizeFileExtension,
} from "../constants/fileTypes";
import {
  formatFileSize,
  validateBrowserFileSize,
} from "../utils/FileValidator";
import { showAudioTranscriptionModal } from "./AudioTranscriptionModal";
import type { SystemSculptSettings } from "../types";

type TranscribeAudioSelection =
  | { kind: "vault"; file: TFile }
  | { kind: "upload"; file: File };

type TranscriptionOutputFormat = "markdown" | "srt";

const DEFAULT_RECORDINGS_DIRECTORY = "SystemSculpt/Recordings";
const DEFAULT_TRANSCRIPTION_OUTPUT_FORMAT: TranscriptionOutputFormat = "markdown";
const MAX_VISIBLE_FILES = 200;

const sanitizeFileName = (name: string): string =>
  name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();

export class TranscribeAudioFileModal extends StandardModal {
  private readonly plugin: SystemSculptPlugin;

  private audioFiles: TFile[] = [];
  private filteredFiles: TFile[] = [];
  private searchQuery = "";
  private selected: TranscribeAudioSelection | null = null;
  private outputFormat: TranscriptionOutputFormat;
  private hideFormatChooserNextTime = false;

  private listEl: HTMLElement | null = null;
  private fileInputEl: HTMLInputElement | null = null;
  private selectionSummaryEl: HTMLElement | null = null;
  private transcribeButton: HTMLButtonElement | null = null;
  private previewAudioEl: HTMLAudioElement | null = null;
  private previewObjectUrl: string | null = null;
  private isLaunching = false;

  constructor(plugin: SystemSculptPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.outputFormat = this.resolveOutputFormat(
      this.plugin.settings.transcriptionOutputFormat
    );
    this.setSize("large");
    this.modalEl.addClass("ss-modal--scrollable");
    this.modalEl.addClass("ss-transcribe-audio-modal");
  }

  onOpen(): void {
    super.onOpen();

    this.addTitle(
      "Transcribe an audio file",
      "Pick from your vault or drag and drop an audio file from your device, then start transcription."
    );

    const transcribeButton = this.addActionButton(
      "Transcribe",
      () => void this.handleTranscribe(),
      true,
      "mic"
    );
    transcribeButton.disabled = true;
    transcribeButton.addClass("ss-transcribe-audio__transcribe-btn");
    this.transcribeButton = transcribeButton;

    this.addActionButton("Cancel", () => this.close(), false, "x");

    this.renderLayout();
  }

  onClose(): void {
    this.clearPreviewUrl();
    this.previewAudioEl = null;
    super.onClose();
  }

  private renderLayout(): void {
    this.contentEl.empty();

    const shell = this.contentEl.createDiv({ cls: "ss-transcribe-audio" });
    const vaultColumn = shell.createDiv({ cls: "ss-transcribe-audio__column" });
    const uploadColumn = shell.createDiv({
      cls: "ss-transcribe-audio__column ss-transcribe-audio__column--panel",
    });

    this.buildVaultPicker(vaultColumn);
    this.buildUploadPanel(uploadColumn);
    this.buildOutputFormatPanel(uploadColumn);
    this.buildSelectionSummary(uploadColumn);

    this.refreshAudioFiles();
    this.syncTranscribeButton();
  }

  private buildVaultPicker(container: HTMLElement): void {
    const header = container.createDiv({
      cls: "ss-transcribe-audio__section-title",
      text: "Pick from your vault",
    });
    header.createDiv({
      cls: "ss-transcribe-audio__section-hint",
      text: "Only audio files are shown.",
    });

    const search = container.createDiv({
      cls: "ss-transcribe-audio__search",
    });
    const icon = search.createDiv({
      cls: "ss-transcribe-audio__search-icon",
    });
    setIcon(icon, "search");

    const searchInputEl = search.createEl("input", {
      type: "text",
      placeholder: "Search by name or path",
      cls: "ss-transcribe-audio__search-input",
    }) as HTMLInputElement;
    searchInputEl.value = this.searchQuery;

    this.registerDomEvent(searchInputEl, "input", () => {
      this.searchQuery = searchInputEl.value || "";
      this.updateFilteredFiles();
    });

    this.listEl = container.createDiv({
      cls: "ss-transcribe-audio__list",
    });
  }

  private buildUploadPanel(container: HTMLElement): void {
    const header = container.createDiv({
      cls: "ss-transcribe-audio__section-title",
      text: "Drop or upload audio",
    });
    header.createDiv({
      cls: "ss-transcribe-audio__section-hint",
      text: "Drag in a file or tap to choose from your computer or phone.",
    });

    const dropzone = container.createDiv({
      cls: "ss-transcribe-audio__dropzone",
    });

    const dropMain = dropzone.createDiv({
      cls: "ss-transcribe-audio__drop-main",
      text: "Drag & drop an audio file",
    });
    setIcon(
      dropMain.createSpan({ cls: "ss-transcribe-audio__drop-icon" }),
      "upload"
    );

    dropzone.createDiv({
      cls: "ss-transcribe-audio__drop-sub",
      text: "Or tap to browse from this device.",
    });

    const extensions = Array.from(AUDIO_FILE_EXTENSIONS)
      .map((ext) => ext.toUpperCase())
      .join(" · ");
    dropzone.createDiv({
      cls: "ss-transcribe-audio__drop-hint",
      text: `Accepted: ${extensions}`,
    });

    this.fileInputEl = dropzone.createEl("input", {
      type: "file",
      attr: {
        accept: "audio/*",
      },
      cls: "ss-transcribe-audio__file-input",
    }) as HTMLInputElement;

    this.registerDomEvent(dropzone, "click", () => this.fileInputEl?.click());

    ["dragenter", "dragover"].forEach((event) => {
      this.registerDomEvent(dropzone, event, (e: Event) => {
        e.preventDefault();
        dropzone.addClass("is-dragging");
      });
    });

    ["dragleave", "dragexit"].forEach((event) => {
      this.registerDomEvent(dropzone, event, (e: Event) => {
        e.preventDefault();
        dropzone.removeClass("is-dragging");
      });
    });

    this.registerDomEvent(dropzone, "drop", (e: Event) => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      dropzone.removeClass("is-dragging");
      const files = Array.from(dragEvent.dataTransfer?.files || []);
      const firstAudio = files.find((file) =>
        isAudioFileExtension(
          normalizeFileExtension(file.name.split(".").pop() || "")
        )
      );
      if (!firstAudio) {
        new Notice("Drop an audio file (mp3, wav, m4a, ogg, webm).", 4000);
        return;
      }
      void this.handleUploadSelection(firstAudio);
    });

    this.registerDomEvent(this.fileInputEl, "change", () => {
      const file = this.fileInputEl?.files?.[0];
      if (file) {
        void this.handleUploadSelection(file);
      }
    });

    const pickerActions = container.createDiv({
      cls: "ss-transcribe-audio__picker-actions",
    });
    const openFileButton = pickerActions.createEl("button", {
      cls: "ss-button ss-button--secondary ss-transcribe-audio__open-file-btn",
    }) as HTMLButtonElement;
    openFileButton.type = "button";
    const buttonIcon = openFileButton.createSpan({ cls: "ss-button__icon" });
    setIcon(buttonIcon, "folder-open");
    openFileButton.appendChild(document.createTextNode("Open file from Finder"));

    this.registerDomEvent(openFileButton, "click", (event: Event) => {
      event.preventDefault();
      this.fileInputEl?.click();
    });

    pickerActions.createDiv({
      cls: "ss-transcribe-audio__section-hint",
      text: "Opens your system file picker (Finder on macOS).",
    });
  }

  private buildOutputFormatPanel(container: HTMLElement): void {
    const section = container.createDiv({
      cls: "ss-transcribe-audio__output",
    });
    section.createDiv({
      cls: "ss-transcribe-audio__section-title",
      text: "Output format",
    });

    if (this.shouldShowFormatChooser()) {
      section.createDiv({
        cls: "ss-transcribe-audio__section-hint",
        text: "Choose what gets saved when transcription finishes.",
      });

      const options = section.createDiv({
        cls: "ss-transcribe-audio__output-options",
      });
      this.createOutputFormatOption(options, "markdown", "Markdown (.md)", "Best for readable notes and post-processing.");
      this.createOutputFormatOption(options, "srt", "SRT subtitle file (.srt)", "Best for timestamped captions and subtitle workflows.");

      const hideRow = section.createDiv({
        cls: "ss-transcribe-audio__output-hide",
      });
      const hideId = `ss-transcribe-audio-hide-format-${Date.now()}`;
      const hideInput = hideRow.createEl("input", {
        type: "checkbox",
        attr: { id: hideId },
        cls: "ss-transcribe-audio__output-hide-checkbox",
      }) as HTMLInputElement;
      hideInput.checked = false;

      const hideLabel = hideRow.createEl("label", {
        attr: { for: hideId },
        cls: "ss-transcribe-audio__output-hide-label",
      });
      hideLabel.setText("Do not show this again (re-enable in Settings).");

      this.registerDomEvent(hideInput, "change", () => {
        this.hideFormatChooserNextTime = hideInput.checked;
      });
    } else {
      section.createDiv({
        cls: "ss-transcribe-audio__output-static",
        text: `Using default: ${this.describeOutputFormat(this.outputFormat)}.`,
      });
      section.createDiv({
        cls: "ss-transcribe-audio__section-hint",
        text: "You can re-enable the format chooser anytime in Settings > Audio & Transcription.",
      });
    }

    section.createDiv({
      cls: "ss-transcribe-audio__section-hint",
      text: "You can always change this in Settings > Audio & Transcription.",
    });
  }

  private createOutputFormatOption(
    container: HTMLElement,
    format: TranscriptionOutputFormat,
    label: string,
    detail: string
  ): void {
    const option = container.createDiv({
      cls: "ss-transcribe-audio__output-option",
    });
    option.classList.toggle("is-selected", this.outputFormat === format);

    const id = `ss-transcribe-audio-output-${format}-${Date.now()}`;
    const input = option.createEl("input", {
      type: "radio",
      attr: {
        name: "ss-transcribe-output-format",
        id,
        value: format,
      },
      cls: "ss-transcribe-audio__output-radio",
    }) as HTMLInputElement;
    input.checked = this.outputFormat === format;

    const body = option.createEl("label", {
      attr: { for: id },
      cls: "ss-transcribe-audio__output-option-body",
    });
    body.createDiv({
      cls: "ss-transcribe-audio__output-option-label",
      text: label,
    });
    body.createDiv({
      cls: "ss-transcribe-audio__output-option-detail",
      text: detail,
    });

    this.registerDomEvent(input, "change", () => {
      if (!input.checked) return;
      this.outputFormat = format;
      this.syncOutputOptionSelection(container);
      if (this.selected) {
        this.renderSelectionSummary();
      }
    });
  }

  private syncOutputOptionSelection(container: HTMLElement): void {
    const options = container.querySelectorAll<HTMLElement>(
      ".ss-transcribe-audio__output-option"
    );
    options.forEach((option) => {
      const input = option.querySelector<HTMLInputElement>(
        ".ss-transcribe-audio__output-radio"
      );
      option.classList.toggle("is-selected", !!input?.checked);
    });
  }

  private buildSelectionSummary(container: HTMLElement): void {
    container.createDiv({
      cls: "ss-transcribe-audio__section-title",
      text: "Selection",
    });

    this.selectionSummaryEl = container.createDiv({
      cls: "ss-transcribe-audio__selection",
    });
    this.renderSelectionSummary();
  }

  private refreshAudioFiles(): void {
    const candidates =
      this.plugin.vaultFileCache?.getAllFiles() || this.app.vault.getFiles();
    this.audioFiles = candidates
      .filter((file) => isAudioFileExtension(file.extension))
      .sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0));

    this.updateFilteredFiles();
  }

  private updateFilteredFiles(): void {
    const needle = this.searchQuery.trim().toLowerCase();
    this.filteredFiles = needle
      ? this.audioFiles.filter((file) =>
          `${file.basename} ${file.path}`.toLowerCase().includes(needle)
        )
      : [...this.audioFiles];

    this.renderFileList();
  }

  private renderFileList(): void {
    if (!this.listEl) return;

    const previousScroll = this.listEl.scrollTop;
    this.listEl.empty();

    if (this.filteredFiles.length === 0) {
      const empty = this.listEl.createDiv("ss-transcribe-audio__empty");
      setIcon(
        empty.createDiv("ss-transcribe-audio__empty-icon"),
        "headphones"
      );
      empty.createDiv({
        cls: "ss-transcribe-audio__empty-text",
        text:
          this.audioFiles.length === 0
            ? "No audio found. Drop a file on the right to start."
            : "No matches. Try a different search.",
      });
      return;
    }

    const filesToRender = this.filteredFiles.slice(0, MAX_VISIBLE_FILES);
    filesToRender.forEach((file) => {
      const item = this.listEl!.createDiv({
        cls: "ss-transcribe-audio__file",
        attr: { "data-path": file.path },
      });

      const meta = item.createDiv({ cls: "ss-transcribe-audio__file-meta" });
      meta.createDiv({
        cls: "ss-transcribe-audio__file-name",
        text: file.basename,
      });
      meta.createDiv({
        cls: "ss-transcribe-audio__file-path",
        text: file.path,
      });

      const badgeStack = item.createDiv({
        cls: "ss-transcribe-audio__file-badge-stack",
      });
      const modifiedBadge = badgeStack.createDiv({
        cls: "ss-transcribe-audio__file-badge ss-transcribe-audio__file-badge--modified",
      });
      const modifiedIcon = modifiedBadge.createDiv({
        cls: "ss-transcribe-audio__file-badge-icon",
      });
      setIcon(modifiedIcon, "calendar");
      modifiedBadge.createSpan({
        text: this.formatModified(file),
        cls: "ss-transcribe-audio__file-badge-text",
      });

      item.classList.toggle("is-selected", this.isSelectedVaultFile(file));
      this.registerDomEvent(item, "click", () => this.handleVaultSelection(file));
    });

    if (this.filteredFiles.length > MAX_VISIBLE_FILES) {
      this.listEl.createDiv({
        cls: "ss-transcribe-audio__more",
        text: `Showing ${MAX_VISIBLE_FILES} of ${this.filteredFiles.length} audio files`,
      });
    }

    this.listEl.scrollTop = previousScroll;
  }

  private handleVaultSelection(file: TFile): void {
    this.selected = { kind: "vault", file };
    this.syncSelectedState(file.path);
    this.renderSelectionSummary();
    this.syncTranscribeButton();
  }

  private async handleUploadSelection(file: File): Promise<void> {
    const extension = normalizeFileExtension(file.name.split(".").pop() || "");
    if (!isAudioFileExtension(extension)) {
      new Notice("Only audio files are supported.", 4000);
      return;
    }

    const validSize = await validateBrowserFileSize(file, this.app);
    if (!validSize) return;

    this.selected = { kind: "upload", file };
    this.syncSelectedState();
    this.renderSelectionSummary();
    this.syncTranscribeButton();
  }

  private syncSelectedState(selectedPath?: string): void {
    if (!this.listEl) return;
    const items = Array.from(
      this.listEl.querySelectorAll<HTMLElement>(".ss-transcribe-audio__file")
    );
    items.forEach((el) => {
      const isSelected = selectedPath
        ? el.getAttribute("data-path") === selectedPath
        : false;
      el.classList.toggle("is-selected", isSelected);
    });
  }

  private renderSelectionSummary(): void {
    if (!this.selectionSummaryEl) return;
    this.selectionSummaryEl.empty();

    if (!this.selected) {
      this.selectionSummaryEl.createDiv({
        cls: "ss-transcribe-audio__selection-empty",
        text: "Select or drop an audio file to enable transcription.",
      });
      this.clearPreviewUrl();
      this.previewAudioEl = null;
      return;
    }

    if (this.selected.kind === "vault") {
      this.selectionSummaryEl.createDiv({
        cls: "ss-transcribe-audio__selection-path",
        text: this.selected.file.path,
      });
    } else {
      this.selectionSummaryEl.createDiv({
        cls: "ss-transcribe-audio__selection-path",
        text: `${this.selected.file.name} · ${formatFileSize(
          this.selected.file.size
        )} · ${this.getExtension(this.selected.file.name).toUpperCase()}`,
      });
    }

    this.selectionSummaryEl.createDiv({
      cls: "ss-transcribe-audio__selection-output",
      text: `Output: ${this.describeOutputFormat(this.outputFormat)}`,
    });

    this.renderPreview(this.selected);
  }

  private renderPreview(selection: TranscribeAudioSelection): void {
    if (!this.selectionSummaryEl) return;
    this.selectionSummaryEl
      .querySelectorAll(".ss-transcribe-audio__preview")
      .forEach((el) => el.remove());

    const preview = this.selectionSummaryEl.createDiv({
      cls: "ss-transcribe-audio__preview",
    });

    const audio = preview.createEl("audio", {
      attr: { controls: "true", preload: "metadata" },
      cls: "ss-transcribe-audio__audio",
    });
    this.previewAudioEl = audio;

    const source = this.buildPreviewSrc(selection);
    if (source) {
      audio.src = source;
    }
  }

  private buildPreviewSrc(selection: TranscribeAudioSelection): string | null {
    if (selection.kind === "vault") {
      this.clearPreviewUrl();
      return this.app.vault.getResourcePath(selection.file);
    }

    this.clearPreviewUrl();
    const url = URL.createObjectURL(selection.file);
    this.previewObjectUrl = url;
    return url;
  }

  private clearPreviewUrl(): void {
    if (this.previewObjectUrl) {
      URL.revokeObjectURL(this.previewObjectUrl);
      this.previewObjectUrl = null;
    }
    if (this.previewAudioEl) {
      this.previewAudioEl.pause();
      this.previewAudioEl.src = "";
    }
  }

  private syncTranscribeButton(): void {
    if (!this.transcribeButton) return;
    this.transcribeButton.disabled = !this.selected || this.isLaunching;
  }

  private resolveOutputFormat(value: unknown): TranscriptionOutputFormat {
    return value === "srt" ? "srt" : DEFAULT_TRANSCRIPTION_OUTPUT_FORMAT;
  }

  private describeOutputFormat(value: TranscriptionOutputFormat): string {
    return value === "srt" ? "SRT subtitle file (.srt)" : "Markdown (.md)";
  }

  private shouldShowFormatChooser(): boolean {
    return this.plugin.settings.showTranscriptionFormatChooserInModal !== false;
  }

  private async persistOutputPreferences(): Promise<void> {
    const updates: Partial<SystemSculptSettings> = {};
    const nextOutput = this.resolveOutputFormat(this.outputFormat);

    if (this.plugin.settings.transcriptionOutputFormat !== nextOutput) {
      updates.transcriptionOutputFormat = nextOutput;
    }
    if (this.shouldShowFormatChooser() && this.hideFormatChooserNextTime) {
      updates.showTranscriptionFormatChooserInModal = false;
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    try {
      await this.plugin.getSettingsManager().updateSettings(updates);
    } catch (error) {
      console.warn(
        "[SystemSculpt] Failed to persist transcription modal preferences",
        error
      );
      new Notice(
        "Could not save transcription format preferences. You can still change them in Settings.",
        5000
      );
    }
  }

  private formatModified(file: TFile): string {
    const ts = file.stat?.mtime || file.stat?.ctime || Date.now();
    const date = new Date(ts);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  private getExtension(name: string): string {
    const parts = name.split(".");
    return normalizeFileExtension(parts.pop() || "");
  }

  private isSelectedVaultFile(file: TFile): boolean {
    return (
      this.selected?.kind === "vault" && this.selected.file.path === file.path
    );
  }

  private async handleTranscribe(): Promise<void> {
    if (!this.selected || this.isLaunching) return;

    this.isLaunching = true;
    this.syncTranscribeButton();

    try {
      const file = await this.resolveAudioFile(this.selected);
      await this.persistOutputPreferences();
      this.close();
      await showAudioTranscriptionModal(this.app, {
        file,
        timestamped: this.outputFormat === "srt",
        plugin: this.plugin,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to start transcription: ${message}`, 6000);
      this.isLaunching = false;
      this.syncTranscribeButton();
    }
  }

  private async resolveAudioFile(selection: TranscribeAudioSelection): Promise<TFile> {
    if (selection.kind === "vault") {
      return selection.file;
    }

    const recordingsDir =
      this.plugin.settings.recordingsDirectory || DEFAULT_RECORDINGS_DIRECTORY;
    const dirPath = normalizePath(recordingsDir);
    await this.ensureFolderExists(dirPath);

    const safeName = sanitizeFileName(selection.file.name);
    const targetPath = normalizePath(`${dirPath}/${Date.now()}_${safeName}`);
    const buffer = await selection.file.arrayBuffer();
    await this.plugin.app.vault.adapter.writeBinary(targetPath, buffer);

    const created = this.plugin.app.vault.getAbstractFileByPath(targetPath);
    if (!(created instanceof TFile)) {
      throw new Error("Failed to store uploaded audio in the vault.");
    }

    return created;
  }

  private async ensureFolderExists(path: string): Promise<void> {
    const adapter = this.plugin.app.vault.adapter as {
      exists?: (path: string) => Promise<boolean>;
    };

    if (!path) return;
    if (typeof adapter.exists === "function" && (await adapter.exists(path))) {
      return;
    }

    const parts = path
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (typeof adapter.exists === "function" && (await adapter.exists(current))) {
        continue;
      }
      await this.plugin.app.vault.createFolder(current);
    }
  }
}
