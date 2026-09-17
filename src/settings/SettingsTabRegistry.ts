import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { displaySetupTabContent } from "./SetupTabContent";
import { displayChatTabContent } from "./ChatTabContent";
import { displayRecorderTabContent } from "./RecorderTabContent";
import { displayDirectoriesTabContent } from "./DirectoriesTabContent";
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
  const isProActive = tab.plugin.settings.licenseValid === true;

  const configs: SettingsTabConfig[] = [
    {
      id: "account",
      label: "Account",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          displaySetupTabContent(section, tab, isProActive);
        },
      ],
      anchor: {
        title: "SystemSculpt Account, License, Credits, Support",
        desc: "Activate your SystemSculpt license, review credits and billing details, and open docs or support links.",
      },
    },
  ];

  configs.push(
    {
      id: "chat",
      label: "Chat",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          void displayChatTabContent(section, tab);
        },
      ],
      anchor: {
        title: "Chat Preferences, Display",
        desc: "Keep chat preferences here, including display defaults, history tagging, and accessibility choices while SystemSculpt handles the chat experience itself.",
      },
    },
    {
      id: "workflow",
      label: "Workflow",
      sections: [
        (parent) => {
          const section = parent.createDiv();
          void displayRecorderTabContent(section, tab);
        },
      ],
      anchor: {
        title: "Audio Capture, Recording, Transcription",
        desc: "Configure recording, transcription, and post-processing.",
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
        desc: "Manage semantic search and related note discovery while SystemSculpt handles the processing.",
      },
    },
    {
      id: "workspace",
      label: "Workspace",
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
        title: "Directories, Files, Backups, Restore",
        desc: "Control vault folders, verify or repair the SystemSculpt workspace layout, and manage backups and restores for client-side settings.",
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
        desc: "Manage Studio workflows and SystemSculpt image generation options.",
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
        desc: "Reset to factory settings and open diagnostics or troubleshooting tools.",
      },
    },
  );

  return configs;
}
