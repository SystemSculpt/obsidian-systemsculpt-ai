import { Notice, TFile, setIcon } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { StandardModal } from "../../core/ui/modals/standard/StandardModal";
import {
  createUiAction,
  createUiSearch,
  createUiState,
  createUiTabs,
  getSurfaceOwnerWindow,
  updateUiAction,
  type UiSearchHandle,
  type UiTabsHandle,
} from "../../core/ui/surface";
import {
  AUDIO_FILE_EXTENSIONS,
  isAudioFileExtension,
} from "../../constants/fileTypes";
import { formatFileSize } from "../../utils/FileValidator";
import {
  canReadVaultAudioInParts,
  createDeviceAudioSource,
  createVaultAudioSource,
} from "./audioSource";
import { AudioProcessorPanel } from "./AudioProcessorPanel";
import { AudioProcessorService } from "./AudioProcessorService";
import {
  AUDIO_PROCESSOR_MAX_AUDIO_BYTES,
  type AudioProcessorSource,
} from "./types";
import { parseYouTubeVideoUrl, requireYouTubeVideoUrl } from "./youtube";

export type AudioProcessorTab = "audio" | "youtube";
type AudioPickerTab = "vault" | "device";
type AudioProcessorSelection =
  | Readonly<{ kind: "vault"; file: TFile }>
  | Readonly<{ kind: "device"; file: File }>;

export interface AudioProcessorModalOptions {
  initialTab?: AudioProcessorTab;
  createService?: (plugin: SystemSculptPlugin) => Pick<AudioProcessorService, "process">;
}

const MAX_VISIBLE_AUDIO_FILES = 50;

export class AudioProcessorModal extends StandardModal {
  private static nextInstanceId = 0;
  private readonly instanceId = ++AudioProcessorModal.nextInstanceId;
  private activeTab: AudioProcessorTab;
  private audioTab: AudioPickerTab = "vault";
  private selectedAudio: AudioProcessorSelection | null = null;
  private youtubeUrl = "";
  private audioFiles: TFile[] = [];
  private filteredAudioFiles: TFile[] = [];
  private searchQuery = "";
  private launching = false;

  private sourceTabs: UiTabsHandle<AudioProcessorTab> | null = null;
  private audioTabs: UiTabsHandle<AudioPickerTab> | null = null;
  private search: UiSearchHandle | null = null;
  private audioListEl: HTMLElement | null = null;
  private selectionEl: HTMLElement | null = null;
  private youtubeInputEl: HTMLInputElement | null = null;
  private youtubeStatusEl: HTMLElement | null = null;
  private processButton: HTMLButtonElement | null = null;
  private previewAudioEl: HTMLAudioElement | null = null;
  private previewObjectUrl: string | null = null;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly options: AudioProcessorModalOptions = {},
  ) {
    super(plugin.app);
    this.activeTab = options.initialTab ?? "audio";
    this.setSize("medium");
    this.modalEl.addClass("ss-modal--scrollable", "ss-audio-processor-modal");
  }

  onOpen(): void {
    super.onOpen();
    this.addTitle(
      "Audio Processor",
      "Turn audio or a YouTube video into a polished note with a linked full transcript.",
    );
    this.processButton = this.addActionButton(
      this.activeTab === "youtube" ? "Process video" : "Process audio",
      () => void this.processAudio(),
      true,
      "sparkles",
    );
    this.addActionButton("Cancel", () => this.close(), false, "x");
    this.render();
    this.refreshAudioFiles();
    this.syncProcessButton();

    this.ownerWindow.setTimeout(() => {
      if (this.activeTab === "youtube") this.youtubeInputEl?.focus();
      else this.search?.input.focus();
    }, 0);
  }

  onClose(): void {
    this.sourceTabs?.destroy();
    this.sourceTabs = null;
    this.audioTabs?.destroy();
    this.audioTabs = null;
    this.search?.destroy();
    this.search = null;
    this.clearPreview();
    this.audioListEl = null;
    this.selectionEl = null;
    this.youtubeInputEl = null;
    this.youtubeStatusEl = null;
    this.processButton = null;
    super.onClose();
  }

  private render(): void {
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "ss-audio-processor" });
    const tablist = shell.createDiv({
      cls: "ss-audio-processor__tabs",
      attr: { "aria-label": "Audio Processor source" },
    });
    const audioButton = createUiAction(tablist, { label: "Audio", icon: "audio-lines" });
    const youtubeButton = createUiAction(tablist, { label: "YouTube", icon: "youtube" });
    audioButton.addClass("ss-audio-processor__tab");
    youtubeButton.addClass("ss-audio-processor__tab");

    const audioPanel = shell.createDiv({ cls: "ss-audio-processor__panel" });
    const youtubePanel = shell.createDiv({ cls: "ss-audio-processor__panel" });
    this.renderAudioPanel(audioPanel);
    this.renderYouTubePanel(youtubePanel);

    this.sourceTabs = createUiTabs(tablist, [
      { id: "audio", button: audioButton, panel: audioPanel },
      { id: "youtube", button: youtubeButton, panel: youtubePanel },
    ], {
      activeId: this.activeTab,
      onChange: (tab) => {
        this.activeTab = tab;
        this.syncProcessButton();
        if (tab === "youtube") this.youtubeInputEl?.focus();
        else if (this.audioTab === "vault") this.search?.input.focus();
      },
    });
  }

  private renderAudioPanel(container: HTMLElement): void {
    const vaultAudioAvailable = canReadVaultAudioInParts(this.app);
    container.createDiv({
      cls: "ss-audio-processor__intro",
      text: vaultAudioAvailable
        ? "Choose a recording from your vault or upload one from this device."
        : "Choose a recording from this device. Large files upload in small parts.",
    });

    if (!vaultAudioAvailable) {
      this.audioTab = "device";
      const devicePanel = container.createDiv({ cls: "ss-audio-processor__audio-panel" });
      this.renderDevicePicker(devicePanel);
      this.renderSelectedAudioSection(container);
      return;
    }

    const tablist = container.createDiv({
      cls: "ss-audio-processor__subtabs",
      attr: { "aria-label": "Audio location" },
    });
    const vaultButton = createUiAction(tablist, { label: "Vault", icon: "folder" });
    const deviceButton = createUiAction(tablist, { label: "Device", icon: "upload" });
    vaultButton.addClass("ss-audio-processor__subtab");
    deviceButton.addClass("ss-audio-processor__subtab");

    const vaultPanel = container.createDiv({ cls: "ss-audio-processor__audio-panel" });
    const devicePanel = container.createDiv({ cls: "ss-audio-processor__audio-panel" });
    this.renderVaultPicker(vaultPanel);
    this.renderDevicePicker(devicePanel);
    this.audioTabs = createUiTabs(tablist, [
      { id: "vault", button: vaultButton, panel: vaultPanel },
      { id: "device", button: deviceButton, panel: devicePanel },
    ], {
      activeId: this.audioTab,
      onChange: (tab) => {
        this.audioTab = tab;
        if (tab === "vault") this.search?.input.focus();
      },
    });

    this.renderSelectedAudioSection(container);
  }

  private renderSelectedAudioSection(container: HTMLElement): void {
    const selectedSection = container.createEl("section", {
      cls: "ss-audio-processor__selected-section",
    });
    selectedSection.createEl("h3", {
      cls: "ss-audio-processor__section-title",
      text: "Selected audio",
    });
    this.selectionEl = selectedSection.createDiv({
      cls: "ss-audio-processor__selection",
      attr: { "aria-live": "polite" },
    });
    this.renderSelection();
  }

  private renderVaultPicker(container: HTMLElement): void {
    this.search = createUiSearch(container, {
      label: "Search vault audio",
      placeholder: "Search by name or path",
      value: this.searchQuery,
      onQuery: (query) => {
        this.searchQuery = query;
        this.filterAudioFiles();
      },
    });
    this.audioListEl = container.createDiv({
      cls: "ss-audio-processor__audio-list",
      attr: { role: "listbox", "aria-label": "Vault audio files" },
    });
    this.registerDomEvent(this.audioListEl, "click", (event: Event) => {
      const button = (event.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>(".ss-audio-processor__audio-file");
      if (!button || !this.audioListEl?.contains(button)) return;
      const file = this.filteredAudioFiles
        .slice(0, MAX_VISIBLE_AUDIO_FILES)
        .find((candidate) => candidate.path === button.dataset.path);
      if (file) this.selectAudio({ kind: "vault", file });
    });
    this.registerDomEvent(this.audioListEl, "keydown", (event: Event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(keyboardEvent.key)) return;
      const current = (keyboardEvent.target as HTMLElement | null)
        ?.closest<HTMLButtonElement>(".ss-audio-processor__audio-file");
      if (!current) return;
      const options = Array.from(
        this.audioListEl?.querySelectorAll<HTMLButtonElement>(
          ".ss-audio-processor__audio-file",
        ) ?? [],
      );
      const index = options.indexOf(current);
      if (index < 0 || options.length === 0) return;
      keyboardEvent.preventDefault();
      const nextIndex = keyboardEvent.key === "Home"
        ? 0
        : keyboardEvent.key === "End"
          ? options.length - 1
          : keyboardEvent.key === "ArrowDown"
            ? Math.min(options.length - 1, index + 1)
            : Math.max(0, index - 1);
      const nextPath = options[nextIndex].dataset.path;
      options[nextIndex].click();
      Array.from(
        this.audioListEl?.querySelectorAll<HTMLButtonElement>(
          ".ss-audio-processor__audio-file",
        ) ?? [],
      ).find((button) => button.dataset.path === nextPath)?.focus();
    });
  }

  private renderDevicePicker(container: HTMLElement): void {
    const dropzone = container.createDiv({ cls: "ss-audio-processor__dropzone" });
    setIcon(dropzone.createSpan({
      cls: "ss-audio-processor__drop-icon",
      attr: { "aria-hidden": "true" },
    }), "file-audio");
    dropzone.createDiv({
      cls: "ss-audio-processor__drop-title",
      text: "Choose audio",
    });
    dropzone.createDiv({
      cls: "ss-audio-processor__drop-hint",
      text: "Large files upload in parts, so hours-long recordings are supported.",
    });
    const inputId = `ss-audio-processor-file-${this.instanceId}`;
    const input = dropzone.createEl("input", {
      cls: "ss-audio-processor__file-input",
      attr: {
        id: inputId,
        type: "file",
        accept: Array.from(AUDIO_FILE_EXTENSIONS).map((extension) => `.${extension}`).join(","),
      },
    }) as HTMLInputElement;
    dropzone.createEl("label", {
      cls: "ss-button ss-button--primary ss-audio-processor__choose-file",
      text: "Choose audio file",
      attr: { for: inputId },
    });
    dropzone.createDiv({
      cls: "ss-audio-processor__accepted",
      text: "MP3 · WAV · M4A · MP4 · OGG · WEBM · FLAC · up to 1 GB",
    });

    this.registerDomEvent(input, "change", () => {
      const file = input.files?.[0];
      if (file) this.trySelectDeviceFile(file);
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
      const file = dragEvent.dataTransfer?.files?.[0];
      if (file) this.trySelectDeviceFile(file);
    });
  }

  private renderYouTubePanel(container: HTMLElement): void {
    container.createDiv({
      cls: "ss-audio-processor__intro",
      text: "Paste a YouTube video link. SystemSculpt handles retrieval, transcription, and summarization on the server.",
    });
    const field = container.createDiv({ cls: "ss-audio-processor__youtube-field" });
    const inputId = `ss-audio-youtube-${this.instanceId}`;
    field.createEl("label", {
      cls: "ss-audio-processor__field-label",
      text: "YouTube video URL",
      attr: { for: inputId },
    });
    this.youtubeInputEl = field.createEl("input", {
      cls: "ss-audio-processor__youtube-input",
      attr: {
        id: inputId,
        type: "url",
        inputmode: "url",
        autocomplete: "off",
        placeholder: "Paste a YouTube video URL",
        "aria-describedby": `${inputId}-status`,
      },
    }) as HTMLInputElement;
    this.youtubeInputEl.spellcheck = false;
    this.youtubeInputEl.value = this.youtubeUrl;
    this.youtubeStatusEl = field.createDiv({
      cls: "ss-audio-processor__youtube-status",
      attr: { id: `${inputId}-status` },
    });
    this.registerDomEvent(this.youtubeInputEl, "input", () => {
      this.youtubeUrl = this.youtubeInputEl?.value ?? "";
      this.renderYouTubeStatus();
      this.syncProcessButton();
    });
    this.renderYouTubeStatus();

    const defaults = container.createDiv({ cls: "ss-audio-processor__defaults" });
    setIcon(defaults.createSpan({ attr: { "aria-hidden": "true" } }), "sparkles");
    const copy = defaults.createDiv();
    copy.createDiv({ cls: "ss-audio-processor__defaults-title", text: "Polished note + full transcript" });
    copy.createDiv({
      cls: "ss-audio-processor__defaults-copy",
      text: "You’ll get a concise note with key points, decisions, action items, and open questions, plus a linked timestamped transcript—no setup required.",
    });
  }

  private refreshAudioFiles(): void {
    if (!canReadVaultAudioInParts(this.app)) {
      this.audioFiles = [];
      this.filteredAudioFiles = [];
      return;
    }
    const candidates = this.plugin.vaultFileCache?.getAllFiles() ?? this.app.vault.getFiles();
    this.audioFiles = candidates
      .filter((file): file is TFile => this.isUsableVaultAudioFile(file))
      .sort((left, right) => right.stat.mtime - left.stat.mtime);
    this.filterAudioFiles();
  }

  private filterAudioFiles(): void {
    const query = this.searchQuery.trim().toLocaleLowerCase();
    this.filteredAudioFiles = query
      ? this.audioFiles.filter((file) =>
        `${file.basename} ${file.path}`.toLocaleLowerCase().includes(query))
      : [...this.audioFiles];
    this.renderAudioList();
  }

  private renderAudioList(): void {
    if (!this.audioListEl) return;
    this.audioListEl.empty();
    const selectedAudio = this.currentAudioSelection();
    const selectedVaultPath = selectedAudio?.kind === "vault"
      ? selectedAudio.file.path
      : null;
    if (this.filteredAudioFiles.length === 0) {
      createUiState(this.audioListEl, {
        kind: "empty",
        icon: "file-audio",
        title: this.audioFiles.length === 0 ? "No audio in this vault" : "No matching audio",
        detail: this.audioFiles.length === 0
          ? "Choose a file from this device instead."
          : "Try a different name or path.",
      });
      return;
    }
    for (const file of this.filteredAudioFiles.slice(0, MAX_VISIBLE_AUDIO_FILES)) {
      const selected = selectedVaultPath === file.path;
      const button = this.audioListEl.createEl("button", {
        cls: "ss-audio-processor__audio-file",
        attr: {
          type: "button",
          role: "option",
          "aria-selected": String(selected),
          "data-path": file.path,
        },
      });
      button.classList.toggle("is-selected", selected);
      const copy = button.createSpan({ cls: "ss-audio-processor__audio-copy" });
      copy.createSpan({ cls: "ss-audio-processor__audio-name", text: file.basename });
      copy.createSpan({ cls: "ss-audio-processor__audio-path", text: file.path });
      button.createSpan({
        cls: "ss-audio-processor__audio-size",
        text: formatFileSize(file.stat.size),
      });
    }
    if (this.filteredAudioFiles.length > MAX_VISIBLE_AUDIO_FILES) {
      this.audioListEl.createDiv({
        cls: "ss-audio-processor__more",
        text: `Showing ${MAX_VISIBLE_AUDIO_FILES} of ${this.filteredAudioFiles.length}. Search to narrow the list.`,
      });
    }
  }

  private trySelectDeviceFile(file: File): void {
    try {
      createDeviceAudioSource(file).release();
      this.selectAudio({ kind: "device", file });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Choose a supported audio file.", 5000);
    }
  }

  private selectAudio(selection: AudioProcessorSelection): void {
    this.selectedAudio = this.normalizeAudioSelection(selection);
    this.renderAudioList();
    this.renderSelection();
    this.syncProcessButton();
  }

  private renderSelection(): void {
    if (!this.selectionEl) return;
    this.clearPreview();
    this.selectionEl.empty();
    const selection = this.currentAudioSelection();
    if (!selection) {
      this.selectionEl.addClass("is-empty");
      this.selectionEl.createDiv({
        cls: "ss-audio-processor__selection-empty",
        text: "No audio selected.",
      });
      return;
    }
    this.selectionEl.removeClass("is-empty");
    const name = selection.file.name.trim();
    const size = selection.kind === "vault"
      ? selection.file.stat.size
      : selection.file.size;
    const location = selection.kind === "vault"
      ? selection.file.path
      : "From this device";
    const summary = this.selectionEl.createDiv({ cls: "ss-audio-processor__selection-summary" });
    setIcon(summary.createSpan({
      cls: "ss-audio-processor__selection-icon",
      attr: { "aria-hidden": "true" },
    }), "file-audio");
    const copy = summary.createDiv({ cls: "ss-audio-processor__selection-copy" });
    copy.createDiv({ cls: "ss-audio-processor__selection-name", text: name });
    copy.createDiv({
      cls: "ss-audio-processor__selection-path",
      text: `${location} · ${formatFileSize(size)}`,
    });
    const previewSource = this.previewSource(selection);
    if (previewSource) {
      const audio = this.selectionEl.createEl("audio", {
        cls: "ss-audio-processor__audio-preview",
        attr: { controls: "true", preload: "metadata" },
      });
      this.previewAudioEl = audio;
      audio.src = previewSource;
    }
  }

  private renderYouTubeStatus(): void {
    if (!this.youtubeStatusEl) return;
    this.youtubeStatusEl.empty();
    const value = this.youtubeUrl.trim();
    if (!value) {
      this.youtubeStatusEl.createDiv({
        cls: "ss-audio-processor__field-hint",
        text: "A full youtube.com or youtu.be video URL is required.",
      });
      return;
    }
    const valid = parseYouTubeVideoUrl(value) !== null;
    createUiState(this.youtubeStatusEl, valid
      ? { kind: "success", icon: "circle-check", title: "YouTube video ready" }
      : {
        kind: "error",
        icon: "circle-alert",
        title: "Enter a valid YouTube video URL",
        detail: "Playlist, channel, search, and non-YouTube URLs aren’t supported.",
      });
  }

  private syncProcessButton(): void {
    if (!this.processButton) return;
    const ready = this.activeTab === "audio"
      ? this.currentAudioSelection() !== null
      : parseYouTubeVideoUrl(this.youtubeUrl) !== null;
    updateUiAction(this.processButton, {
      label: this.launching
        ? "Starting…"
        : this.activeTab === "youtube"
          ? "Process video"
          : "Process audio",
      disabled: !ready || this.launching,
      busy: this.launching,
    });
  }

  private async processAudio(): Promise<void> {
    if (this.launching) return;
    let source: AudioProcessorSource;
    let sourceLabel: string;
    try {
      if (this.activeTab === "youtube") {
        const youtube = requireYouTubeVideoUrl(this.youtubeUrl);
        source = { type: "youtube", url: youtube.url };
        sourceLabel = `YouTube · ${youtube.videoId}`;
      } else {
        const selection = this.currentAudioSelection();
        if (!selection) throw new Error("Choose audio first.");
        const audio = selection.kind === "vault"
          ? createVaultAudioSource(this.app, selection.file)
          : createDeviceAudioSource(selection.file);
        source = { type: "audio", audio };
        sourceLabel = audio.filename;
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Choose a valid audio source.", 5000);
      return;
    }

    this.launching = true;
    this.syncProcessButton();
    const controller = new AbortController();
    this.plugin.register(() => controller.abort());
    const panel = new AudioProcessorPanel(
      this.plugin,
      sourceLabel,
      () => controller.abort(),
      this.modalEl.ownerDocument.body,
    );
    const service = this.options.createService?.(this.plugin) ?? new AudioProcessorService(this.plugin);
    this.close();

    try {
      const note = await service.process(source, {
        signal: controller.signal,
        onProgress: (event) => panel.update(event),
      });
      panel.succeed(note);
    } catch (error) {
      panel.fail(error);
    }
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

  private currentAudioSelection(): AudioProcessorSelection | null {
    const selection = this.normalizeAudioSelection(this.selectedAudio);
    if (selection !== this.selectedAudio) this.selectedAudio = selection;
    return selection;
  }

  private normalizeAudioSelection(value: unknown): AudioProcessorSelection | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const selection = value as { kind?: unknown; file?: unknown };
    if (selection.kind === "device") {
      return this.isUsableDeviceAudioFile(selection.file)
        ? { kind: "device", file: selection.file }
        : null;
    }
    if (selection.kind !== "vault" || !selection.file || typeof selection.file !== "object") {
      return null;
    }
    const path = (selection.file as { path?: unknown }).path;
    if (typeof path !== "string" || !path.trim()) return null;
    let canonical: unknown = null;
    try {
      canonical = this.app.vault.getAbstractFileByPath(path);
    } catch {
      // A vault refresh can race a click. The captured TFile remains the
      // fallback, and the selection still fails closed if it is incomplete.
    }
    const file = this.isUsableVaultAudioFile(canonical) ? canonical : selection.file;
    return this.isUsableVaultAudioFile(file) ? { kind: "vault", file } : null;
  }

  private isUsableVaultAudioFile(value: unknown): value is TFile {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const file = value as Partial<TFile> & { stat?: Partial<TFile["stat"]> };
    return typeof file.path === "string"
      && file.path.trim().length > 0
      && typeof file.name === "string"
      && file.name.trim().length > 0
      && typeof file.extension === "string"
      && isAudioFileExtension(file.extension)
      && !!file.stat
      && Number.isFinite(file.stat.size)
      && (file.stat.size as number) > 0
      && (file.stat.size as number) <= AUDIO_PROCESSOR_MAX_AUDIO_BYTES
      && Number.isFinite(file.stat.mtime);
  }

  private isUsableDeviceAudioFile(value: unknown): value is File {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const file = value as Partial<File>;
    const name = typeof file.name === "string" ? file.name.trim() : "";
    const dot = name.lastIndexOf(".");
    return typeof file.name === "string"
      && name.length > 0
      && dot >= 0
      && isAudioFileExtension(name.slice(dot + 1))
      && Number.isFinite(file.size)
      && (file.size as number) > 0
      && (file.size as number) <= AUDIO_PROCESSOR_MAX_AUDIO_BYTES
      && typeof file.slice === "function";
  }

  private previewSource(selection: AudioProcessorSelection): string | null {
    try {
      if (selection.kind === "vault") {
        return this.app.vault.getResourcePath(selection.file) || null;
      }
      if (typeof this.ownerWindow.URL?.createObjectURL !== "function") return null;
      const url = this.ownerWindow.URL.createObjectURL(selection.file);
      if (!url) return null;
      this.previewObjectUrl = url;
      return url;
    } catch {
      return null;
    }
  }

  private get ownerWindow(): Window & { URL: typeof URL } {
    return getSurfaceOwnerWindow(this.modalEl) as Window & { URL: typeof URL };
  }
}
