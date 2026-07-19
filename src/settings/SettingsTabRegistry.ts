import { SystemSculptSettingTab } from "./SystemSculptSettingTab";

type SetupTabContentModule = typeof import("./SetupTabContent");
type ChatTabContentModule = typeof import("./ChatTabContent");
type RecorderTabContentModule = typeof import("./RecorderTabContent");
type DirectoriesTabContentModule = typeof import("./DirectoriesTabContent");
type BackupTabContentModule = typeof import("./BackupTabContent");
type EmbeddingsTabContentModule = typeof import("./EmbeddingsTabContent");
type ImageGenerationTabContentModule = typeof import("./ImageGenerationTabContent");
type AdvancedTabContentModule = typeof import("./AdvancedTabContent");

function loadSetupTabContentModule(): SetupTabContentModule {
  return require("./SetupTabContent") as SetupTabContentModule;
}

function loadChatTabContentModule(): ChatTabContentModule {
  return require("./ChatTabContent") as ChatTabContentModule;
}

function loadRecorderTabContentModule(): RecorderTabContentModule {
  return require("./RecorderTabContent") as RecorderTabContentModule;
}

function loadDirectoriesTabContentModule(): DirectoriesTabContentModule {
  return require("./DirectoriesTabContent") as DirectoriesTabContentModule;
}

function loadBackupTabContentModule(): BackupTabContentModule {
  return require("./BackupTabContent") as BackupTabContentModule;
}

function loadEmbeddingsTabContentModule(): EmbeddingsTabContentModule {
  return require("./EmbeddingsTabContent") as EmbeddingsTabContentModule;
}

function loadImageGenerationTabContentModule(): ImageGenerationTabContentModule {
  return require("./ImageGenerationTabContent") as ImageGenerationTabContentModule;
}

function loadAdvancedTabContentModule(): AdvancedTabContentModule {
  return require("./AdvancedTabContent") as AdvancedTabContentModule;
}

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
          loadSetupTabContentModule().displaySetupTabContent(section, tab, isProActive);
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
          void loadChatTabContentModule().displayChatTabContent(section, tab);
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
          void loadRecorderTabContentModule().displayRecorderTabContent(section, tab);
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
          void loadEmbeddingsTabContentModule().displayEmbeddingsTabContent(parent, tab);
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
          loadDirectoriesTabContentModule().displayDirectoriesTabContent(section, tab);
        },
        (parent) => {
          const section = parent.createDiv();
          loadBackupTabContentModule().displayBackupTabContent(section, tab);
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
          void loadImageGenerationTabContentModule().displayImageGenerationTabContent(parent, tab);
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
          loadAdvancedTabContentModule().displayAdvancedTabContent(parent, tab);
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
