import { Notice } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { AudioSourcePicker, type AudioSourceSelection } from "../../components/AudioSourcePicker";
import { StandardModal } from "../../core/ui/modals/standard/StandardModal";
import {
  createUiAction,
  createUiRadioGroup,
  createUiState,
  createUiTabs,
  getSurfaceOwnerWindow,
  updateUiAction,
  type UiRadioGroupHandle,
  type UiTabsHandle,
} from "../../core/ui/surface";
import {
  canReadVaultAudioInParts,
  createDeviceAudioSource,
  createVaultAudioSource,
} from "./audioSource";
import { AudioProcessorPanel } from "./AudioProcessorPanel";
import { AudioProcessorService } from "./AudioProcessorService";
import {
  AUDIO_PROCESSOR_MAX_AUDIO_BYTES,
  normalizeAudioProcessorOutputPreset,
  type AudioProcessorOutputPreset,
  type AudioProcessorSource,
} from "./types";
import { parseYouTubeVideoUrl, requireYouTubeVideoUrl } from "./youtube";

export type AudioProcessorTab = "audio" | "youtube";

export interface AudioProcessorModalOptions {
  initialTab?: AudioProcessorTab;
  createService?: (plugin: SystemSculptPlugin) => Pick<AudioProcessorService, "process">;
}

export class AudioProcessorModal extends StandardModal {
  private static nextInstanceId = 0;
  private readonly instanceId = ++AudioProcessorModal.nextInstanceId;
  private activeTab: AudioProcessorTab;
  private youtubeUrl = "";
  private outputPreset: AudioProcessorOutputPreset;
  private launching = false;

  private sourceTabs: UiTabsHandle<AudioProcessorTab> | null = null;
  private outputPresetGroup: UiRadioGroupHandle<AudioProcessorOutputPreset> | null = null;
  private picker: AudioSourcePicker | null = null;
  private youtubeInputEl: HTMLInputElement | null = null;
  private youtubeStatusEl: HTMLElement | null = null;
  private processButton: HTMLButtonElement | null = null;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly options: AudioProcessorModalOptions = {},
  ) {
    super(plugin.app);
    this.activeTab = options.initialTab ?? "audio";
    this.outputPreset = normalizeAudioProcessorOutputPreset(
      plugin.settings.audioProcessorOutputPreset,
    );
    this.setSize("medium");
    this.modalEl.addClass("ss-modal--scrollable", "ss-audio-processor-modal");
  }

  onOpen(): void {
    super.onOpen();
    this.addTitle(
      "Audio Processor",
      "Turn audio or a YouTube video into a detailed note, meeting brief, or clean transcript.",
    );
    this.processButton = this.addActionButton(
      "audio.modal.process",
      this.activeTab === "youtube" ? "Process video" : "Process audio",
      () => void this.processAudio(),
      true,
      "sparkles",
    );
    this.addActionButton("audio.modal.cancel", "Cancel", () => this.close(), false, "x");
    this.render();
    this.syncProcessButton();

    this.ownerWindow.setTimeout(() => {
      if (this.activeTab === "youtube") this.youtubeInputEl?.focus();
      else this.picker?.focus();
    }, 0);
  }

  onClose(): void {
    this.sourceTabs?.destroy();
    this.sourceTabs = null;
    this.outputPresetGroup?.destroy();
    this.outputPresetGroup = null;
    this.picker?.destroy();
    this.picker = null;
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
    const audioButton = createUiAction(tablist, { label: "Audio", testId: "audio.modal.tab.audio", icon: "audio-lines" });
    const youtubeButton = createUiAction(tablist, { label: "YouTube", testId: "audio.modal.tab.youtube", icon: "youtube" });
    audioButton.addClass("ss-audio-processor__tab");
    youtubeButton.addClass("ss-audio-processor__tab");

    const audioPanel = shell.createDiv({ cls: "ss-audio-processor__panel" });
    const youtubePanel = shell.createDiv({ cls: "ss-audio-processor__panel" });
    this.renderAudioPanel(audioPanel);
    this.renderYouTubePanel(youtubePanel);
    this.renderOutputPreset(shell);

    this.sourceTabs = createUiTabs(tablist, [
      { id: "audio", button: audioButton, panel: audioPanel },
      { id: "youtube", button: youtubeButton, panel: youtubePanel },
    ], {
      activeId: this.activeTab,
      onChange: (tab) => {
        this.activeTab = tab;
        this.syncProcessButton();
        if (tab === "youtube") this.youtubeInputEl?.focus();
        else this.picker?.focus();
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
    this.picker = new AudioSourcePicker(container, {
      app: this.app,
      listFiles: () => this.app.vault.getFiles(),
      vaultAvailable: vaultAudioAvailable,
      acceptsVaultFile: (file) => file.stat.size > 0 && file.stat.size <= AUDIO_PROCESSOR_MAX_AUDIO_BYTES,
      acceptDeviceFile: (file) => {
        try {
          createDeviceAudioSource(file).release();
          return true;
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Choose a supported audio file.", 5000);
          return false;
        }
      },
      deviceHint: "Large files upload in parts, so hours-long recordings are supported.",
      sizeLimitLabel: "up to 1 GB",
      onChange: () => this.syncProcessButton(),
    });
  }

  private renderYouTubePanel(container: HTMLElement): void {
    container.createDiv({
      cls: "ss-audio-processor__intro",
      text: "Paste a YouTube video link. SystemSculpt handles retrieval, transcription, and note creation on the server.",
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
    });
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
  }

  private renderOutputPreset(container: HTMLElement): void {
    const section = container.createEl("section", {
      cls: "ss-audio-processor__output",
    });
    const titleId = `ss-audio-processor-output-${this.instanceId}`;
    section.createEl("h3", {
      cls: "ss-audio-processor__section-title",
      text: "Output",
      attr: { id: titleId },
    });
    const choices = section.createDiv({
      cls: "ss-audio-processor__output-options",
    });
    const detailedButton = this.createOutputPresetOption(
      choices,
      "audio.modal.output.detailed",
      "Detailed note",
      "Summary, decisions, action items, and a linked timestamped transcript.",
      "file-text",
    );
    const meetingBriefButton = this.createOutputPresetOption(
      choices,
      "audio.modal.output.meeting-brief",
      "Meeting brief",
      "Outcome, decisions, action items, and open questions, plus a linked transcript.",
      "list-checks",
    );
    const cleanTranscriptButton = this.createOutputPresetOption(
      choices,
      "audio.modal.output.clean-transcript",
      "Clean transcript",
      "Readable paragraphs without timestamps in the main note, plus a linked transcript.",
      "align-left",
    );
    this.outputPresetGroup = createUiRadioGroup(
      choices,
      [
        { value: "detailed", button: detailedButton },
        { value: "meeting_brief", button: meetingBriefButton },
        { value: "clean_transcript", button: cleanTranscriptButton },
      ],
      {
        value: this.outputPreset,
        labelledBy: titleId,
        onChange: (preset) => {
          this.outputPreset = preset;
        },
      },
    );
  }

  private createOutputPresetOption(
    container: HTMLElement,
    testId: string,
    label: string,
    detail: string,
    icon: string,
  ): HTMLButtonElement {
    const button = createUiAction(container, { label, testId, icon });
    button.addClass("ss-audio-processor__output-option");
    button.createSpan({
      cls: "ss-audio-processor__output-detail",
      text: detail,
    });
    return button;
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
        outputPreset: this.outputPreset,
        onProgress: (event) => panel.update(event),
      });
      panel.succeed(note);
    } catch (error) {
      panel.fail(error);
    }
  }

  private currentAudioSelection(): AudioSourceSelection | null {
    return this.picker?.selection ?? null;
  }

  private get ownerWindow(): Window {
    return getSurfaceOwnerWindow(this.modalEl);
  }
}
