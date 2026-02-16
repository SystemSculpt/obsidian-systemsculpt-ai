import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { displaySetupTabContent } from "./SetupTabContent";
import { displayModelSettingsTabContent } from "./ModelSettingsTabContent";
import { displaySystemPromptSettingsTabContent } from "./SystemPromptSettingsTabContent";
import { displayChatTabContent } from "./ChatTabContent";
import { displayTemplatesTabContent } from "./TemplatesTabContent";
import { displayRecorderTabContent } from "./RecorderTabContent";
import { displayDirectoriesTabContent } from "./DirectoriesTabContent";
import { displayBackupTabContent } from "./BackupTabContent";
import { displayEmbeddingsTabContent } from "./EmbeddingsTabContent";
import { displayImageGenerationTabContent } from "./ImageGenerationTabContent";
import { displayDataTabContent } from "./DataTabContent";
import { displayAdvancedTabContent } from "./AdvancedTabContent";
import { displayChangeLogTabContent } from "./ChangeLogTabContent";
import { DailyTabContent } from "./DailyTabContent";
import { displayAutomationsTabContent } from "./AutomationsTabContent";

export interface SettingsTabConfig {
  id: string;
  label: string;
  sections: Array<(parent: HTMLElement) => void>;
  anchor?: { title: string; desc: string };
}

export function buildSettingsTabConfigs(tab: SystemSculptSettingTab): SettingsTabConfig[] {
  const isProActive = tab.plugin.settings.licenseValid === true;
  const isAdvancedMode = tab.plugin.settings.settingsMode === 'advanced';

  return [
    {
      id: "overview",
      label: "Overview & Setup",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          displaySetupTabContent(section, tab, isProActive);
        },
      ],
      anchor: {
        title: "Setup, Connect Providers, API Keys, License",
        desc: "Add providers (SystemSculpt, OpenAI, Anthropic, OpenRouter, LM Studio, Ollama), enter API keys, test connection, activate license, enable fallback.",
      },
    },
    {
      id: "models-prompts",
      label: "Models & Prompts",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          displayModelSettingsTabContent(section, tab);
        },
        (parent) => {
          const section = parent.createDiv();
          displaySystemPromptSettingsTabContent(section, tab);
        },
        (parent) => {
          const section = parent.createDiv();
        },
      ],
      anchor: {
        title: "Models, System Prompts, Title Generation, Post-processing",
        desc: "Configure chat model, title model, post-processing model; choose presets or custom system prompts; title generation prompts.",
      },
    },
    {
      id: "chat-templates",
      label: "Chat & Templates",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          displayChatTabContent(section, tab);
        },
        (parent) => {
          const section = parent.createDiv();
          displayTemplatesTabContent(section, tab);
        },
      ],
      anchor: {
        title: "Chat Settings, Favorites, Templates",
        desc: "Default chat font size, manage favorite models, template hotkey and shortcuts.",
      },
    },
    {
      id: "daily-vault",
      label: "Daily Vault",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          const dailyContent = new DailyTabContent(
            tab.app,
            tab.plugin.getDailySettingsService(),
            tab.plugin.getDailyNoteService(),
            section
          );
          void dailyContent.display();
        },
      ],
      anchor: {
        title: "Daily Notes, Templates, Automations, Streaks, Status Bar",
        desc: "Configure daily note naming, directories, templates, reminders, streak tracking, status bar, ribbon badge, and analytics.",
      },
    },
    {
      id: "automations",
      label: "Automations",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          displayAutomationsTabContent(section, tab);
        },
      ],
      anchor: {
        title: "Workflow Engine, Capture Inbox Routing, Automations",
        desc: "Keep Capture Inbox tidy, auto-transcribe audio, and enable built-in meeting, clipping, or idea automations.",
      },
    },
    {
      id: "audio-transcription",
      label: "Audio & Transcription",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          displayRecorderTabContent(section, tab);
        },
      ],
      anchor: {
        title: "Audio Recording, Microphone, Transcription, Whisper, Groq, OpenAI, Resampling",
        desc: "Preferred microphone, auto-transcribe, clean output, auto-submit, post-processing, custom transcription endpoint and API key, model selection, presets.",
      },
    },
    {
      id: "image-generation",
      label: "Image Generation",
      sections: [
        (parent) => {
          displayImageGenerationTabContent(parent, tab);
        },
      ],
      anchor: {
        title: "SystemSculpt Canvas, Replicate, Images",
        desc: "Configure Replicate API key and model selection for SystemSculpt canvas image generation inside Obsidian Canvas.",
      },
    },
    {
      id: "files-backup",
      label: "Files & Backup",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          displayDirectoriesTabContent(section, tab);
        },
        (parent) => {
          const section = parent.createDiv();
          displayBackupTabContent(section, tab);
        },
      ],
      anchor: {
        title: "Directories, Folders, Attachments, Saved Chats, Extractions, Backups, Restore",
        desc: "Configure directories for chats, saved chats, recordings, system prompts, attachments, extractions; verify/repair; automatic backups; manual backup & restore.",
      },
    },
    {
      id: "embeddings",
      label: "Embeddings & Search",
      sections: [
        (parent) => {
          displayEmbeddingsTabContent(parent, tab);
        },
      ],
      anchor: {
        title: "Embeddings, Semantic Search, Similar Notes, Exclusions, Provider",
        desc: "Enable embeddings, provider selection, custom API endpoint and key, model selection, file and folder exclusions, respect Obsidian exclusions.",
      },
    },
    {
      id: "data",
      label: "Data",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          displayDataTabContent(section, tab);
        },
      ],
      anchor: {
        title: "Data Imports, Readwise, Highlights, Sync, External Sources",
        desc: "Import highlights and annotations from Readwise. Configure sync options, file format, and organization structure.",
      },
    },
    {
      id: "advanced",
      label: "Advanced",
      sections: [
        (parent) => {
          displayAdvancedTabContent(parent, tab);
        },
        (parent) => {
          const changelogWrapper = parent.createDiv();
          changelogWrapper.createEl("h3", { text: "What's New (Change Log)" });
          displayChangeLogTabContent(changelogWrapper, tab);
        },
      ],
      anchor: {
        title: "Advanced, Debug, Update Notifications, Reset, Diagnostics, Changelog",
        desc: "Development mode, logs, update notifications, reset to factory settings, diagnostics & troubleshooting, plugin change log.",
      },
    },
  ];
}
