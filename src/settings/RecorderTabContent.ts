import { Setting, Notice, DropdownComponent } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { PlatformContext } from "../services/PlatformContext";
import { DEFAULT_SETTINGS } from "../types";
import {
  CUSTOM_WHISPER_CONTRACT,
  validateCustomWhisperConfig,
} from "../services/transcription/providers/customWhisperConfig";

export async function displayRecorderTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains("systemsculpt-tab-content")) {
    containerEl.dataset.tab = "workflow";
  }
  const { plugin } = tabInstance;
  const isMobile = PlatformContext.get().isMobile();

  containerEl.createEl("h3", { text: "Recording" });

  await renderMicrophoneSetting(containerEl, tabInstance);

  new Setting(containerEl)
    .setName("Auto-transcribe recordings")
    .setDesc("Transcribe recordings automatically when they finish.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoTranscribeRecordings)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoTranscribeRecordings: value });
        });
    });

  new Setting(containerEl)
    .setName("Auto-paste transcription")
    .setDesc("Paste the transcription into the active document when it completes.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoPasteTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoPasteTranscription: value });
        });
    });

  new Setting(containerEl)
    .setName("Keep recordings after transcription")
    .setDesc("Retain the source audio file after a successful transcription.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.keepRecordingsAfterTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ keepRecordingsAfterTranscription: value });
        });
    });

  new Setting(containerEl)
    .setName("Clean output only")
    .setDesc("Strip timestamps and metadata from transcription output.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.cleanTranscriptionOutput)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ cleanTranscriptionOutput: value });
        });
    });

  new Setting(containerEl)
    .setName("Auto-submit after transcription")
    .setDesc("Send the message automatically once transcription or post-processing finishes in chat views.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.autoSubmitAfterTranscription)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ autoSubmitAfterTranscription: value });
        });
    });

  new Setting(containerEl)
    .setName("Enable post-processing")
    .setDesc("Clean up the transcription with an LLM after it completes.")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.postProcessingEnabled)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ postProcessingEnabled: value });
        });
    });

  // #97: a dedicated post-processing model. Clean-up is a cheap, mechanical
  // task, so users want to run it on a fast/cheap model while keeping a stronger
  // model for chat. Empty value = "use the chat model" (the PostProcessingService
  // fallback), which keeps the default behavior and works for BYOK users.
  new Setting(containerEl)
    .setName("Post-processing model")
    .setDesc(
      "Model used for transcription clean-up. Defaults to your chat model — pick a faster or cheaper model here to keep chat on a stronger one."
    )
    .addDropdown((dropdown) => {
      dropdown.addOption("", "Use chat model (default)");
      dropdown.setValue(plugin.settings.postProcessingModelId || "");
      dropdown.onChange(async (value) => {
        await plugin.getSettingsManager().updateSettings({ postProcessingModelId: value });
      });
      // Populate the model list asynchronously. The dropdown stays usable with
      // the default option while models load, and failures degrade gracefully
      // (clean-up still runs via the chat model).
      void (async () => {
        try {
          const models = await plugin.modelService.getModels();
          for (const model of models) {
            const label = String(model.name || model.id || "").trim() || model.id;
            dropdown.addOption(model.id, label);
          }
          // Re-apply the stored selection now that its option exists.
          dropdown.setValue(plugin.settings.postProcessingModelId || "");
        } catch {
          // Leave the default-only dropdown in place.
        }
      })();
    });

  let postProcessingPromptText: HTMLTextAreaElement | null = null;
  new Setting(containerEl)
    .setName("Transcription clean-up prompt")
    .setDesc("Optional. Adjust the instructions used for the transcription clean-up step.")
    .addTextArea((text) => {
      postProcessingPromptText = text.inputEl;
      text
        .setPlaceholder(DEFAULT_SETTINGS.postProcessingPrompt)
        .setValue(plugin.settings.postProcessingPrompt || DEFAULT_SETTINGS.postProcessingPrompt)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({
            postProcessingPrompt: value || DEFAULT_SETTINGS.postProcessingPrompt,
          });
        });
      text.inputEl.rows = 8;
      text.inputEl.addClass("ss-settings-textarea");
    })
    .addButton((button) => {
      button
        .setButtonText("Reset prompt")
        .onClick(async () => {
          await plugin.getSettingsManager().updateSettings({
            postProcessingPrompt: DEFAULT_SETTINGS.postProcessingPrompt,
          });
          if (postProcessingPromptText) {
            postProcessingPromptText.value = DEFAULT_SETTINGS.postProcessingPrompt;
          }
          new Notice("Transcription clean-up prompt reset.");
        });
    });

  containerEl.createEl("h3", { text: "Transcription" });

  new Setting(containerEl)
    .setName("Transcription provider")
    .setDesc("Transcribe through SystemSculpt (managed) or your own self-hosted / third-party Whisper-compatible endpoint.")
    .addDropdown((dropdown) => {
      dropdown
        .addOption("systemsculpt", "SystemSculpt (managed)")
        .addOption("custom", "Custom / self-hosted Whisper")
        .setValue(plugin.settings.transcriptionProvider ?? "systemsculpt")
        .onChange(async (value: "systemsculpt" | "custom") => {
          await plugin.getSettingsManager().updateSettings({ transcriptionProvider: value });
          // Re-render so the custom fields appear/disappear with the choice.
          await displayRecorderTabContent(containerEl, tabInstance);
        });
    });

  if (plugin.settings.transcriptionProvider === "custom") {
    renderCustomTranscriptionSettings(containerEl, tabInstance);
  }

  new Setting(containerEl)
    .setName("Default transcription output format")
    .setDesc("Choose whether transcriptions are saved as Markdown (.md) or SRT (.srt) by default.")
    .addDropdown((dropdown) => {
      dropdown
        .addOption("markdown", "Markdown (.md)")
        .addOption("srt", "SRT subtitle file (.srt)")
        .setValue(plugin.settings.transcriptionOutputFormat ?? "markdown")
        .onChange(async (value: "markdown" | "srt") => {
          await plugin.getSettingsManager().updateSettings({ transcriptionOutputFormat: value });
        });
    });

  new Setting(containerEl)
    .setName("Show output format chooser in transcribe modal")
    .setDesc('Keep the Markdown/SRT picker visible in the modal. Re-enable this here if you selected "Do not show this again".')
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.showTranscriptionFormatChooserInModal ?? true)
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ showTranscriptionFormatChooserInModal: value });
        });
    });

  containerEl.createEl("p", {
    text: "Tip: You can always change transcription output format and modal behavior here.",
    cls: "setting-item-description",
  });

  if (!isMobile) {
    new Setting(containerEl)
      .setName("Automatic audio format conversion")
      .setDesc("Convert incompatible audio files before transcription.")
      .addToggle((toggle) => {
        toggle
          .setValue(plugin.settings.enableAutoAudioResampling ?? true)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({ enableAutoAudioResampling: value });
            new Notice(value ? "Audio conversion enabled" : "Audio conversion disabled");
          });
      });
  }
}

function renderCustomTranscriptionSettings(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  const { plugin } = tabInstance;
  let statusEl: HTMLElement | null = null;

  const refreshValidation = () => {
    if (!statusEl) return;
    statusEl.empty();
    const result = validateCustomWhisperConfig({
      endpoint: plugin.settings.customTranscriptionEndpoint || "",
      apiKey: plugin.settings.customTranscriptionApiKey || "",
      model: plugin.settings.customTranscriptionModel || "",
    });
    if (result.ok && result.warnings.length === 0) {
      statusEl.createDiv({ cls: "ss-inline-note-ok", text: "✓ Endpoint looks compatible." });
      return;
    }
    for (const error of result.errors) {
      statusEl.createDiv({ cls: "ss-inline-note-error", text: `⛔ ${error}` });
    }
    for (const warning of result.warnings) {
      statusEl.createDiv({ cls: "ss-inline-note-warning", text: `⚠️ ${warning}` });
    }
  };

  new Setting(containerEl)
    .setName("Custom endpoint URL")
    .setDesc(
      "Full URL of your Whisper-compatible endpoint, e.g. https://api.groq.com/openai/v1/audio/transcriptions, https://api.openai.com/v1/audio/transcriptions, or http://localhost:9000/v1/audio/transcriptions."
    )
    .addText((text) => {
      text
        .setPlaceholder("https://.../v1/audio/transcriptions")
        .setValue(plugin.settings.customTranscriptionEndpoint || "")
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ customTranscriptionEndpoint: value.trim() });
          refreshValidation();
        });
    });

  new Setting(containerEl)
    .setName("API key")
    .setDesc("Optional. Sent as 'Authorization: Bearer <key>'. Required by most hosted endpoints; leave blank for a local server that needs none.")
    .addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder("sk-... / gsk_...")
        .setValue(plugin.settings.customTranscriptionApiKey || "")
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ customTranscriptionApiKey: value.trim() });
          refreshValidation();
        });
    });

  new Setting(containerEl)
    .setName("Model name")
    .setDesc("Model identifier sent to the endpoint, e.g. whisper-large-v3 (Groq) or whisper-1 (OpenAI). Leave blank to use the server default.")
    .addText((text) => {
      text
        .setPlaceholder("whisper-large-v3")
        .setValue(plugin.settings.customTranscriptionModel || "")
        .onChange(async (value) => {
          await plugin.getSettingsManager().updateSettings({ customTranscriptionModel: value.trim() });
          refreshValidation();
        });
    });

  containerEl.createEl("p", {
    text: CUSTOM_WHISPER_CONTRACT,
    cls: "setting-item-description",
  });

  statusEl = containerEl.createDiv({ cls: "ss-inline-note" });
  refreshValidation();
}

async function renderMicrophoneSetting(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  const { plugin } = tabInstance;

  const setting = new Setting(containerEl)
    .setName("Preferred microphone")
    .setDesc("Select which microphone to use for recordings.");

  let dropdownComponent: DropdownComponent | null = null;
  let dropdownEl: HTMLSelectElement | null = null;
  setting.addDropdown((dropdown) => {
    dropdownComponent = dropdown;
    dropdownEl = dropdown.selectEl;
    dropdown.addOption("default", "Default microphone");
    dropdown.setValue(plugin.settings.preferredMicrophoneId || "default");

    dropdown.onChange(async (value) => {
      await plugin.getSettingsManager().updateSettings({ preferredMicrophoneId: value });
      const label = dropdown.selectEl?.selectedOptions[0]?.text || value;
      new Notice(`Microphone preference saved: ${label}`);
    });
  });

  const statusEl = setting.descEl.createDiv({ cls: "ss-inline-note" });

  const loadDevices = async () => {
    if (!dropdownComponent || !dropdownEl) return;
    dropdownEl.innerHTML = "";
    const dropdown = dropdownComponent;
    const addOption = (value: string, label: string) => {
      dropdown.addOption(value, label);
    };

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      addOption("default", "Default microphone");
      dropdown.setValue(plugin.settings.preferredMicrophoneId || "default");
      statusEl.setText("Microphone selection unavailable in this environment.");
      return;
    }

    try {
      statusEl.setText("Loading microphones...");
      const devices = await navigator.mediaDevices.enumerateDevices();
      const labeled = devices.some((device) => device.kind === "audioinput" && device.label);
      if (!labeled) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
        } catch (_error: any) {
          statusEl.setText("Microphone access denied; using default device list.");
        }
      }

      const refreshed = await navigator.mediaDevices.enumerateDevices();
      const microphones = refreshed.filter((device) => device.kind === "audioinput");

      addOption("default", "Default microphone");
      microphones.forEach((mic) => {
        addOption(mic.deviceId, mic.label || `Microphone ${mic.deviceId.slice(0, 8)}`);
      });

      const current = plugin.settings.preferredMicrophoneId || "default";
      dropdown.setValue(current);
      statusEl.setText(microphones.length ? "" : "No microphones detected.");
    } catch (error: any) {
      statusEl.setText(`Unable to load microphones: ${error?.message || error}`);
      addOption("default", "Default microphone");
      dropdown.setValue("default");
    }
  };

  setting.addExtraButton((button) => {
    button
      .setIcon("refresh-cw")
      .setTooltip("Refresh microphones")
      .onClick(() => {
        loadDevices();
      });
  });
  await loadDevices();
}
