import { Notice, TFile, normalizePath, setIcon } from "obsidian";
import {
  AUDIO_FILE_EXTENSIONS,
  isAudioFileExtension,
  normalizeFileExtension,
} from "../constants/fileTypes";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import {
  createUiAction,
  createUiRadioGroup,
  createUiSearch,
  createUiState,
  createUiTabs,
  getSurfaceOwnerWindow,
  updateUiAction,
  type UiRadioGroupHandle,
  type UiSearchHandle,
  type UiTabsHandle,
} from "../core/ui/surface";
import type SystemSculptPlugin from "../main";
import {
  captureNoteInsertionTarget,
  type NoteInsertionTarget,
} from "../services/transcription/NoteInsertionTarget";
import { getTranscriptionMaxFileSize } from "../services/transcription/TranscriptionCoordinator";
import type { SystemSculptSettings } from "../types";
import { formatFileSize, validateBrowserFileSize } from "../utils/FileValidator";
import { launchAudioTranscriptionPanel } from "./AudioTranscriptionPanel";

type AudioSource = "vault" | "device";
type TranscriptionOutputFormat = "markdown" | "srt";

type TranscribeAudioSelection =
  | { kind: "vault"; file: TFile }
  | { kind: "device"; file: File };

const DEFAULT_RECORDINGS_DIRECTORY = "SystemSculpt/Recordings";
const MAX_VISIBLE_FILES = 50;

const sanitizeFileName = (name: string): string =>
  name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();

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

  private source: AudioSource = "vault";
  private outputFormat: TranscriptionOutputFormat;
  private rememberFormat = false;
  private selected: TranscribeAudioSelection | null = null;
  private audioFiles: TFile[] = [];
  private filteredFiles: TFile[] = [];
  private searchQuery = "";
  private focusedFilePath: string | null = null;
  private isLaunching = false;
  private launchGeneration = 0;
  private launchSurfaceOpen = false;

  private tabs: UiTabsHandle<AudioSource> | null = null;
  private outputGroup: UiRadioGroupHandle<TranscriptionOutputFormat> | null = null;
  private search: UiSearchHandle | null = null;
  private listEl: HTMLElement | null = null;
  private selectionEl: HTMLElement | null = null;
  private fileInputEl: HTMLInputElement | null = null;
  private transcribeButton: HTMLButtonElement | null = null;
  private previewAudioEl: HTMLAudioElement | null = null;
  private previewObjectUrl: string | null = null;

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
      "Transcribe",
      () => void this.handleTranscribe(),
      true,
      "mic",
    );
    this.transcribeButton.addClass("ss-transcribe-audio__transcribe-btn");
    this.addActionButton("Cancel", () => this.close(), false, "x");

    this.renderLayout();
    this.refreshAudioFiles();
    this.syncTranscribeButton();
  }

  onClose(): void {
    this.launchSurfaceOpen = false;
    this.launchGeneration += 1;
    this.isLaunching = false;
    this.tabs?.destroy();
    this.tabs = null;
    this.outputGroup?.destroy();
    this.outputGroup = null;
    this.search?.destroy();
    this.search = null;
    this.clearPreview();
    this.fileInputEl = null;
    this.listEl = null;
    this.selectionEl = null;
    this.transcribeButton = null;
    super.onClose();
  }

  private renderLayout(): void {
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "ss-transcribe-audio" });

    this.buildSourcePicker(shell);
    this.buildSelection(shell);
    this.buildOutputPicker(shell);
  }

  private buildSourcePicker(container: HTMLElement): void {
    const section = container.createEl("section", {
      cls: "ss-transcribe-audio__section ss-transcribe-audio__source",
      attr: { "aria-label": "Audio source" },
    });

    const tablist = section.createDiv({
      cls: "ss-transcribe-audio__tabs",
      attr: { "aria-label": "Choose audio source" },
    });
    const vaultTab = createUiAction(tablist, { label: "Vault", icon: "folder" });
    const deviceTab = createUiAction(tablist, { label: "Device", icon: "upload" });
    vaultTab.addClass("ss-transcribe-audio__tab");
    deviceTab.addClass("ss-transcribe-audio__tab");

    const vaultPanel = section.createDiv({ cls: "ss-transcribe-audio__source-panel" });
    const devicePanel = section.createDiv({ cls: "ss-transcribe-audio__source-panel" });
    this.buildVaultPanel(vaultPanel);
    this.buildDevicePanel(devicePanel);

    this.tabs = createUiTabs(
      tablist,
      [
        { id: "vault", button: vaultTab, panel: vaultPanel },
        { id: "device", button: deviceTab, panel: devicePanel },
      ],
      {
        activeId: this.source,
        onChange: (source) => {
          this.source = source;
          if (source === "vault") this.search?.input.focus();
        },
      },
    );
  }

  private buildVaultPanel(container: HTMLElement): void {
    this.search = createUiSearch(container, {
      label: "Search vault audio",
      placeholder: "Search by name or path",
      value: this.searchQuery,
      onQuery: (query) => {
        this.searchQuery = query;
        this.updateFilteredFiles();
      },
    });

    this.listEl = container.createDiv({
      cls: "ss-transcribe-audio__list",
      attr: {
        role: "listbox",
        "aria-label": "Vault audio files",
      },
    });

    this.registerDomEvent(this.listEl, "click", (event: Event) => {
      const button = (event.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>(".ss-transcribe-audio__file");
      if (!button || !this.listEl?.contains(button)) return;
      const file = this.filteredFiles
        .slice(0, MAX_VISIBLE_FILES)
        .find((candidate) => candidate.path === button.dataset.path);
      if (!file) return;
      this.focusedFilePath = file.path;
      this.handleVaultSelection(file);
    });
    this.registerDomEvent(this.listEl, "keydown", (event: Event) => {
      const keyboardEvent = event as KeyboardEvent;
      const button = (keyboardEvent.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>(".ss-transcribe-audio__file");
      if (!button || !this.listEl?.contains(button)) return;
      this.handleFileKeydown(keyboardEvent, button.dataset.path ?? "");
    });
  }

  private buildDevicePanel(container: HTMLElement): void {
    const dropzone = container.createDiv({ cls: "ss-transcribe-audio__dropzone" });
    setIcon(
      dropzone.createSpan({
        cls: "ss-transcribe-audio__drop-icon",
        attr: { "aria-hidden": "true" },
      }),
      "file-audio",
    );

    dropzone.createDiv({
      cls: "ss-transcribe-audio__drop-title",
      text: "Choose audio from this device",
    });
    dropzone.createDiv({
      cls: "ss-transcribe-audio__drop-hint",
      text: "You can also drop a file here.",
    });

    const inputId = `ss-transcribe-audio-file-${this.instanceId}`;
    this.fileInputEl = dropzone.createEl("input", {
      cls: "ss-transcribe-audio__file-input",
      attr: {
        id: inputId,
        type: "file",
        accept: Array.from(AUDIO_FILE_EXTENSIONS).map((extension) => `.${extension}`).join(","),
      },
    }) as HTMLInputElement;

    dropzone.createEl("label", {
      cls: "ss-button ss-button--primary ss-transcribe-audio__choose-file",
      text: "Choose audio file",
      attr: { for: inputId },
    });

    const accepted = Array.from(AUDIO_FILE_EXTENSIONS)
      .map((extension) => extension.toUpperCase())
      .join(" · ");
    dropzone.createDiv({
      cls: "ss-transcribe-audio__accepted",
      text: accepted,
    });

    this.registerDomEvent(this.fileInputEl, "change", () => {
      const file = this.fileInputEl?.files?.[0];
      if (file) void this.handleDeviceSelection(file);
    });

    this.registerDomEvent(dropzone, "dragenter", (event: Event) => {
      event.preventDefault();
      dropzone.addClass("is-dragging");
    });
    this.registerDomEvent(dropzone, "dragover", (event: Event) => {
      event.preventDefault();
      dropzone.addClass("is-dragging");
    });
    this.registerDomEvent(dropzone, "dragleave", (event: Event) => {
      event.preventDefault();
      if (!dropzone.contains((event as DragEvent).relatedTarget as Node | null)) {
        dropzone.removeClass("is-dragging");
      }
    });
    this.registerDomEvent(dropzone, "drop", (event: Event) => {
      const dragEvent = event as DragEvent;
      dragEvent.preventDefault();
      dropzone.removeClass("is-dragging");
      const file = Array.from(dragEvent.dataTransfer?.files ?? []).find((candidate) =>
        isAudioFileExtension(this.extensionOf(candidate.name)),
      );
      if (!file) {
        new Notice("Choose a supported audio file.", 4500);
        return;
      }
      void this.handleDeviceSelection(file);
    });
  }

  private buildSelection(container: HTMLElement): void {
    const section = container.createEl("section", {
      cls: "ss-transcribe-audio__section ss-transcribe-audio__selection-section",
    });
    section.createEl("h3", {
      cls: "ss-transcribe-audio__section-title",
      text: "Selected audio",
    });
    this.selectionEl = section.createDiv({ cls: "ss-transcribe-audio__selection" });
    this.renderSelection();
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
      "Markdown",
      "Readable note",
      "file-text",
    );
    const srtButton = this.createOutputOption(
      options,
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
    }) as HTMLInputElement;
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
    label: string,
    detail: string,
    icon: string,
  ): HTMLButtonElement {
    const button = createUiAction(container, { label, icon });
    button.addClass("ss-transcribe-audio__output-option");
    button.createSpan({ cls: "ss-transcribe-audio__output-detail", text: detail });
    return button;
  }

  private refreshAudioFiles(): void {
    const candidates = this.plugin.vaultFileCache?.getAllFiles() ?? this.app.vault.getFiles();
    this.audioFiles = candidates
      .filter((file) => isAudioFileExtension(file.extension))
      .sort((left, right) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0));
    this.updateFilteredFiles();
  }

  private updateFilteredFiles(): void {
    const needle = this.searchQuery.trim().toLocaleLowerCase();
    this.filteredFiles = needle
      ? this.audioFiles.filter((file) =>
          `${file.basename} ${file.path}`.toLocaleLowerCase().includes(needle),
        )
      : [...this.audioFiles];

    const visible = this.filteredFiles.slice(0, MAX_VISIBLE_FILES);
    if (!visible.some((file) => file.path === this.focusedFilePath)) {
      const selectedPath = this.selected?.kind === "vault" ? this.selected.file.path : null;
      this.focusedFilePath = visible.some((file) => file.path === selectedPath)
        ? selectedPath
        : visible[0]?.path ?? null;
    }
    this.renderFileList();
  }

  private renderFileList(): void {
    if (!this.listEl) return;
    const previousScroll = this.listEl.scrollTop;
    this.listEl.empty();

    if (this.filteredFiles.length === 0) {
      createUiState(this.listEl, {
        kind: "empty",
        icon: "file-audio",
        title: this.audioFiles.length === 0 ? "No audio in this vault" : "No matching audio",
        detail: this.audioFiles.length === 0
          ? "Use the Device tab to choose a file."
          : "Try a different name or path.",
      });
      return;
    }

    const visible = this.filteredFiles.slice(0, MAX_VISIBLE_FILES);
    visible.forEach((file) => {
      const selected = this.isSelectedVaultFile(file);
      const item = this.listEl!.createEl("button", {
        cls: "ss-transcribe-audio__file",
        attr: {
          type: "button",
          role: "option",
          "aria-selected": String(selected),
          "data-path": file.path,
          tabindex: file.path === this.focusedFilePath ? "0" : "-1",
        },
      });

      const meta = item.createSpan({ cls: "ss-transcribe-audio__file-meta" });
      meta.createSpan({ cls: "ss-transcribe-audio__file-name", text: file.basename });
      meta.createSpan({ cls: "ss-transcribe-audio__file-path", text: file.path });
      item.createSpan({
        cls: "ss-transcribe-audio__file-size",
        text: formatFileSize(file.stat?.size ?? 0),
      });
      item.classList.toggle("is-selected", selected);
    });

    if (this.filteredFiles.length > MAX_VISIBLE_FILES) {
      this.listEl.createDiv({
        cls: "ss-transcribe-audio__more",
        text: `Showing the first ${MAX_VISIBLE_FILES} of ${this.filteredFiles.length}. Search to narrow the list.`,
      });
    }
    this.listEl.scrollTop = previousScroll;
  }

  private handleFileKeydown(event: KeyboardEvent, currentPath: string): void {
    const files = this.filteredFiles.slice(0, MAX_VISIBLE_FILES);
    const index = files.findIndex((file) => file.path === currentPath);
    if (index < 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = Math.min(index + 1, files.length - 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = files.length - 1;
    if (nextIndex === null || nextIndex === index) return;

    event.preventDefault();
    const next = files[nextIndex];
    this.focusedFilePath = next.path;
    this.handleVaultSelection(next);
    Array.from(
      this.listEl?.querySelectorAll<HTMLButtonElement>(".ss-transcribe-audio__file") ?? [],
    ).find((button) => button.dataset.path === next.path)?.focus();
  }

  private handleVaultSelection(file: TFile): void {
    this.selected = { kind: "vault", file };
    this.syncSelectedFileState();
    this.renderSelection();
    this.syncTranscribeButton();
  }

  private async handleDeviceSelection(file: File): Promise<void> {
    if (!isAudioFileExtension(this.extensionOf(file.name))) {
      new Notice("Choose a supported audio file.", 4500);
      return;
    }
    const maxBytes = getTranscriptionMaxFileSize();
    if (!(await validateBrowserFileSize(file, this.app, {
      maxBytes,
      maxLabel: formatFileSize(maxBytes),
      title: "Audio File Size Limit Exceeded",
      description: "Choose a smaller audio file before importing it into the vault.",
    }))) return;

    this.selected = { kind: "device", file };
    this.syncSelectedFileState();
    this.renderSelection();
    this.syncTranscribeButton();
  }

  private syncSelectedFileState(): void {
    this.listEl?.querySelectorAll<HTMLElement>(".ss-transcribe-audio__file").forEach((item) => {
      const selected = this.selected?.kind === "vault"
        && item.dataset.path === this.selected.file.path;
      item.classList.toggle("is-selected", selected);
      item.setAttr("aria-selected", String(selected));
      item.tabIndex = item.dataset.path === this.focusedFilePath ? 0 : -1;
    });
  }

  private renderSelection(): void {
    if (!this.selectionEl) return;
    this.clearPreview();
    this.selectionEl.empty();

    if (!this.selected) {
      this.selectionEl.addClass("is-empty");
      this.selectionEl.createDiv({
        cls: "ss-transcribe-audio__selection-empty",
        text: "No audio selected.",
      });
      return;
    }

    this.selectionEl.removeClass("is-empty");
    const name = this.selected.file.name;
    const path = this.selected.kind === "vault"
      ? this.selected.file.path
      : "From this device";
    const size = this.selected.kind === "vault"
      ? this.selected.file.stat?.size ?? 0
      : this.selected.file.size;

    const summary = this.selectionEl.createDiv({ cls: "ss-transcribe-audio__selection-summary" });
    const icon = summary.createSpan({
      cls: "ss-transcribe-audio__selection-icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(icon, "file-audio");
    const copy = summary.createDiv({ cls: "ss-transcribe-audio__selection-copy" });
    copy.createDiv({ cls: "ss-transcribe-audio__selection-name", text: name });
    copy.createDiv({
      cls: "ss-transcribe-audio__selection-path",
      text: `${path} · ${formatFileSize(size)}`,
    });

    const audio = this.selectionEl.createEl("audio", {
      cls: "ss-transcribe-audio__audio",
      attr: { controls: "true", preload: "metadata" },
    });
    this.previewAudioEl = audio;
    const source = this.previewSource(this.selected);
    if (source) audio.src = source;
  }

  private previewSource(selection: TranscribeAudioSelection): string | null {
    if (selection.kind === "vault") {
      return this.app.vault.getResourcePath(selection.file);
    }
    const urlApi = this.ownerWindow.URL;
    if (typeof urlApi?.createObjectURL !== "function") return null;
    this.previewObjectUrl = urlApi.createObjectURL(selection.file);
    return this.previewObjectUrl;
  }

  private clearPreview(): void {
    if (this.previewAudioEl) {
      this.previewAudioEl.pause();
      this.previewAudioEl.removeAttribute("src");
      this.previewAudioEl.load();
      this.previewAudioEl = null;
    }
    if (this.previewObjectUrl) {
      this.ownerWindow.URL.revokeObjectURL(this.previewObjectUrl);
      this.previewObjectUrl = null;
    }
  }

  private syncTranscribeButton(): void {
    if (!this.transcribeButton) return;
    updateUiAction(this.transcribeButton, {
      label: this.isLaunching ? "Preparing…" : "Transcribe",
      disabled: !this.selected || this.isLaunching,
      busy: this.isLaunching,
    });
  }

  private async handleTranscribe(): Promise<void> {
    if (!this.selected || this.isLaunching) return;
    const selection = this.selected;
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
    selection: TranscribeAudioSelection,
    launchGeneration: number,
  ): Promise<TFile | null> {
    if (selection.kind === "vault") return selection.file;

    const directory = normalizePath(
      this.plugin.settings.recordingsDirectory || DEFAULT_RECORDINGS_DIRECTORY,
    );
    await this.plugin.directoryManager.ensureDirectoryByPath(directory);
    if (!this.isCurrentLaunch(launchGeneration)) return null;

    const safeName = sanitizeFileName(selection.file.name) || `audio.${this.extensionOf(selection.file.name)}`;
    const bytes = await selection.file.arrayBuffer();
    if (!this.isCurrentLaunch(launchGeneration)) return null;
    const created = await this.createImportedAudio(directory, safeName, bytes);
    if (!(created instanceof TFile)) {
      throw new Error("The audio file could not be saved in the vault.");
    }
    if (!this.isCurrentLaunch(launchGeneration)) {
      await this.discardCancelledImport(selection, created);
      return null;
    }
    return created;
  }

  private isCurrentLaunch(launchGeneration: number): boolean {
    return this.launchSurfaceOpen && this.launchGeneration === launchGeneration;
  }

  private async discardCancelledImport(
    selection: TranscribeAudioSelection,
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
    bytes: ArrayBuffer,
  ): Promise<TFile> {
    const timestamp = Date.now();
    const dotIndex = safeName.lastIndexOf(".");
    const stem = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
    const suffix = dotIndex > 0 ? safeName.slice(dotIndex) : "";

    for (let attempt = 1; attempt <= 1_000; attempt += 1) {
      const candidateName = attempt === 1
        ? safeName
        : `${stem}-${attempt}${suffix}`;
      const path = normalizePath(`${directory}/${timestamp}_${candidateName}`);
      if (this.app.vault.getAbstractFileByPath(path)) continue;

      try {
        return await this.app.vault.createBinary(path, bytes);
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

  private isSelectedVaultFile(file: TFile): boolean {
    return this.selected?.kind === "vault" && this.selected.file.path === file.path;
  }

  private get ownerWindow(): Window & { URL: typeof URL } {
    return getSurfaceOwnerWindow(this.modalEl) as Window & { URL: typeof URL };
  }
}
