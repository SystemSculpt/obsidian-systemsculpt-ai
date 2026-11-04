import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { renderAccountSection } from "./setup/SetupTabAccountSection";
import { renderSupportSection } from "./setup/SetupTabSupportSection";
import { displayChatTabContent } from "./ChatTabContent";
import { displayRecorderTabContent } from "./RecorderTabContent";
import { displayDirectoriesTabContent } from "./DirectoriesTabContent";
import { displayPhoneCapturesTabContent } from "./PhoneCapturesTabContent";
import { displayBackupTabContent } from "./BackupTabContent";
import { displayEmbeddingsTabContent } from "./EmbeddingsTabContent";
import { displayImageGenerationTabContent } from "./ImageGenerationTabContent";
import { displayAdvancedTabContent } from "./AdvancedTabContent";

export interface SettingsTabConfig {
  id: string;
  label: string;
  sections: Array<(parent: HTMLElement) => void>;
  anchor?: { title: string; desc: string };
}

export function buildSettingsTabConfigs(tab: SystemSculptSettingTab): SettingsTabConfig[] {
  const configs: SettingsTabConfig[] = [
    {
      id: "account",
      label: "Account",
      sections: [
        (parent) => renderAccountSection(parent, tab, tab.plugin.settings.licenseValid === true),
        (parent) => renderSupportSection(parent, tab, tab.plugin.settings.licenseValid === true),
      ],
      anchor: {
        title: "SystemSculpt Account, License, Credits, Support",
        desc: "License, credits, billing and support.",
      },
    },
  ];

  configs.push(
    {
      id: "chat",
      label: "Chat",
      sections: [
        (parent) => { void displayChatTabContent(parent, tab); },
      ],
      anchor: {
        title: "Chat Preferences, Display",
        desc: "Chat display, tags and motion.",
      },
    },
    {
      id: "workflow",
      label: "Workflow",
      sections: [
        (parent) => { void displayRecorderTabContent(parent, tab); },
      ],
      anchor: {
        title: "Audio Capture, Recording, Transcription",
        desc: "Recording and transcription.",
      },
    },
    {
      id: "knowledge",
      label: "Knowledge",
      sections: [
        (parent) => {
          void displayEmbeddingsTabContent(parent, tab);
        },
      ],
      anchor: {
        title: "Embeddings, Similar Notes",
        desc: "Semantic search and similar notes.",
      },
    },
    {
      id: "workspace",
      label: "Workspace",
      sections: [
        (parent) => displayDirectoriesTabContent(parent, tab),
        (parent) => displayPhoneCapturesTabContent(parent, tab),
        (parent) => displayBackupTabContent(parent, tab),
      ],
      get anchor() {
        return {
          title: tab.plugin.settings.phoneCapturesLinked === true
            ? "Directories, Files, iOS Captures, Backups, Restore"
            : "Directories, Files, Backups, Restore",
          desc: "Folders, backups and restore.",
        };
      },
    },
    {
      id: "studio",
      label: "Studio",
      sections: [
        (parent) => {
          displayImageGenerationTabContent(parent, tab);
        },
      ],
      anchor: {
        title: "SystemSculpt Studio, Image Generation",
        desc: "Studio and image generation.",
      },
    },
    {
      id: "advanced",
      label: "Advanced",
      sections: [
        (parent) => {
          displayAdvancedTabContent(parent, tab);
        },
      ],
      anchor: {
        title: "Advanced, Reset, Diagnostics",
        desc: "Reset and diagnostics.",
      },
    },
  );

  return configs;
}
