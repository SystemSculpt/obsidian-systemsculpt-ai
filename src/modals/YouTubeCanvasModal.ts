import { App, Notice, TFile, setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import type SystemSculptPlugin from "../main";
import { YouTubeMetadataService, type YouTubeMetadata } from "../services/YouTubeMetadataService";
import {
  YouTubeTranscriptService,
  type YouTubeTranscriptResult,
  type CaptionTrack,
  type AvailableLanguagesResult,
} from "../services/YouTubeTranscriptService";
import { getLanguageName } from "../constants/languages";

// ============================================================================
// Types
// ============================================================================

type ModalState =
  | "idle"
  | "loading_preview"
  | "preview_ready"
  | "fetching_transcript"
  | "transcript_ready"
  | "generating"
  | "generation_complete"
  | "creating_note";

type ContentType = "summary" | "keyPoints" | "studyNotes";

interface ContentToggleState {
  summary: boolean;
  keyPoints: boolean;
  studyNotes: boolean;
}

type GeneratedContent = Partial<Record<ContentType, string>>;

// ============================================================================
// Modal Implementation
// ============================================================================

/**
 * Modal for extracting YouTube video transcripts and creating notes
 */
export class YouTubeCanvasModal extends StandardModal {
  private readonly plugin: SystemSculptPlugin;
  private readonly metadataService: YouTubeMetadataService;
  private readonly transcriptService: YouTubeTranscriptService;

  // UI Elements
  private urlInput: HTMLInputElement | null = null;
  private previewSection: HTMLElement | null = null;
  private languageSection: HTMLElement | null = null;
  private transcriptSection: HTMLElement | null = null;
  private folderSection: HTMLElement | null = null;
  private folderInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private getTranscriptBtn: HTMLButtonElement | null = null;
  private createNoteBtn: HTMLButtonElement | null = null;
  private generateBtn: HTMLButtonElement | null = null;
  private toggleSection: HTMLElement | null = null;
  private tabBar: HTMLElement | null = null;
  private tabContent: HTMLElement | null = null;

  // State
  private state: ModalState = "idle";
  private currentUrl = "";
  private metadata: YouTubeMetadata | null = null;
  private availableLanguages: CaptionTrack[] = [];
  private selectedLanguage: string | null = null;
  private transcript: YouTubeTranscriptResult | null = null;
  private contentToggles: ContentToggleState = { summary: true, keyPoints: false, studyNotes: false };
  private generatedContent: GeneratedContent = {};
  private activeTab: ContentType | null = null;
  private generatingType: ContentType | null = null;
  private abortController: AbortController | null = null;

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
    this.metadataService = YouTubeMetadataService.getInstance();
    this.transcriptService = YouTubeTranscriptService.getInstance(plugin);
    this.setSize("large");
    this.modalEl.addClass("ss-youtube-canvas-modal");
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  onOpen(): void {
    super.onOpen();
    this.loadSettings();
    this.buildUI();
  }

  onClose(): void {
    this.abortController?.abort();
    super.onClose();
  }

  // ==========================================================================
  // Settings
  // ==========================================================================

  private loadSettings(): void {
    const saved = this.plugin.settings.youtubeCanvasToggles;
    if (saved) {
      this.contentToggles = { ...saved };
    }
  }

  private async saveToggleSettings(): Promise<void> {
    await this.plugin.getSettingsManager().updateSettings({
      youtubeCanvasToggles: { ...this.contentToggles },
    });
  }

  private async saveFolderSetting(folder: string): Promise<void> {
    await this.plugin.getSettingsManager().updateSettings({
      youtubeNotesFolder: folder,
    });
  }

  // ==========================================================================
  // UI Building
  // ==========================================================================

  private buildUI(): void {
    this.addTitle("YouTube Canvas", "Extract transcripts and generate notes from videos");

    // URL Input
    this.buildUrlInput();

    // Preview Section (video thumbnail + title)
    this.previewSection = this.contentEl.createDiv("ss-youtube-canvas-modal__preview");
    this.previewSection.style.display = "none";

    // Language Section (shown after preview loads, before transcript)
    this.languageSection = this.contentEl.createDiv("ss-youtube-canvas-modal__language-section");
    this.languageSection.style.display = "none";

    // Transcript Section
    this.transcriptSection = this.contentEl.createDiv("ss-youtube-canvas-modal__transcript");
    this.transcriptSection.style.display = "none";

    // Folder Selector
    this.folderSection = this.contentEl.createDiv("ss-youtube-canvas-modal__folder-section");
    this.folderSection.style.display = "none";
    this.buildFolderSelector();

    // Toggle Section (content types)
    this.toggleSection = this.contentEl.createDiv("ss-youtube-canvas-modal__toggles");
    this.toggleSection.style.display = "none";

    // Tab Bar & Content
    this.tabBar = this.contentEl.createDiv("ss-youtube-canvas-modal__tab-bar");
    this.tabBar.style.display = "none";
    this.tabContent = this.contentEl.createDiv("ss-youtube-canvas-modal__tab-content");
    this.tabContent.style.display = "none";

    // Status
    this.statusEl = this.contentEl.createDiv("ss-youtube-canvas-modal__status");
    this.updateStatus("Paste a YouTube URL to get started", "info");

    // Action Buttons
    this.getTranscriptBtn = this.addActionButton("Get Transcript", () => this.fetchTranscript(), false, "download");
    this.getTranscriptBtn.style.display = "none";

    this.generateBtn = this.addActionButton("Generate", () => this.startGeneration(), false, "sparkles");
    this.generateBtn.style.display = "none";

    this.createNoteBtn = this.addActionButton("Create Note", () => this.createNote(), true, "file-plus");
    this.createNoteBtn.style.display = "none";

    this.urlInput?.focus();
  }

  private buildUrlInput(): void {
    const section = this.contentEl.createDiv("ss-youtube-canvas-modal__input-section");
    const wrapper = section.createDiv("ss-youtube-canvas-modal__input-wrapper");

    const icon = wrapper.createDiv("ss-youtube-canvas-modal__input-icon");
    setIcon(icon, "link");

    this.urlInput = wrapper.createEl("input", {
      type: "text",
      placeholder: "Paste YouTube URL (e.g., youtube.com/watch?v=...)",
      cls: "ss-youtube-canvas-modal__input",
    });

    this.registerDomEvent(this.urlInput, "input", () => this.handleUrlInput());
    this.registerDomEvent(this.urlInput, "paste", () => {
      setTimeout(() => this.handleUrlInput(), 10);
    });
  }

  private buildFolderSelector(): void {
    if (!this.folderSection) return;
    this.folderSection.empty();

    const label = this.folderSection.createDiv("ss-youtube-canvas-modal__folder-label");
    const folderIcon = label.createSpan();
    setIcon(folderIcon, "folder");
    label.appendText("Save to:");

    this.folderInput = this.folderSection.createEl("input", {
      type: "text",
      cls: "ss-youtube-canvas-modal__folder-input",
      placeholder: "Folder path (e.g., Notes/YouTube)",
      value: this.plugin.settings.youtubeNotesFolder || "",
    });

    this.registerDomEvent(this.folderInput, "blur", () => {
      this.saveFolderSetting(this.folderInput?.value.trim() || "");
    });

    this.registerDomEvent(this.folderInput, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.saveFolderSetting(this.folderInput?.value.trim() || "");
        this.folderInput?.blur();
      }
    });
  }

  private buildToggleSection(): void {
    if (!this.toggleSection) return;
    this.toggleSection.empty();

    const toggles: Array<{ id: ContentType; label: string; icon: string }> = [
      { id: "summary", label: "Summary", icon: "align-left" },
      { id: "keyPoints", label: "Key Points", icon: "list" },
      { id: "studyNotes", label: "Study Notes", icon: "book-open" },
    ];

    for (const { id, label, icon } of toggles) {
      const container = this.toggleSection.createDiv("ss-youtube-canvas-modal__toggle");

      const checkbox = container.createEl("input", {
        type: "checkbox",
        cls: "ss-youtube-canvas-modal__toggle-checkbox",
      });
      checkbox.checked = this.contentToggles[id];

      const labelEl = container.createEl("label", {
        cls: "ss-youtube-canvas-modal__toggle-label",
      });

      const iconEl = labelEl.createSpan("ss-youtube-canvas-modal__toggle-icon");
      setIcon(iconEl, icon);
      labelEl.appendText(label);

      if (this.generatedContent[id]) {
        const checkIcon = labelEl.createSpan("ss-youtube-canvas-modal__toggle-generated");
        setIcon(checkIcon, "check-circle");
      }

      const handleChange = () => {
        this.contentToggles[id] = checkbox.checked;
        this.updateGenerateButtonState();
        this.saveToggleSettings();
      };

      this.registerDomEvent(checkbox, "change", handleChange);
      this.registerDomEvent(labelEl, "click", () => {
        checkbox.checked = !checkbox.checked;
        handleChange();
      });
    }
  }

  // ==========================================================================
  // URL Handling & Preview
  // ==========================================================================

  private async handleUrlInput(): Promise<void> {
    const url = this.urlInput?.value.trim() || "";

    if (!url) {
      this.resetToIdle();
      return;
    }

    if (!this.metadataService.isValidYouTubeUrl(url)) {
      this.updateStatus("Please enter a valid YouTube URL", "error");
      this.hideAllSections();
      return;
    }

    if (url === this.currentUrl && this.metadata) {
      return; // Already loaded
    }

    this.currentUrl = url;
    await this.loadPreviewAndLanguages(url);
  }

  private async loadPreviewAndLanguages(url: string): Promise<void> {
    this.setState("loading_preview");
    this.updateStatus("Loading video info...", "info");

    try {
      // Fetch metadata and available languages in parallel
      const [metadata, languagesResult] = await Promise.all([
        this.metadataService.getMetadata(url),
        this.transcriptService.getAvailableLanguages(url).catch((err) => {
          console.warn("[YouTubeCanvasModal] Failed to fetch languages:", err);
          return null;
        }),
      ]);

      this.metadata = metadata;
      this.availableLanguages = languagesResult?.languages || [];
      this.selectedLanguage = languagesResult?.defaultLanguage || null;

      this.renderPreview();
      this.renderLanguageSelector();
      this.setState("preview_ready");

      if (this.availableLanguages.length === 0) {
        this.updateStatus("Video preview loaded (no captions available)", "info");
      } else {
        this.updateStatus("Select a language and fetch the transcript", "success");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load video info";
      this.updateStatus(message, "error");
      this.setState("idle");
    }
  }

  private renderPreview(): void {
    if (!this.previewSection || !this.metadata) return;

    this.previewSection.empty();
    this.previewSection.style.display = "flex";

    const thumbnailContainer = this.previewSection.createDiv("ss-youtube-canvas-modal__thumbnail");
    thumbnailContainer.createEl("img", {
      attr: {
        src: this.metadataService.getThumbnailUrl(this.metadata.videoId, "mq"),
        alt: this.metadata.title,
      },
    });

    const infoContainer = this.previewSection.createDiv("ss-youtube-canvas-modal__info");
    infoContainer.createDiv({
      text: this.metadata.title,
      cls: "ss-youtube-canvas-modal__title",
    });
    infoContainer.createDiv({
      text: this.metadata.author_name,
      cls: "ss-youtube-canvas-modal__channel",
    });
  }

  // ==========================================================================
  // Language Selection (BEFORE Transcript Fetch)
  // ==========================================================================

  private renderLanguageSelector(): void {
    if (!this.languageSection) return;

    this.languageSection.empty();

    if (this.availableLanguages.length === 0) {
      this.languageSection.style.display = "none";
      return;
    }

    this.languageSection.style.display = "block";

    // Header
    const header = this.languageSection.createDiv("ss-youtube-canvas-modal__language-header");
    const iconSpan = header.createSpan();
    setIcon(iconSpan, "languages");
    header.createSpan({ text: `Select Language (${this.availableLanguages.length} available)` });

    // Language chips
    const chipsContainer = this.languageSection.createDiv("ss-youtube-canvas-modal__language-chips");

    for (const track of this.availableLanguages) {
      const isSelected = track.languageCode === this.selectedLanguage;
      const displayName = this.getTrackDisplayName(track);

      const chip = chipsContainer.createEl("button", {
        cls: `ss-youtube-canvas-modal__language-chip${isSelected ? " ss-youtube-canvas-modal__language-chip--active" : ""}`,
      });

      chip.createSpan({ text: displayName });
      chip.createSpan({ text: `(${track.languageCode})`, cls: "ss-youtube-canvas-modal__language-chip-code" });

      // Show badge for auto-generated captions
      if (track.kind === "asr") {
        const badge = chip.createSpan({ cls: "ss-youtube-canvas-modal__language-chip-badge" });
        badge.setText("auto");
      }

      if (isSelected) {
        const checkIcon = chip.createSpan("ss-youtube-canvas-modal__language-chip-check");
        setIcon(checkIcon, "check");
      }

      this.registerDomEvent(chip, "click", () => {
        this.selectedLanguage = track.languageCode;
        this.renderLanguageSelector();

        // If transcript already fetched, re-fetch in new language
        if (this.transcript) {
          this.fetchTranscript();
        }
      });
    }
  }

  private getTrackDisplayName(track: CaptionTrack): string {
    // Use the track's native name if it looks like a language name,
    // otherwise fall back to our lookup
    const nativeName = track.name;
    const lookupName = getLanguageName(track.languageCode);

    // If native name is just the code or empty, use lookup
    if (!nativeName || nativeName === track.languageCode) {
      return lookupName;
    }

    return nativeName;
  }

  // ==========================================================================
  // Transcript Fetching
  // ==========================================================================

  private async fetchTranscript(): Promise<void> {
    if (!this.currentUrl) return;

    if (this.availableLanguages.length === 0) {
      new Notice("This video has no captions available");
      return;
    }

    this.setState("fetching_transcript");
    const langName = this.selectedLanguage
      ? getLanguageName(this.selectedLanguage)
      : "default";
    this.updateStatus(`Fetching transcript in ${langName}...`, "info");
    this.disableInputs(true);

    try {
      this.transcript = await this.transcriptService.getTranscript(this.currentUrl, {
        lang: this.selectedLanguage || undefined,
      });

      this.renderTranscript();
      this.buildToggleSection();
      this.setState("transcript_ready");
      this.updateStatus(`Transcript ready (${getLanguageName(this.transcript.lang)})`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch transcript";
      this.updateStatus(message, "error");
      this.setState("preview_ready");
      new Notice(`Failed to fetch transcript: ${message}`, 5000);
    } finally {
      this.disableInputs(false);
    }
  }

  private renderTranscript(): void {
    if (!this.transcriptSection || !this.transcript) return;

    this.transcriptSection.empty();
    this.transcriptSection.style.display = "block";

    const header = this.transcriptSection.createDiv("ss-youtube-canvas-modal__transcript-header");
    header.createSpan({ text: "Transcript Preview" });

    const langName = getLanguageName(this.transcript.lang);
    header.createSpan({
      text: `(${langName})`,
      cls: "ss-youtube-canvas-modal__transcript-lang",
    });

    const preview = this.transcriptSection.createDiv("ss-youtube-canvas-modal__transcript-preview");
    const previewText =
      this.transcript.text.length > 500
        ? this.transcript.text.substring(0, 500) + "..."
        : this.transcript.text;
    preview.setText(previewText);
  }

  // ==========================================================================
  // Content Generation
  // ==========================================================================

  private async startGeneration(): Promise<void> {
    const selectedTypes = this.getSelectedContentTypes();
    if (selectedTypes.length === 0) {
      new Notice("Please select at least one content type to generate");
      return;
    }

    // Clear if regenerating
    const isRegenerate = selectedTypes.every((type) => this.generatedContent[type]);
    if (isRegenerate) {
      for (const type of selectedTypes) {
        delete this.generatedContent[type];
      }
      this.updateTabs();
    }

    this.setState("generating");
    this.updateStatus("Generating content...", "info");
    this.disableInputs(true);
    this.abortController = new AbortController();

    try {
      for (const contentType of selectedTypes) {
        if (this.generatedContent[contentType] || this.abortController.signal.aborted) {
          continue;
        }

        this.generatingType = contentType;
        this.activeTab = contentType;
        this.generatedContent[contentType] = "";
        this.updateTabs();

        await this.generateContent(contentType);

        this.generatingType = null;
        this.updateTabs();
        this.buildToggleSection();
      }

      this.setState("generation_complete");
      this.updateStatus("Generation complete", "success");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.updateStatus("Generation cancelled", "info");
      } else {
        const message = error instanceof Error ? error.message : "Generation failed";
        this.updateStatus(message, "error");
        new Notice(`Generation failed: ${message}`, 5000);
      }
      this.setState("transcript_ready");
    } finally {
      this.generatingType = null;
      this.abortController = null;
      this.disableInputs(false);
      this.updateButtonVisibility();
    }
  }

  private async generateContent(contentType: ContentType): Promise<void> {
    if (!this.transcript) return;

    const prompts: Record<ContentType, string> = {
      summary: "Summarize the following video transcript concisely, capturing the main points and key takeaways:\n\n",
      keyPoints: "Extract the key points from this video transcript as a bullet point list:\n\n",
      studyNotes: "Create comprehensive study notes from this video transcript with clear headings and organized sections:\n\n",
    };

    const messages = [
      {
        role: "user" as const,
        content: prompts[contentType] + this.transcript.text,
        message_id: crypto.randomUUID(),
      },
    ];

    const stream = this.plugin.aiService.streamMessage({
      messages,
      model: this.plugin.settings.selectedModelId,
    });

    let output = "";

    for await (const event of stream) {
      if (this.abortController?.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (event.type === "content") {
        output += event.text;
        this.generatedContent[contentType] = output;
        this.renderActiveTabContent();

        if (this.tabContent) {
          this.tabContent.scrollTop = this.tabContent.scrollHeight;
        }
      }
    }

    this.generatedContent[contentType] = output.trim();
  }

  private getSelectedContentTypes(): ContentType[] {
    const types: ContentType[] = [];
    if (this.contentToggles.summary) types.push("summary");
    if (this.contentToggles.keyPoints) types.push("keyPoints");
    if (this.contentToggles.studyNotes) types.push("studyNotes");
    return types;
  }

  // ==========================================================================
  // Tabs
  // ==========================================================================

  private updateTabs(): void {
    if (!this.tabBar || !this.tabContent) return;

    this.tabBar.empty();

    const contentTypes: Array<{ id: ContentType; label: string }> = [
      { id: "summary", label: "Summary" },
      { id: "keyPoints", label: "Key Points" },
      { id: "studyNotes", label: "Study Notes" },
    ];

    const availableTabs = contentTypes.filter(({ id }) => this.generatedContent[id] !== undefined);

    if (availableTabs.length === 0) {
      this.tabBar.style.display = "none";
      this.tabContent.style.display = "none";
      return;
    }

    this.tabBar.style.display = "flex";
    this.tabContent.style.display = "block";

    if (!this.activeTab || this.generatedContent[this.activeTab] === undefined) {
      this.activeTab = availableTabs[0].id;
    }

    for (const { id, label } of availableTabs) {
      const isActive = id === this.activeTab;
      const isGenerating = this.generatingType === id;

      const tab = this.tabBar.createDiv({
        cls: `ss-youtube-canvas-modal__tab${isActive ? " ss-youtube-canvas-modal__tab--active" : ""}`,
      });

      tab.appendText(label);

      if (isGenerating) {
        const spinner = tab.createSpan("ss-youtube-canvas-modal__tab-spinner");
        setIcon(spinner, "loader");
      }

      this.registerDomEvent(tab, "click", () => {
        this.activeTab = id;
        this.updateTabs();
      });
    }

    this.renderActiveTabContent();
  }

  private renderActiveTabContent(): void {
    if (!this.tabContent || !this.activeTab) return;

    this.tabContent.empty();

    const content = this.generatedContent[this.activeTab];
    if (content !== undefined) {
      const textEl = this.tabContent.createDiv("ss-youtube-canvas-modal__tab-content-text");
      textEl.setText(content || "");
    }
  }

  private updateGenerateButtonState(): void {
    if (!this.generateBtn) return;

    const selectedTypes = this.getSelectedContentTypes();
    this.generateBtn.disabled = selectedTypes.length === 0;

    const btnTextNode = Array.from(this.generateBtn.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE
    );

    if (btnTextNode) {
      const allGenerated = selectedTypes.length > 0 && selectedTypes.every((type) => this.generatedContent[type]);
      btnTextNode.textContent = allGenerated ? "Regenerate" : "Generate";
    }
  }

  // ==========================================================================
  // Note Creation
  // ==========================================================================

  private async createNote(): Promise<void> {
    if (!this.metadata || !this.transcript) return;

    this.setState("creating_note");
    this.updateStatus("Creating note...", "info");
    this.disableInputs(true);

    try {
      const content = this.buildNoteContent();
      const fileName = this.sanitizeFileName(this.metadata.title);
      const filePath = await this.createNoteFile(fileName, content);

      this.updateStatus("Note created successfully!", "success");
      new Notice(`Created: ${filePath}`, 3000);

      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf().openFile(file);
      }

      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create note";
      this.updateStatus(message, "error");
      this.setState("generation_complete");
      new Notice(`Failed to create note: ${message}`, 5000);
    } finally {
      this.disableInputs(false);
    }
  }

  private buildNoteContent(): string {
    if (!this.metadata || !this.transcript) return "";

    const timestamp = new Date().toISOString();
    const url = `https://www.youtube.com/watch?v=${this.metadata.videoId}`;

    let content = `---
source: youtube
video_id: ${this.metadata.videoId}
title: "${this.metadata.title.replace(/"/g, '\\"')}"
channel: "${this.metadata.author_name.replace(/"/g, '\\"')}"
url: ${url}
created: ${timestamp}
---

# ${this.metadata.title}

> Video by [${this.metadata.author_name}](${this.metadata.author_url})

`;

    if (this.generatedContent.summary) {
      content += `## Summary\n\n${this.generatedContent.summary}\n\n`;
    }

    if (this.generatedContent.keyPoints) {
      content += `## Key Points\n\n${this.generatedContent.keyPoints}\n\n`;
    }

    if (this.generatedContent.studyNotes) {
      content += `## Study Notes\n\n${this.generatedContent.studyNotes}\n\n`;
    }

    content += `## Transcript\n\n${this.transcript.text}\n`;

    return content;
  }

  private sanitizeFileName(title: string): string {
    return title
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 100);
  }

  private async createNoteFile(baseName: string, content: string): Promise<string> {
    const folder = this.folderInput?.value.trim() || this.plugin.settings.youtubeNotesFolder || "";
    let filePath = folder ? `${folder}/${baseName}.md` : `${baseName}.md`;

    if (folder) {
      const folderExists = this.app.vault.getAbstractFileByPath(folder);
      if (!folderExists) {
        await this.app.vault.createFolder(folder);
      }
    }

    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(filePath)) {
      filePath = folder ? `${folder}/${baseName} ${counter}.md` : `${baseName} ${counter}.md`;
      counter++;
    }

    await this.app.vault.create(filePath, content);
    return filePath;
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  private setState(state: ModalState): void {
    this.state = state;
    this.updateButtonVisibility();
  }

  private updateButtonVisibility(): void {
    const hasLanguages = this.availableLanguages.length > 0;
    const showGetTranscript = this.state === "preview_ready" && hasLanguages;
    const showPostTranscript = ["transcript_ready", "generating", "generation_complete"].includes(this.state);
    const hasGeneratedContent = Object.values(this.generatedContent).some(Boolean);
    const showCreateNote = showPostTranscript && hasGeneratedContent;

    if (this.getTranscriptBtn) {
      this.getTranscriptBtn.style.display = showGetTranscript ? "inline-flex" : "none";
    }

    if (this.languageSection) {
      // Show language selector both before and after transcript fetch (for switching)
      const showLanguages = (this.state === "preview_ready" || showPostTranscript) && hasLanguages;
      this.languageSection.style.display = showLanguages ? "block" : "none";
    }

    if (this.folderSection) {
      this.folderSection.style.display = showPostTranscript ? "flex" : "none";
    }

    if (this.toggleSection) {
      this.toggleSection.style.display = showPostTranscript ? "flex" : "none";
    }

    if (this.generateBtn) {
      this.generateBtn.style.display = showPostTranscript ? "inline-flex" : "none";
      this.generateBtn.disabled = this.state === "generating";
    }

    if (this.createNoteBtn) {
      this.createNoteBtn.style.display = showCreateNote ? "inline-flex" : "none";
    }
  }

  private updateStatus(message: string, tone: "info" | "success" | "error"): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = message;
    this.statusEl.className = `ss-youtube-canvas-modal__status ss-youtube-canvas-modal__status--${tone}`;
  }

  private disableInputs(disabled: boolean): void {
    if (this.urlInput) this.urlInput.disabled = disabled;
    if (this.folderInput) this.folderInput.disabled = disabled;
    if (this.getTranscriptBtn) this.getTranscriptBtn.disabled = disabled;
    if (this.generateBtn) this.generateBtn.disabled = disabled;
    if (this.createNoteBtn) this.createNoteBtn.disabled = disabled;

    this.languageSection?.querySelectorAll("button").forEach((btn) => {
      (btn as HTMLButtonElement).disabled = disabled;
    });

    this.toggleSection?.querySelectorAll("input[type='checkbox']").forEach((input) => {
      (input as HTMLInputElement).disabled = disabled;
    });
  }

  private hideAllSections(): void {
    const sections = [
      this.previewSection,
      this.languageSection,
      this.transcriptSection,
      this.folderSection,
      this.toggleSection,
      this.tabBar,
      this.tabContent,
    ];

    for (const section of sections) {
      if (section) {
        section.style.display = "none";
        section.empty();
      }
    }

    this.metadata = null;
    this.transcript = null;
    this.availableLanguages = [];
    this.selectedLanguage = null;
    this.generatedContent = {};
    this.activeTab = null;
    this.loadSettings();
  }

  private resetToIdle(): void {
    this.currentUrl = "";
    this.hideAllSections();
    this.setState("idle");
    this.updateStatus("Paste a YouTube URL to get started", "info");
  }
}
