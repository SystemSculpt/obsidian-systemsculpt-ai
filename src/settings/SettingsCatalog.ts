import { Setting } from "obsidian";
import { STUDIO_DISPLAY_NAME } from "../studio/types";
import type { SystemSculptSettings } from "../types";

type SettingsCatalogSettings = Readonly<Pick<SystemSculptSettings,
  | "postProcessingEnabled"
  | "embeddingsEnabled"
  | "phoneCapturesLinked"
  | "licenseValid"
  | "licenseKey"
  | "embeddingsExclusions"
>>;

interface CatalogSettingDefinition {
  tabId: string;
  title: string;
  description: string;
  isVisible?: (settings: SettingsCatalogSettings) => boolean;
  /** Transient rows cannot be located from saved settings alone. */
  searchable?: false;
}

const SETTINGS_CATALOG = {
  "account.status": {
    tabId: "account",
    title: "Account",
    description: "Sign in and manage your license.",
  },
  "account.browser-sign-in": {
    tabId: "account",
    title: "Browser sign-in",
    description: "Reopen sign-in to get a code.",
    searchable: false,
  },
  "account.connection-code": {
    tabId: "account",
    title: "Connection code",
    description: "Paste the code from your browser.",
    searchable: false,
  },
  "account.license-key": {
    tabId: "account",
    title: "License key",
    description: "Enter a license key to activate SystemSculpt.",
  },
  "account.credits": {
    tabId: "account",
    title: "Credits",
    description: "Balance and usage.",
    isVisible: (settings) => settings.licenseValid === true && (settings.licenseKey || "").trim().length > 0,
  },
  "account.ai-data": {
    tabId: "account",
    title: "AI data",
    description: "AI features send request content to SystemSculpt. See Terms and Privacy.",
  },
  "account.documentation": {
    tabId: "account",
    title: "Documentation",
    description: "Guides and support.",
  },
  "feedback.message": {
    tabId: "feedback",
    title: "What should we improve?",
    description: "Sent to support with your plugin version and account when signed in. No notes or chats attached.",
  },
  "chat.default-tag": {
    tabId: "chat",
    title: "Default chat tag",
    description: "Tag added to new chat notes.",
  },
  "chat.font-size": {
    tabId: "chat",
    title: "Default chat font size",
    description: "Text size for new chats.",
  },
  "chat.reduce-motion": {
    tabId: "chat",
    title: "Reduce chat motion",
    description: "Fewer chat animations.",
  },
  "workflow.microphone": {
    tabId: "workflow",
    title: "Microphone",
    description: "Used for new recordings on this device.",
  },
  "workflow.auto-transcribe": {
    tabId: "workflow",
    title: "Transcribe automatically",
    description: "Start transcription when a recording ends.",
  },
  "workflow.keep-source-audio": {
    tabId: "workflow",
    title: "Keep source audio",
    description: "Keep the recording after transcribing.",
  },
  "workflow.default-output": {
    tabId: "workflow",
    title: "Default output",
    description: "Selected when the processor opens.",
  },
  "workflow.insert-transcript": {
    tabId: "workflow",
    title: "Insert transcript at origin",
    description: "Insert the text where you started recording.",
  },
  "workflow.file-format": {
    tabId: "workflow",
    title: "Default file format",
    description: "Format for transcribed files.",
  },
  "workflow.clean-output": {
    tabId: "workflow",
    title: "Clean transcript output",
    description: "Transcript text only, no metadata.",
  },
  "workflow.cleanup": {
    tabId: "workflow",
    title: "Clean up transcript",
    description: "Fix punctuation and remove filler words.",
  },
  "workflow.cleanup-instructions": {
    tabId: "workflow",
    title: "Cleanup instructions",
    description: "How to tidy the transcript.",
    isVisible: (settings) => Boolean(settings.postProcessingEnabled),
  },
  "workflow.send-after-dictation": {
    tabId: "workflow",
    title: "Send after dictation",
    description: "Send the message once dictation ends.",
  },
  "knowledge.similar-notes": {
    tabId: "knowledge",
    title: "Similar notes",
    description: "Build a semantic index for your vault.",
  },
  "knowledge.index-status": {
    tabId: "knowledge",
    title: "Index status",
    description: "Indexing progress.",
    isVisible: (settings) => Boolean(settings.embeddingsEnabled),
  },
  "knowledge.rebuild-index": {
    tabId: "knowledge",
    title: "Rebuild index",
    description: "Start the index fresh.",
    isVisible: (settings) => Boolean(settings.embeddingsEnabled),
  },
  "knowledge.exclude-chat-history": {
    tabId: "knowledge",
    title: "Exclude chat history",
    description: "Skip chat notes when indexing.",
  },
  "knowledge.respect-exclusions": {
    tabId: "knowledge",
    title: "Respect Obsidian exclusions",
    description: "Skip files ignored in Files and links.",
  },
  "knowledge.excluded-folders": {
    tabId: "knowledge",
    title: "Excluded folders",
    description: "Never indexed.",
  },
  "knowledge.excluded-patterns": {
    tabId: "knowledge",
    title: "Excluded patterns",
    description: "Glob patterns to skip, like *.png.",
  },
  "workspace.chats-directory": {
    tabId: "workspace",
    title: "Chats directory",
    description: "Where new chats are saved.",
  },
  "workspace.recordings-directory": {
    tabId: "workspace",
    title: "Recordings directory",
    description: "Where recordings are stored.",
  },
  "workspace.extractions-directory": {
    tabId: "workspace",
    title: "Extractions directory",
    description: "Where extracted documents are stored.",
  },
  "workspace.directory-health": {
    tabId: "workspace",
    title: "Directory health",
    description: "Check or repair folders.",
  },
  "workspace.phone-captures": {
    tabId: "workspace",
    title: "iOS captures",
    description: "Notes and voice memos from the iOS app.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.save-phone-captures": {
    tabId: "workspace",
    title: "Save iOS captures",
    description: "Save new captures as they arrive.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.confirm-phone-captures": {
    tabId: "workspace",
    title: "Ask before saving iOS captures",
    description: "Confirm before captures are saved.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.run-phone-handoffs": {
    tabId: "workspace",
    title: "Run iPhone handoffs without asking",
    description: "Skips the Run button. Approvals still apply.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.phone-captures-folder": {
    tabId: "workspace",
    title: "iOS captures folder",
    description: "New notes land here. Nothing is overwritten.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.phone-meetings-folder": {
    tabId: "workspace",
    title: "iOS meetings folder",
    description: "Meeting notes land here.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.automatic-backups": {
    tabId: "workspace",
    title: "Automatic backups",
    description: "Daily backup of settings, without keys.",
  },
  "workspace.manual-backups": {
    tabId: "workspace",
    title: "Manual backups",
    description: "Back up or restore now.",
  },
  "workspace.restore-backup": {
    tabId: "workspace",
    title: "Restore from backup",
    description: "Replace settings with a backup.",
  },
  "workspace.backup-folder": {
    tabId: "workspace",
    title: "Backup folder",
    description: "Stored in .systemsculpt/settings-backups inside your vault.",
  },
  "studio.open": {
    tabId: "studio",
    title: `Open ${STUDIO_DISPLAY_NAME}`,
    description: "",
  },
  "studio.projects-folder": {
    tabId: "studio",
    title: "Projects folder",
    description: `Default vault folder for new ${STUDIO_DISPLAY_NAME} projects.`,
  },
  "studio.run-retention": {
    tabId: "studio",
    title: "Run retention",
    description: "Maximum completed runs kept per project.",
  },
  "studio.artifact-retention": {
    tabId: "studio",
    title: "Artifact retention (mb)",
    description: "Oldest run files are pruned past this size.",
  },
  "advanced.quick-actions": {
    tabId: "advanced",
    title: "Quick actions",
    description: "",
  },
  "advanced.relative-line-numbers": {
    tabId: "advanced",
    title: "Relative line numbers",
    description: "Vim-style line numbers. Turn off Obsidian's own line numbers.",
  },
  "advanced.reset": {
    tabId: "advanced",
    title: "Reset to factory settings",
    description: "Restore every default.",
  },
  "advanced.record-diagnostics": {
    tabId: "advanced",
    title: "Record diagnostics",
    description: "For troubleshooting only.",
  },
  "advanced.copy-diagnostics": {
    tabId: "advanced",
    title: "Copy diagnostics snapshot",
    description: "A summary for support, no note content.",
  },
  "advanced.diagnostics-folder": {
    tabId: "advanced",
    title: "Diagnostics folder",
    description: "Saved in .systemsculpt/diagnostics inside your vault.",
  },
} satisfies Record<string, CatalogSettingDefinition>;

export type CatalogSettingId = keyof typeof SETTINGS_CATALOG;

export interface SettingsCatalogDescriptor {
  id: string;
  tabId: string;
  title: string;
  description: string;
}

/** Search metadata without rendering tabs or accessing services, the DOM, or the vault. */
export function getSettingsCatalog(settings: SettingsCatalogSettings): SettingsCatalogDescriptor[] {
  const descriptors: SettingsCatalogDescriptor[] = [];
  for (const id of Object.keys(SETTINGS_CATALOG) as CatalogSettingId[]) {
    const definition: CatalogSettingDefinition = SETTINGS_CATALOG[id];
    if (definition.searchable === false || (definition.isVisible && !definition.isVisible(settings))) continue;
    descriptors.push({
      id,
      tabId: definition.tabId,
      title: definition.title,
      description: definition.description,
    });
  }
  for (const type of ["folders", "patterns"] as const) {
    for (const [index, title] of (settings.embeddingsExclusions?.[type] ?? []).entries()) {
      descriptors.push({ id: `knowledge.${type}.${index}`, tabId: "knowledge", title, description: "" });
    }
  }
  return descriptors;
}

/** Render the shared copy and a stable target; callers retain controls and dynamic descriptions. */
export function createCatalogSetting(parent: HTMLElement, id: CatalogSettingId): Setting {
  const definition = SETTINGS_CATALOG[id];
  const setting = new Setting(parent)
    .setName(definition.title)
    .setDesc(definition.description);
  setting.settingEl.dataset.ssSetting = id;
  return setting;
}
