import { Notice, setIcon, type App, type TFile } from "obsidian";
import {
  AUDIO_FILE_EXTENSIONS,
  isAudioFileExtension,
  normalizeFileExtension,
} from "../constants/fileTypes";
import {
  createUiAction,
  createUiSearch,
  createUiState,
  createUiTabs,
  getSurfaceOwnerWindow,
  type UiSearchHandle,
  type UiTabsHandle,
} from "../core/ui/surface";
import { formatFileSize } from "../utils/FileValidator";

export type AudioSourceSelection =
  | Readonly<{ kind: "vault"; file: TFile }>
  | Readonly<{ kind: "device"; file: File }>;

type AudioLocation = "vault" | "device";

export interface AudioSourcePickerOptions {
  app: App;
  /** Every vault file; the picker keeps the audio that `acceptsVaultFile` allows. */
  listFiles: () => readonly TFile[];
  /** False when this host cannot use vault audio: only the device dropzone is shown. */
  vaultAvailable?: boolean;
  /** Extra limits for vault audio, such as a maximum size. */
  acceptsVaultFile?: (file: TFile) => boolean;
  /** Validates a device file before it is selected, showing its own message when it declines. */
  acceptDeviceFile: (file: File) => boolean | Promise<boolean>;
  deviceHint: string;
  sizeLimitLabel?: string;
  onChange: (selection: AudioSourceSelection | null) => void;
}

const MAX_VISIBLE_FILES = 50;
const UNSUPPORTED_AUDIO_MESSAGE = "Choose an MP3, WAV, M4A, MP4, OGG, WebM, or FLAC audio file.";

let nextPickerId = 0;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : normalizeFileExtension(name.slice(dot + 1));
}

function isVaultAudioFile(value: unknown): value is TFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<TFile>;
  return typeof file.path === "string"
    && file.path.trim().length > 0
    && typeof file.name === "string"
    && file.name.trim().length > 0
    && isAudioFileExtension(file.extension)
    && Number.isFinite(file.stat?.size)
    && Number.isFinite(file.stat?.mtime);
}

function isDeviceAudioFile(value: unknown): value is File {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<File>;
  return typeof file.name === "string"
    && isAudioFileExtension(extensionOf(file.name.trim()))
    && Number.isFinite(file.size);
}

/**
 * The audio source half of the Transcribe and Audio Processor modals: a
 * searchable vault list, a device dropzone, the selected-audio preview and
 * its object-URL lifecycle. Each modal keeps only its output options and submit.
 */
export class AudioSourcePicker {
  private readonly id = ++nextPickerId;
  private readonly options: AudioSourcePickerOptions;
  private readonly root: HTMLElement;
  private readonly cleanups: Array<() => void> = [];
  private current: AudioSourceSelection | null = null;
  private audioFiles: TFile[] = [];
  private filteredFiles: TFile[] = [];
  private searchQuery = "";
  private focusedPath: string | null = null;
  private deviceGeneration = 0;
  private destroyed = false;

  private tabs: UiTabsHandle<AudioLocation> | null = null;
  private search: UiSearchHandle | null = null;
  private listEl: HTMLElement | null = null;
  private selectionEl: HTMLElement | null = null;
  private previewAudioEl: HTMLAudioElement | null = null;
  private previewObjectUrl: string | null = null;

  constructor(container: HTMLElement, options: AudioSourcePickerOptions) {
    this.options = options;
    this.root = container.createDiv({ cls: "ss-audio-source" });

    if (options.vaultAvailable === false) {
      this.renderDevicePanel(this.root.createDiv({ cls: "ss-audio-source__panel" }));
    } else {
      this.renderTabs();
    }
    this.renderSelectedSection();
    this.refresh();
  }

  get selection(): AudioSourceSelection | null {
    return this.current;
  }

  /** Puts focus in the vault search when the vault list is showing. */
  focus(): void {
    if (this.tabs?.activeId === "vault") this.search?.input.focus();
  }

  /** Rereads the vault's audio files. */
  refresh(): void {
    if (!this.listEl) return;
    this.audioFiles = this.options.listFiles()
      .filter((file): file is TFile => isVaultAudioFile(file)
        && (this.options.acceptsVaultFile?.(file) ?? true))
      .sort((left, right) => right.stat.mtime - left.stat.mtime);
    this.applyFilter();
  }

  /** Selects a file from this device once it passes the modal's checks. */
  async selectDeviceFile(file: File): Promise<boolean> {
    if (!isDeviceAudioFile(file)) {
      new Notice(UNSUPPORTED_AUDIO_MESSAGE, 5000);
      return false;
    }
    const generation = ++this.deviceGeneration;
    const accepted = this.options.acceptDeviceFile(file);
    // A synchronous check selects at once, before the first await.
    if (!(typeof accepted === "boolean" ? accepted : await accepted)) return false;
    // A newer choice, or closing the modal, wins over a slow check.
    if (this.destroyed || generation !== this.deviceGeneration) return false;
    this.select({ kind: "device", file });
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    this.tabs?.destroy();
    this.tabs = null;
    this.search?.destroy();
    this.search = null;
    this.clearPreview();
    this.listEl = null;
    this.selectionEl = null;
  }

  private renderTabs(): void {
    const tablist = this.root.createDiv({
      cls: "ss-audio-source__tabs",
      attr: { "aria-label": "Audio location" },
    });
    const vaultTab = createUiAction(tablist, { label: "Vault", testId: "audio.source.tab.vault", icon: "folder" });
    const deviceTab = createUiAction(tablist, { label: "Device", testId: "audio.source.tab.device", icon: "upload" });
    vaultTab.addClass("ss-audio-source__tab");
    deviceTab.addClass("ss-audio-source__tab");

    const vaultPanel = this.root.createDiv({ cls: "ss-audio-source__panel" });
    const devicePanel = this.root.createDiv({ cls: "ss-audio-source__panel" });
    this.renderVaultPanel(vaultPanel);
    this.renderDevicePanel(devicePanel);

    this.tabs = createUiTabs(tablist, [
      { id: "vault", button: vaultTab, panel: vaultPanel },
      { id: "device", button: deviceTab, panel: devicePanel },
    ], {
      activeId: "vault",
      onChange: (location) => {
        if (location === "vault") this.search?.input.focus();
      },
    });
  }

  private renderVaultPanel(container: HTMLElement): void {
    this.search = createUiSearch(container, {
      testId: "audio.source.search",
      label: "Search vault audio",
      placeholder: "Search by name or path",
      onQuery: (query) => {
        this.searchQuery = query;
        this.applyFilter();
      },
    });
    this.listEl = container.createDiv({
      cls: "ss-audio-source__list",
      attr: { role: "listbox", "aria-label": "Vault audio files" },
    });
    // One delegated listener serves every row's click and arrow keys.
    this.listen(this.listEl, "click", this.handleListEvent);
    this.listen(this.listEl, "keydown", this.handleListEvent);
  }

  private renderDevicePanel(container: HTMLElement): void {
    const dropzone = container.createDiv({ cls: "ss-audio-source__dropzone" });
    setIcon(dropzone.createSpan({
      cls: "ss-audio-source__drop-icon",
      attr: { "aria-hidden": "true" },
    }), "file-audio");
    dropzone.createDiv({ cls: "ss-audio-source__drop-title", text: "Choose audio" });
    dropzone.createDiv({ cls: "ss-audio-source__drop-hint", text: this.options.deviceHint });

    const inputId = `ss-audio-source-file-${this.id}`;
    const input = dropzone.createEl("input", {
      cls: "ss-audio-source__file-input",
      attr: {
        id: inputId,
        type: "file",
        accept: Array.from(AUDIO_FILE_EXTENSIONS).map((extension) => `.${extension}`).join(","),
        "data-testid": "audio.source.device-input",
      },
    });
    dropzone.createEl("label", {
      cls: "ss-button ss-button--primary ss-audio-source__choose-file",
      text: "Choose audio file",
      attr: { for: inputId },
    });
    const accepted = Array.from(AUDIO_FILE_EXTENSIONS).map((extension) => extension.toUpperCase());
    if (this.options.sizeLimitLabel) accepted.push(this.options.sizeLimitLabel);
    dropzone.createDiv({ cls: "ss-audio-source__accepted", text: accepted.join(" · ") });

    this.listen(input, "change", () => {
      const file = input.files?.[0];
      if (file) void this.selectDeviceFile(file);
    });
    const showDragging = (event: Event): void => {
      event.preventDefault();
      dropzone.addClass("is-dragging");
    };
    this.listen(dropzone, "dragenter", showDragging);
    this.listen(dropzone, "dragover", showDragging);
    this.listen(dropzone, "dragleave", (event) => {
      event.preventDefault();
      if (!dropzone.contains((event as DragEvent).relatedTarget as Node | null)) {
        dropzone.removeClass("is-dragging");
      }
    });
    this.listen(dropzone, "drop", (event) => {
      const dragEvent = event as DragEvent;
      dragEvent.preventDefault();
      dropzone.removeClass("is-dragging");
      const files = Array.from(dragEvent.dataTransfer?.files ?? []);
      const file = files.find((candidate) => isDeviceAudioFile(candidate)) ?? files[0];
      if (file) void this.selectDeviceFile(file);
    });
  }

  private renderSelectedSection(): void {
    const section = this.root.createEl("section", { cls: "ss-audio-source__selected" });
    section.createEl("h3", { cls: "ss-audio-source__title", text: "Selected audio" });
    this.selectionEl = section.createDiv({
      cls: "ss-audio-source__selection",
      attr: { "aria-live": "polite" },
    });
    this.renderSelection();
  }

  private applyFilter(): void {
    const needle = this.searchQuery.trim().toLocaleLowerCase();
    this.filteredFiles = needle
      ? this.audioFiles.filter((file) =>
        `${file.basename} ${file.path}`.toLocaleLowerCase().includes(needle))
      : [...this.audioFiles];

    const visible = this.visibleFiles();
    if (!visible.some((file) => file.path === this.focusedPath)) {
      const selectedPath = this.current?.kind === "vault" ? this.current.file.path : null;
      this.focusedPath = visible.some((file) => file.path === selectedPath)
        ? selectedPath
        : visible[0]?.path ?? null;
    }
    this.renderList();
  }

  private visibleFiles(): TFile[] {
    return this.filteredFiles.slice(0, MAX_VISIBLE_FILES);
  }

  private renderList(): void {
    if (!this.listEl) return;
    const previousScroll = this.listEl.scrollTop;
    this.listEl.empty();

    if (this.filteredFiles.length === 0) {
      const vaultEmpty = this.audioFiles.length === 0;
      createUiState(this.listEl, {
        kind: "empty",
        icon: "file-audio",
        title: vaultEmpty ? "No audio in this vault" : "No matching audio",
        detail: vaultEmpty ? "Use the Device tab to choose a file." : "Try a different name or path.",
      });
      return;
    }

    for (const file of this.visibleFiles()) {
      const row = this.listEl.createEl("button", {
        cls: "ss-audio-source__file",
        attr: {
          type: "button",
          role: "option",
          "data-path": file.path,
          "data-testid": "audio.source.file",
        },
      });
      const copy = row.createSpan({ cls: "ss-audio-source__file-copy" });
      copy.createSpan({ cls: "ss-audio-source__file-name", text: file.basename });
      copy.createSpan({ cls: "ss-audio-source__file-path", text: file.path });
      row.createSpan({ cls: "ss-audio-source__file-size", text: formatFileSize(file.stat.size) });
    }
    this.syncRows();

    if (this.filteredFiles.length > MAX_VISIBLE_FILES) {
      this.listEl.createDiv({
        cls: "ss-audio-source__more",
        text: `Showing ${MAX_VISIBLE_FILES} of ${this.filteredFiles.length}. Search to narrow the list.`,
      });
    }
    this.listEl.scrollTop = previousScroll;
  }

  /** Selection follows focus; the focused row is the list's only tab stop. */
  private readonly handleListEvent = (event: Event): void => {
    const row = (event.target as HTMLElement | null)
      ?.closest<HTMLButtonElement>(".ss-audio-source__file");
    if (!row || !this.listEl?.contains(row)) return;
    const files = this.visibleFiles();
    const index = files.findIndex((file) => file.path === row.dataset.path);
    if (index < 0) return;

    if (event.type === "click") {
      this.selectVaultFile(files[index]);
      return;
    }
    const key = (event as KeyboardEvent).key;
    const nextIndex = key === "ArrowDown" ? Math.min(index + 1, files.length - 1)
      : key === "ArrowUp" ? Math.max(index - 1, 0)
        : key === "Home" ? 0
          : key === "End" ? files.length - 1
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    if (nextIndex === index) return;
    const next = files[nextIndex];
    this.selectVaultFile(next);
    this.rowFor(next.path)?.focus();
  };

  private selectVaultFile(file: TFile): void {
    this.focusedPath = file.path;
    // A vault choice supersedes a device file still being checked.
    this.deviceGeneration += 1;
    this.select({ kind: "vault", file });
  }

  private select(selection: AudioSourceSelection): void {
    this.current = selection;
    this.syncRows();
    this.renderSelection();
    this.options.onChange(selection);
  }

  private syncRows(): void {
    const selectedPath = this.current?.kind === "vault" ? this.current.file.path : null;
    this.listEl?.querySelectorAll<HTMLButtonElement>(".ss-audio-source__file").forEach((row) => {
      const selected = row.dataset.path === selectedPath;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", String(selected));
      row.tabIndex = row.dataset.path === this.focusedPath ? 0 : -1;
    });
  }

  private rowFor(path: string): HTMLButtonElement | undefined {
    return Array.from(this.listEl?.querySelectorAll<HTMLButtonElement>(".ss-audio-source__file") ?? [])
      .find((row) => row.dataset.path === path);
  }

  private renderSelection(): void {
    if (!this.selectionEl) return;
    this.clearPreview();
    this.selectionEl.empty();
    const selection = this.current;
    this.selectionEl.classList.toggle("is-empty", !selection);
    if (!selection) {
      this.selectionEl.createDiv({ cls: "ss-audio-source__selection-empty", text: "No audio selected." });
      return;
    }

    const location = selection.kind === "vault" ? selection.file.path : "From this device";
    const size = selection.kind === "vault" ? selection.file.stat.size : selection.file.size;
    const summary = this.selectionEl.createDiv({ cls: "ss-audio-source__selection-summary" });
    setIcon(summary.createSpan({
      cls: "ss-audio-source__selection-icon",
      attr: { "aria-hidden": "true" },
    }), "file-audio");
    const copy = summary.createDiv({ cls: "ss-audio-source__selection-copy" });
    copy.createDiv({ cls: "ss-audio-source__selection-name", text: selection.file.name.trim() });
    copy.createDiv({
      cls: "ss-audio-source__selection-path",
      text: `${location} · ${formatFileSize(size)}`,
    });

    const source = this.previewSource(selection);
    if (!source) return;
    this.previewAudioEl = this.selectionEl.createEl("audio", {
      cls: "ss-audio-source__preview",
      attr: { controls: "true", preload: "metadata" },
    });
    this.previewAudioEl.src = source;
  }

  private previewSource(selection: AudioSourceSelection): string | null {
    try {
      if (selection.kind === "vault") {
        return this.options.app.vault.getResourcePath(selection.file) || null;
      }
      const urlApi = this.ownerWindow.URL;
      if (typeof urlApi?.createObjectURL !== "function") return null;
      this.previewObjectUrl = urlApi.createObjectURL(selection.file) || null;
      return this.previewObjectUrl;
    } catch {
      return null;
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

  private listen(element: HTMLElement, type: string, listener: (event: Event) => void): void {
    element.addEventListener(type, listener);
    this.cleanups.push(() => element.removeEventListener(type, listener));
  }

  private get ownerWindow(): Window & { URL: typeof URL } {
    return getSurfaceOwnerWindow(this.root) as Window & { URL: typeof URL };
  }
}
