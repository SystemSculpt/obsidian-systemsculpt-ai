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
    description: "Sign in, activate a license, and manage your SystemSculpt account.",
  },
  "account.browser-sign-in": {
    tabId: "account",
    title: "Browser sign-in",
    description: "Open the same sign-in request again to get a connection code.",
    searchable: false,
  },
  "account.connection-code": {
    tabId: "account",
    title: "Connection code",
    description: "If Obsidian did not open automatically, paste the code shown in your browser.",
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
    description: "Review your credits balance, usage, billing cycle, and credit purchases.",
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
    description: "Guides, troubleshooting, and ways to contact support.",
  },
  "chat.default-tag": {
    tabId: "chat",
    title: "Default chat tag",
    description: "Optional. Adds this tag to new chat history notes (frontmatter `tags`).",
  },
  "chat.font-size": {
    tabId: "chat",
    title: "Default chat font size",
    description: "Select the default text size for new chat messages.",
  },
  "chat.reduce-motion": {
    tabId: "chat",
    title: "Reduce chat motion",
    description: "Minimize chat animations even when your system does not request reduced motion. Your system preference is always honored.",
  },
  "workflow.microphone": {
    tabId: "workflow",
    title: "Microphone",
    description: "Choose the microphone used for new recordings on this device.",
  },
  "workflow.auto-transcribe": {
    tabId: "workflow",
    title: "Transcribe automatically",
    description: "Start transcription when a recording ends.",
  },
  "workflow.keep-source-audio": {
    tabId: "workflow",
    title: "Keep source audio",
    description: "Keep the recording in your vault after transcription succeeds.",
  },
  "workflow.default-output": {
    tabId: "workflow",
    title: "Default output",
    description: "Choose the output selected when the processor opens.",
  },
  "workflow.insert-transcript": {
    tabId: "workflow",
    title: "Insert transcript at origin",
    description: "Add the finished text only if its exact note insertion target remains unchanged, or if the original chat conversation is still active.",
  },
  "workflow.file-format": {
    tabId: "workflow",
    title: "Default file format",
    description: "Choose the format used when you transcribe an audio file.",
  },
  "workflow.clean-output": {
    tabId: "workflow",
    title: "Clean transcript output",
    description: "Save only the transcript text, without source details or metadata.",
  },
  "workflow.cleanup": {
    tabId: "workflow",
    title: "Clean up transcript",
    description: "Fix punctuation, remove filler words, and format the transcript after transcription.",
  },
  "workflow.cleanup-instructions": {
    tabId: "workflow",
    title: "Cleanup instructions",
    description: "Tell SystemSculpt how to improve readability. Cleanup always keeps the original languages, names, and code-switches.",
    isVisible: (settings) => Boolean(settings.postProcessingEnabled),
  },
  "workflow.send-after-dictation": {
    tabId: "workflow",
    title: "Send after dictation",
    description: "Send the dictated chat message after the transcript is inserted.",
  },
  "knowledge.similar-notes": {
    tabId: "knowledge",
    title: "Similar notes",
    description: "Build a semantic index for your vault.",
  },
  "knowledge.index-status": {
    tabId: "knowledge",
    title: "Index status",
    description: "Review semantic index progress and remaining files.",
    isVisible: (settings) => Boolean(settings.embeddingsEnabled),
  },
  "knowledge.rebuild-index": {
    tabId: "knowledge",
    title: "Rebuild index",
    description: "Replace the local semantic index with a fresh copy.",
    isVisible: (settings) => Boolean(settings.embeddingsEnabled),
  },
  "knowledge.exclude-chat-history": {
    tabId: "knowledge",
    title: "Exclude chat history",
    description: "Skip chat transcripts when building embeddings.",
  },
  "knowledge.respect-exclusions": {
    tabId: "knowledge",
    title: "Respect Obsidian exclusions",
    description: "Reuse the ignored files configured in settings → files & links.",
  },
  "knowledge.excluded-folders": {
    tabId: "knowledge",
    title: "Excluded folders",
    description: "Folders that should never be processed.",
  },
  "knowledge.excluded-patterns": {
    tabId: "knowledge",
    title: "Excluded patterns",
    description: "File name patterns (glob) to skip, e.g., *.PNG.",
  },
  "workspace.chats-directory": {
    tabId: "workspace",
    title: "Chats directory",
    description: "Where new chats are saved. Existing chats stay in the folder they were saved in.",
  },
  "workspace.saved-chats-directory": {
    tabId: "workspace",
    title: "Saved chats directory",
    description: "Where chats saved as notes are stored.",
  },
  "workspace.recordings-directory": {
    tabId: "workspace",
    title: "Recordings directory",
    description: "Where recordings are stored.",
  },
  "workspace.attachments-directory": {
    tabId: "workspace",
    title: "Attachments directory",
    description: "Where saved images and attachments are stored.",
  },
  "workspace.extractions-directory": {
    tabId: "workspace",
    title: "Extractions directory",
    description: "Where extracted documents are stored.",
  },
  "workspace.directory-health": {
    tabId: "workspace",
    title: "Directory health",
    description: "Verify or repair SystemSculpt directories.",
  },
  "workspace.phone-captures": {
    tabId: "workspace",
    title: "iOS captures",
    description: "Notes and voice memos from the SystemSculpt iOS app arrive in this vault while you are signed in.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.save-phone-captures": {
    tabId: "workspace",
    title: "Save iOS captures",
    description: "Check for new captures when Obsidian opens, when it regains focus and every few minutes.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.confirm-phone-captures": {
    tabId: "workspace",
    title: "Ask before saving iOS captures",
    description: "Show the waiting captures and save them only when you confirm.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.run-phone-handoffs": {
    tabId: "workspace",
    title: "Run iPhone handoffs without asking",
    description: "Skips only the Run button for iPhone handoffs. Agent permissions and approval requests are unchanged.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.phone-captures-folder": {
    tabId: "workspace",
    title: "iOS captures folder",
    description: "Notes and transcripts become new notes here. Existing notes are never overwritten.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.phone-meetings-folder": {
    tabId: "workspace",
    title: "iOS meetings folder",
    description: "Meeting briefs, action items and transcripts become new notes here.",
    isVisible: (settings) => settings.phoneCapturesLinked === true,
  },
  "workspace.automatic-backups": {
    tabId: "workspace",
    title: "Automatic backups",
    description: "Create a backup every 24 hours. Backups include SystemSculpt preferences and feature settings, but exclude secret keys and tokens.",
  },
  "workspace.manual-backups": {
    tabId: "workspace",
    title: "Manual backups",
    description: "Create or restore backups on demand. Files live in .systemsculpt/settings-backups inside your vault, with sensitive keys redacted.",
  },
  "workspace.restore-backup": {
    tabId: "workspace",
    title: "Restore from backup",
    description: "Replace your current settings with a saved backup.",
  },
  "workspace.backup-folder": {
    tabId: "workspace",
    title: "Backup folder",
    description: "Stored in .systemsculpt/settings-backups inside your vault.",
  },
  "workspace.backup-tips": {
    tabId: "workspace",
    title: "Tips",
    description: "Automatic backups run in the background. Manual backups with custom names are useful before big changes. You can copy backup files to other devices to share your SystemSculpt configuration.",
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
    description: "Target artifact storage per project before oldest run assets are pruned.",
  },
  "advanced.quick-actions": {
    tabId: "advanced",
    title: "Quick actions",
    description: "",
  },
  "advanced.relative-line-numbers": {
    tabId: "advanced",
    title: "Relative line numbers",
    description: "Use a vim-style line number gutter in the editor. The current line shows its absolute number; other lines show their distance from the Cursor. Turn off Obsidian's core \"show line number\" setting to avoid a doubled gutter.",
  },
  "advanced.reset": {
    tabId: "advanced",
    title: "Reset to factory settings",
    description: "Clear all custom settings and restore defaults for this plugin.",
  },
  "advanced.record-diagnostics": {
    tabId: "advanced",
    title: "Record diagnostics",
    description: "Save resource samples and long-frame reports in .systemsculpt/diagnostics. Leave off unless you are troubleshooting. Chat lifecycle logs follow the log level; failed chat runs still save incident reports.",
  },
  "advanced.copy-diagnostics": {
    tabId: "advanced",
    title: "Copy diagnostics snapshot",
    description: "Copies a content-free runtime and resource summary for support.",
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
