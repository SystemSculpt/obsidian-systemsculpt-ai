import { Notice, TFile, setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import SystemSculptPlugin from "../main";
import {
  AUDIO_FILE_EXTENSIONS,
  isAudioFileExtension,
  normalizeFileExtension,
} from "../constants/fileTypes";
import {
  formatFileSize,
  validateBrowserFileSize,
} from "../utils/FileValidator";
import { MeetingProcessorOptions } from "../types";
import { ensureCanonicalId } from "../utils/modelUtils";
import { TranscriptionService } from "../services/TranscriptionService";
import { normalizePath } from "obsidian";
// Simple filename sanitizer (keep ASCII, replace illegal chars)
const sanitizeFileName = (name: string): string => {
  return name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
};

export type MeetingProcessorSelection =
  | { kind: "vault"; file: TFile }
  | { kind: "upload"; file: File };

export interface MeetingProcessorModalOptions {
  onProcess?: (
    selection: MeetingProcessorSelection,
    options: MeetingProcessorOptions
  ) => Promise<void> | void;
}

export class MeetingProcessorModal extends StandardModal {
  private plugin: SystemSculptPlugin;
  private options: MeetingProcessorModalOptions;

  private audioFiles: TFile[] = [];
  private filteredFiles: TFile[] = [];

  private listEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private dropzoneEl: HTMLElement | null = null;
  private selectionSummaryEl: HTMLElement | null = null;
  private processButton: HTMLButtonElement | null = null;
  private fileInputEl: HTMLInputElement | null = null;
  private previewAudioEl: HTMLAudioElement | null = null;
  private previewObjectUrl: string | null = null;
  private backButton: HTMLButtonElement | null = null;
  private step: "select" | "options" = "select";
  private progressEl: HTMLElement | null = null;

  private selected: MeetingProcessorSelection | null = null;
  private processingOptions: MeetingProcessorOptions;

  constructor(
    plugin: SystemSculptPlugin,
    options: MeetingProcessorModalOptions = {}
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.options = options;
    const savedOptions =
      this.plugin.settings.meetingProcessorOptions ||
      MeetingProcessorModal.getDefaultOptions();
    this.processingOptions = { ...savedOptions };
    this.setSize("large");
    // Allow vertical scrolling when content exceeds the modal height
    this.modalEl.addClass("ss-modal--scrollable");
  }

  private static getDefaultOptions(): MeetingProcessorOptions {
    return {
      summary: true,
      actionItems: true,
      decisions: true,
      risks: false,
      questions: false,
      transcriptCleanup: true,
    };
  }

  onOpen(): void {
    super.onOpen();

    this.addTitle(
      "Meeting Processor",
      "Select a meeting audio file from your vault or drop a recording from your device. Process stays disabled until something is selected."
    );

    const processBtn = this.addActionButton(
      "Process",
      () => this.handleProcess(),
      true,
      "play"
    );
    processBtn.disabled = true;
    processBtn.addClass("ss-meeting-processor__process-btn");
    this.processButton = processBtn;

    this.addActionButton("Cancel", () => this.close(), false, "x");
    const backBtn = this.addActionButton("Back", () => this.goBack(), false, "arrow-left");
    backBtn.hide();
    this.backButton = backBtn;

    this.renderSelectStep();
  }

  private renderSelectStep(): void {
    this.step = "select";
    this.contentEl.empty();

    this.progressEl = this.contentEl.createDiv({ cls: "ss-meeting-processor__progress", text: "" });

    const shell = this.contentEl.createDiv({ cls: "ss-meeting-processor" });

    const vaultColumn = shell.createDiv({
      cls: "ss-meeting-processor__column",
    });
    const uploadColumn = shell.createDiv({
      cls: "ss-meeting-processor__column ss-meeting-processor__column--panel",
    });

    this.buildVaultPicker(vaultColumn);
    this.buildUploadPanel(uploadColumn);
    this.buildSelectionSummary(uploadColumn);

    if (this.processButton) {
      this.processButton.setText("Next");
      this.processButton.disabled = !this.selected;
    }
    this.backButton?.hide();
    this.refreshAudioFiles();
  }

  private buildVaultPicker(container: HTMLElement): void {
    const header = container.createDiv({
      cls: "ss-meeting-processor__section-title",
      text: "Pick from your vault",
    });
    header.createDiv({
      cls: "ss-meeting-processor__section-hint",
      text: "Only audio files are shown.",
    });

    const search = container.createDiv({
      cls: "ss-meeting-processor__search",
    });
    const icon = search.createDiv({
      cls: "ss-meeting-processor__search-icon",
    });
    setIcon(icon, "search");

    this.searchInputEl = search.createEl("input", {
      type: "text",
      placeholder: "Search by name or path",
      cls: "ss-meeting-processor__search-input",
    });

    this.registerDomEvent(this.searchInputEl, "input", () => {
      this.applyFilter(this.searchInputEl?.value || "");
    });

    const list = container.createDiv({
      cls: "ss-meeting-processor__list",
    });
    this.listEl = list;
  }

  private buildUploadPanel(container: HTMLElement): void {
    const header = container.createDiv({
      cls: "ss-meeting-processor__section-title",
      text: "Drop or upload audio",
    });
    header.createDiv({
      cls: "ss-meeting-processor__section-hint",
      text: "Drag in a file or tap to choose from your computer or phone.",
    });

    const dropzone = container.createDiv({
      cls: "ss-meeting-processor__dropzone",
    });
    this.dropzoneEl = dropzone;

    const dropMain = dropzone.createDiv({
      cls: "ss-meeting-processor__drop-main",
      text: "Drag & drop a recording",
    });
    setIcon(
      dropMain.createSpan({ cls: "ss-meeting-processor__drop-icon" }),
      "upload"
    );

    dropzone.createDiv({
      cls: "ss-meeting-processor__drop-sub",
      text: "Or tap to browse from this device (desktop or phone).",
    });

    const extensions = Array.from(AUDIO_FILE_EXTENSIONS)
      .map((ext) => ext.toUpperCase())
      .join(" · ");
    dropzone.createDiv({
      cls: "ss-meeting-processor__drop-hint",
      text: `Accepted: ${extensions}`,
    });

    this.fileInputEl = dropzone.createEl("input", {
      type: "file",
      attr: {
        accept: "audio/*",
      },
      cls: "ss-meeting-processor__file-input",
    }) as HTMLInputElement;

    this.registerDomEvent(dropzone, "click", () =>
      this.fileInputEl?.click()
    );

    ["dragenter", "dragover"].forEach((event) => {
      this.registerDomEvent(dropzone, event, (e: DragEvent) => {
        e.preventDefault();
        dropzone.addClass("is-dragging");
      });
    });

    ["dragleave", "dragexit"].forEach((event) => {
      this.registerDomEvent(dropzone, event, (e: DragEvent) => {
        e.preventDefault();
        dropzone.removeClass("is-dragging");
      });
    });

    this.registerDomEvent(dropzone, "drop", (e: DragEvent) => {
      e.preventDefault();
      dropzone.removeClass("is-dragging");
      const files = Array.from(e.dataTransfer?.files || []);
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
  }

  private buildSelectionSummary(container: HTMLElement): void {
    container.createDiv({
      cls: "ss-meeting-processor__section-title",
      text: "Selection",
    });

    this.selectionSummaryEl = container.createDiv({
      cls: "ss-meeting-processor__selection",
    });

    this.renderSelectionSummary();
  }

  private renderOptionsStep(): void {
    this.step = "options";
    this.contentEl.empty();

    const shell = this.contentEl.createDiv({
      cls: "ss-meeting-processor ss-meeting-processor--options",
    });

    const optsCol = shell.createDiv({
      cls: "ss-meeting-processor__column",
    });

    optsCol.createDiv({
      cls: "ss-meeting-processor__section-title",
      text: "Choose what to extract",
    });
    optsCol.createDiv({
      cls: "ss-meeting-processor__section-hint",
      text: "Select the outputs you want from this meeting audio.",
    });

    const options: Array<{ key: keyof MeetingProcessorOptions; label: string; desc: string }> = [
      { key: "summary", label: "Summary", desc: "Concise recap of key points." },
      { key: "actionItems", label: "Action items", desc: "Who does what by when." },
      { key: "decisions", label: "Decisions", desc: "Confirmed choices and rationale." },
      { key: "risks", label: "Risks & blockers", desc: "Issues, dependencies, open risks." },
      { key: "questions", label: "Questions", desc: "Open questions or follow-ups." },
      { key: "transcriptCleanup", label: "Clean transcript", desc: "Lightly cleaned, speaker-agnostic transcript." },
    ];

    const list = optsCol.createDiv({ cls: "ss-meeting-processor__option-list" });

    options.forEach((opt) => {
      const row = list.createDiv({ cls: "ss-meeting-processor__option" });
      const checkbox = row.createEl("input", {
        type: "checkbox",
        cls: "ss-meeting-processor__option-checkbox",
      }) as HTMLInputElement;
      checkbox.checked = this.processingOptions[opt.key];
      this.registerDomEvent(checkbox, "change", () => {
        this.processingOptions[opt.key] = checkbox.checked;
        this.syncProcessButton();
        void this.persistOptions();
      });

      const body = row.createDiv({ cls: "ss-meeting-processor__option-body" });
      body.createDiv({ cls: "ss-meeting-processor__option-title", text: opt.label });
      body.createDiv({ cls: "ss-meeting-processor__option-desc", text: opt.desc });
    });

    if (this.processButton) {
      this.processButton.setText("Process");
      this.processButton.disabled = !this.hasAnyOptionSelected();
    }
    this.backButton?.show();

    // Output destination controls
    const destCol = shell.createDiv({
      cls: "ss-meeting-processor__column ss-meeting-processor__column--panel",
    });

    destCol.createDiv({
      cls: "ss-meeting-processor__section-title",
      text: "Output location",
    });
    destCol.createDiv({
      cls: "ss-meeting-processor__section-hint",
      text: "Choose where to save the processed note and how to name it.",
    });

    const folderRow = destCol.createDiv({ cls: "ss-meeting-processor__field" });
    folderRow.createDiv({ cls: "ss-meeting-processor__field-label", text: "Folder" });
    const folderInput = folderRow.createEl("input", {
      type: "text",
      value: this.plugin.settings.meetingProcessorOutputDirectory || "SystemSculpt/Extractions",
      cls: "ss-meeting-processor__field-input",
      placeholder: "SystemSculpt/Extractions",
    }) as HTMLInputElement;
    this.registerDomEvent(folderInput, "input", async () => {
      await this.persistOutputSettings(folderInput.value, nameInput.value);
    });

    const nameRow = destCol.createDiv({ cls: "ss-meeting-processor__field" });
    nameRow.createDiv({ cls: "ss-meeting-processor__field-label", text: "Filename template" });
    const nameInput = nameRow.createEl("input", {
      type: "text",
      value: this.plugin.settings.meetingProcessorOutputNameTemplate || "{{basename}}-processed.md",
      cls: "ss-meeting-processor__field-input",
      placeholder: "{{basename}}-processed.md",
    }) as HTMLInputElement;
    this.registerDomEvent(nameInput, "input", async () => {
      await this.persistOutputSettings(folderInput.value, nameInput.value);
    });

    destCol.createDiv({
      cls: "ss-meeting-processor__field-hint",
      text: "Use {{basename}} to insert the audio filename without extension. Extension optional; defaults to .md.",
    });
  }

  private refreshAudioFiles(): void {
    const candidates =
      this.plugin.vaultFileCache?.getAllFiles() || this.app.vault.getFiles();

    this.audioFiles = candidates.filter((file) =>
      isAudioFileExtension(file.extension)
    );

    // Sort newest first to make "yesterday's meeting" easy to find
    this.audioFiles.sort(
      (a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0)
    );

    this.filteredFiles = [...this.audioFiles];
    this.renderFileList();
  }

  private applyFilter(query: string): void {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      this.filteredFiles = [...this.audioFiles];
    } else {
      this.filteredFiles = this.audioFiles.filter((file) => {
        const haystack = `${file.basename} ${file.path}`.toLowerCase();
        return haystack.includes(needle);
      });
    }
    this.renderFileList();
  }

  private renderFileList(): void {
    if (!this.listEl) return;

    const previousScroll = this.listEl.scrollTop;
    this.listEl.empty();

    if (this.filteredFiles.length === 0) {
      const empty = this.listEl.createDiv("ss-meeting-processor__empty");
      setIcon(
        empty.createDiv("ss-meeting-processor__empty-icon"),
        "headphones"
      );
      empty.createDiv({
        cls: "ss-meeting-processor__empty-text",
        text: "No audio found. Drop a file on the right to start.",
      });
      return;
    }

    const limit = 200;
    const filesToRender = this.filteredFiles.slice(0, limit);

    filesToRender.forEach((file) => {
      const item = this.listEl!.createDiv({
        cls: "ss-meeting-processor__file",
        attr: { "data-path": file.path },
      });

      const meta = item.createDiv({ cls: "ss-meeting-processor__file-meta" });
      meta.createDiv({
        cls: "ss-meeting-processor__file-name",
        text: file.basename,
      });
      meta.createDiv({
        cls: "ss-meeting-processor__file-path",
        text: file.path,
      });

      const badge = item.createDiv({
        cls: "ss-meeting-processor__file-badge",
      });
      const badgeIcon = badge.createDiv({
        cls: "ss-meeting-processor__file-badge-icon",
      });
      setIcon(badgeIcon, "headphones");
      badge.createSpan({
        text: this.formatModified(file),
        cls: "ss-meeting-processor__file-badge-text",
      });

      item.addEventListener("click", () => this.handleVaultSelection(file));

      item.classList.toggle("is-selected", this.isSelectedVaultFile(file));
    });

    if (this.filteredFiles.length > limit) {
      this.listEl.createDiv({
        cls: "ss-meeting-processor__more",
        text: `Showing ${limit} of ${this.filteredFiles.length} audio files`,
      });
    }

    this.listEl.scrollTop = previousScroll;
  }

  private handleVaultSelection(file: TFile): void {
    this.selected = { kind: "vault", file };
    this.syncSelectedState(file.path);
    this.renderSelectionSummary();
    this.syncProcessButton();
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
      this.syncProcessButton();
    }

  private syncSelectedState(selectedPath?: string): void {
    if (!this.listEl) return;
    const items = Array.from(
      this.listEl.querySelectorAll<HTMLElement>(".ss-meeting-processor__file")
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
        cls: "ss-meeting-processor__selection-empty",
        text: "Select or drop an audio file to enable processing.",
      });
      return;
    }

    if (this.selected.kind === "vault") {
      this.selectionSummaryEl.createDiv({
        cls: "ss-meeting-processor__selection-path",
        text: this.selected.file.path,
      });
    } else {
      this.selectionSummaryEl.createDiv({
        cls: "ss-meeting-processor__selection-path",
        text: `${this.selected.file.name} · ${formatFileSize(this.selected.file.size)} · ${this.getExtension(
          this.selected.file.name
        ).toUpperCase()}`,
      });
    }

    this.renderPreview(this.selected);
  }

  private syncProcessButton(): void {
    if (!this.processButton) return;
    if (this.step === "select") {
      this.processButton.disabled = !this.selected;
      return;
    }
    this.processButton.disabled = !this.hasAnyOptionSelected();
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

  private renderPreview(selection: MeetingProcessorSelection | null): void {
    if (!this.selectionSummaryEl) return;

    // Clear previous preview container
    this.selectionSummaryEl
      .querySelectorAll(".ss-meeting-processor__preview")
      .forEach((el) => el.remove());

    if (!selection) {
      this.clearPreviewUrl();
      this.previewAudioEl = null;
      return;
    }

    const preview = this.selectionSummaryEl.createDiv({
      cls: "ss-meeting-processor__preview",
    });

    const audio = preview.createEl("audio", {
      attr: { controls: "true", preload: "metadata" },
      cls: "ss-meeting-processor__audio",
    });
    this.previewAudioEl = audio;

    const source = this.buildPreviewSrc(selection);
    if (source) {
      audio.src = source;
    }
  }

  private buildPreviewSrc(selection: MeetingProcessorSelection): string | null {
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

  private async handleProcess(): Promise<void> {
    if (this.step === "select") {
      if (!this.selected) return;
      this.renderOptionsStep();
      return;
    }

    if (!this.selected) return;

    const notice = new Notice("Processing meeting…", 0);
    const updateNotice = (text: string) => {
      try {
        (notice as any).setMessage?.(text);
      } catch {
        new Notice(text, 4000);
      }
    };

    // Close the modal; continue background processing
    this.close();

    try {
      const outputPath = await this.processAudioWithOptions(updateNotice);
      if (this.options.onProcess) {
        await this.options.onProcess(this.selected, this.processingOptions);
      }
      await this.openOutputFile(outputPath);
      updateNotice(`Meeting processed → ${outputPath}`);
      setTimeout(() => notice.hide(), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateNotice(`Processing failed: ${message}`);
      setTimeout(() => notice.hide(), 4000);
    }
  }

  private goBack(): void {
    if (this.step === "options") {
      this.renderSelectStep();
    }
  }

  private hasAnyOptionSelected(): boolean {
    return Object.values(this.processingOptions).some(Boolean);
  }

  private async persistOptions(): Promise<void> {
    try {
      await this.plugin.getSettingsManager().updateSettings({
        meetingProcessorOptions: { ...this.processingOptions },
      });
    } catch (error) {
      // Non-fatal: just log quietly
      console.warn("Failed to persist meeting processor options", error);
    }
  }

  private async persistOutputSettings(directory: string, nameTemplate: string): Promise<void> {
    try {
      await this.plugin.getSettingsManager().updateSettings({
        meetingProcessorOutputDirectory: directory,
        meetingProcessorOutputNameTemplate: nameTemplate,
      });
    } catch (error) {
      console.warn("Failed to persist meeting processor output settings", error);
    }
  }

  onClose(): void {
    this.clearPreviewUrl();
    this.previewAudioEl = null;
    super.onClose();
  }
  /**
   * Processing pipeline:
   * 1) Resolve/ingest the audio file (vault or uploaded)
   * 2) Transcribe via existing TranscriptionService (Groq/Whisper as configured)
   * 3) Run LLM post-processing using the current selected model and the user's chosen sections
   * 4) Save output alongside the audio and notify the user
   */
  private async processAudioWithOptions(update: (msg: string) => void): Promise<string> {
    if (!this.selected) {
      throw new Error("No audio selected.");
    }

    update("Preparing…");

    const audioFile = await this.resolveAudioFile(this.selected);
    update("Transcribing audio…");
    const transcript = await this.transcribeAudio(audioFile);
    update("Extracting meeting outputs…");
    const meetingOutput = await this.generateMeetingOutput(transcript);
    update("Saving note…");
    const outputPath = await this.writeProcessedNote(audioFile, meetingOutput);

    return outputPath;
  }

  private async resolveAudioFile(selection: MeetingProcessorSelection): Promise<TFile> {
    if (selection.kind === "vault") {
      return selection.file;
    }

    // Upload path: drop into configured recordings directory
    const recordingsDir = this.plugin.settings.recordingsDirectory || "SystemSculpt/Recordings";
    const dirPath = normalizePath(recordingsDir);
    const exists = await this.plugin.app.vault.adapter.exists(dirPath);
    if (!exists) {
      await this.plugin.app.vault.createFolder(dirPath);
    }

    const safeName = selection.file.name.replace(/[\\/:*?"<>|]/g, "-");
    const targetPath = normalizePath(`${dirPath}/${Date.now()}_${safeName}`);
    const buffer = await selection.file.arrayBuffer();
    await this.plugin.app.vault.adapter.writeBinary(targetPath, buffer);

    const created = this.plugin.app.vault.getAbstractFileByPath(targetPath);
    if (!(created instanceof TFile)) {
      throw new Error("Failed to store uploaded audio.");
    }
    return created;
  }

  private async transcribeAudio(file: TFile): Promise<string> {
    const service = TranscriptionService.getInstance(this.plugin);
    const text = await service.transcribeFile(file, {
      type: "note",
      timestamped: false,
    });
    if (!text?.trim()) {
      throw new Error("Transcription returned empty text.");
    }
    return text.trim();
  }

  private buildSystemPrompt(): string {
    const sections: string[] = [];
    if (this.processingOptions.summary) sections.push("Summary (3-7 bullets)");
    if (this.processingOptions.actionItems) sections.push("Action Items (owner, due date if stated; mark TBD if missing)");
    if (this.processingOptions.decisions) sections.push("Decisions (what/why)");
    if (this.processingOptions.risks) sections.push("Risks/Blockers (with owners if stated)");
    if (this.processingOptions.questions) sections.push("Questions/Follow-ups");
    if (this.processingOptions.transcriptCleanup) sections.push("Clean Transcript (lightly cleaned, no speaker IDs)");

    return [
      "You are SystemSculpt's meeting processor.",
      "Produce ONLY the sections enabled; omit any disabled ones entirely.",
      "Format as Markdown with clear headings; keep it concise and faithful.",
      "Do not invent owners or dates; if missing, leave as TBD.",
      "Sections to include (in order):",
      ...sections.map((s) => `- ${s}`),
    ].join("\n");
  }

  private async generateMeetingOutput(transcript: string): Promise<string> {
    const modelIdRaw = this.plugin.settings.selectedModelId?.trim();
    if (!modelIdRaw) {
      throw new Error("No model selected in settings.");
    }
    const modelId = ensureCanonicalId(modelIdRaw);

    const messages = [
      { role: "system" as const, content: this.buildSystemPrompt(), message_id: crypto.randomUUID() },
      {
        role: "user" as const,
        content: `Enabled sections: ${Object.entries(this.processingOptions)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ") || "none"}\n\nTranscript:\n${transcript}`,
        message_id: crypto.randomUUID(),
      },
    ];

    let output = "";
    const stream = this.plugin.aiService.streamMessage({
      messages,
      model: modelId,
    });

    for await (const event of stream) {
      if (event.type === "content") {
        output += event.text;
      }
    }

    output = output.trim();
    if (!output) {
      throw new Error("LLM returned empty output.");
    }
    return output;
  }

  private async writeProcessedNote(file: TFile, content: string): Promise<string> {
    const dir = normalizePath(
      this.plugin.settings.meetingProcessorOutputDirectory || "SystemSculpt/Extractions"
    );
    const nameTemplate =
      (this.plugin.settings.meetingProcessorOutputNameTemplate || "{{basename}}-processed.md").trim() ||
      "{{basename}}-processed.md";

    if (!(await this.plugin.app.vault.adapter.exists(dir))) {
      await this.plugin.app.vault.createFolder(dir);
    }

    const baseName = file.basename;
    const filledName = nameTemplate.replace(/{{\s*basename\s*}}/gi, baseName);
    const safeName = sanitizeFileName(filledName || `${baseName}-processed.md`);
    const finalName = safeName.endsWith(".md") ? safeName : `${safeName}.md`;
    const targetPath = normalizePath(`${dir}/${finalName}`);

    const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await this.plugin.app.vault.modify(existing, content);
    } else {
      await this.plugin.app.vault.create(targetPath, content);
    }
    return targetPath;
  }

  private async openOutputFile(path: string): Promise<void> {
    const abstract = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) return;
    const leaf = this.plugin.app.workspace.getLeaf("tab");
    await this.plugin.app.workspace.openLinkText(abstract.path, "", "tab", { state: { mode: "source" } });
    this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

}
