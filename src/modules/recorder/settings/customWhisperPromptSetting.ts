import { Setting } from "obsidian";
import { RecorderModule } from "../RecorderModule";
import { DEFAULT_RECORDER_SETTINGS } from "./RecorderSettings";
import { encode, decode } from "gpt-tokenizer";

function getWhisperTokenCount(text: string): number {
  return encode(text).length;
}

export function renderCustomWhisperPromptSetting(
  containerEl: HTMLElement,
  plugin: RecorderModule,
): void {
  new Setting(containerEl)
    .setName("Enable Custom Transcription Prompt")
    .setDesc("Enable or disable the custom transcription prompt")
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.settings.enableCustomWhisperPrompt)
        .onChange(async (value) => {
          plugin.settings.enableCustomWhisperPrompt = value;
          await plugin.saveSettings();
          plugin.settingsDisplay(containerEl);
        });
    });

  if (plugin.settings.enableCustomWhisperPrompt) {
    new Setting(containerEl)
      .setName("Custom Whisper Vocabulary")
      .setDesc(
        "Customize the list of favored words or phrases for Whisper transcription (max 244 tokens)",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Enter custom prompt")
          .setValue(plugin.settings.customWhisperPrompt)
          .onChange(async (value) => {
            const truncatedValue = truncateToTokenLimit(value, 244);
            if (truncatedValue !== value) {
              text.setValue(truncatedValue);
            }
            plugin.settings.customWhisperPrompt = truncatedValue;
            await plugin.saveSettings();
            updateTokenCount(truncatedValue, tokenCountEl);
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 50;
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default custom Whisper prompt")
          .onClick(async () => {
            plugin.settings.customWhisperPrompt =
              DEFAULT_RECORDER_SETTINGS.customWhisperPrompt;
            await plugin.saveSettings();
            plugin.settingsDisplay(containerEl);
          });
      });

    const tokenCountEl = containerEl.createDiv({ cls: "info-box-token-count" });
    tokenCountEl.style.textAlign = "right";
    tokenCountEl.style.marginBottom = "8px";

    updateTokenCount(plugin.settings.customWhisperPrompt, tokenCountEl);

    const infoBoxEl = containerEl.createDiv("info-box");
    infoBoxEl.createEl("p", {
      text: "The custom Whisper vocabulary helps improve transcription accuracy by providing a list of favored words or phrases. This can correct specific words or acronyms, preserve context for split audio files, ensure proper punctuation and filler words, and specify preferred writing styles for certain languages. Note that Whisper only considers the first 244 tokens of the vocabulary list.",
    });
  }
}

function updateTokenCount(text: string, tokenCountEl: HTMLElement) {
  const tokenCount = getWhisperTokenCount(text);
  const tokenCountText = `${tokenCount}/244 tokens used`;
  tokenCountEl.textContent = tokenCountText;
}

function truncateToTokenLimit(text: string, limit: number): string {
  const tokens = encode(text);
  if (tokens.length <= limit) {
    return text;
  }
  return decode(tokens.slice(0, limit));
}
