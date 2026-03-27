import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { PlatformContext } from "../services/PlatformContext";

type SetupTabContentModule = typeof import("./SetupTabContent");
type ProvidersTabContentModule = typeof import("./ProvidersTabContent");
type ChatTabContentModule = typeof import("./ChatTabContent");
type RecorderTabContentModule = typeof import("./RecorderTabContent");
type DirectoriesTabContentModule = typeof import("./DirectoriesTabContent");
type BackupTabContentModule = typeof import("./BackupTabContent");
type EmbeddingsTabContentModule = typeof import("./EmbeddingsTabContent");
type ImageGenerationTabContentModule = typeof import("./ImageGenerationTabContent");
type DataTabContentModule = typeof import("./DataTabContent");
type AdvancedTabContentModule = typeof import("./AdvancedTabContent");

function loadSetupTabContentModule(): SetupTabContentModule {
  return require("./SetupTabContent") as SetupTabContentModule;
}

function loadProvidersTabContentModule(): ProvidersTabContentModule {
  return require("./ProvidersTabContent") as ProvidersTabContentModule;
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

function loadDataTabContentModule(): DataTabContentModule {
  return require("./DataTabContent") as DataTabContentModule;
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
  const isDesktop = PlatformContext.get().supportsDesktopOnlyFeatures();

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

  if (isDesktop) {
    configs.push({
      id: "providers",
      label: "Providers",
      sections: [
        (parent) => {
          void loadProvidersTabContentModule().displayProvidersTabContent(parent, tab);
        },
      ],
      anchor: {
        title: "AI Providers, API Keys, OAuth, BYOK",
        desc: "Connect your own AI provider accounts (OpenAI, Anthropic, Google, OpenRouter, etc.) to use their models in Chat and Studio.",
      },
    });
  }

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
          void loadRecorderTabContentModule().displayRecorderTabContent(parent, tab);
        },
      ],
      anchor: {
        title: "Audio Capture, Recording, Transcription",
        desc: "Configure recording, transcription, and post-processing preferences for SystemSculpt.",
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
      id: "readwise",
      label: "Readwise",
      sections: [
        (parent) => {
          loadDataTabContentModule().displayDataTabContent(parent, tab);
        },
      ],
      anchor: {
        title: "Readwise Imports, Sync, Highlights",
        desc: "Manage your Readwise connection, import options, sync schedule, and manual sync actions.",
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
        desc: "Manage the desktop-only Studio workspace and SystemSculpt image generation options.",
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
        title: "Advanced, Update Notifications, Reset, Diagnostics",
        desc: "Update notifications, reset to factory settings, and diagnostics & troubleshooting tools.",
      },
    },
  );

  return configs;
}
