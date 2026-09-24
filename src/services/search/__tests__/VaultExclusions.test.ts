import {
  resolveVaultExclusions,
  searchVaultExclusions,
  type VaultExclusionSettings,
  type VaultExclusionSurface,
} from "../VaultExclusions";

type Options = Readonly<{
  exclusions?: VaultExclusionSettings;
  settings?: Record<string, unknown>;
  userIgnoreFilters?: unknown;
  configDir?: string;
}>;

function exclusionsFor(surface: VaultExclusionSurface, options: Options = {}) {
  return resolveVaultExclusions({
    exclusions: {
      folders: [],
      patterns: [],
      ignoreChatHistory: true,
      respectObsidianExclusions: true,
      ...options.exclusions,
    },
    settings: {
      chatsDirectory: "SystemSculpt/Chats",
      savedChatsDirectory: "SystemSculpt/Saved Chats",
      recordingsDirectory: "SystemSculpt/Recordings",
      attachmentsDirectory: "SystemSculpt/Attachments",
      extractionsDirectory: "SystemSculpt/Extractions",
      ...options.settings,
    },
    vault: {
      configDir: options.configDir ?? ".obsidian",
      getConfig: (key: string) => (key === "userIgnoreFilters" ? options.userIgnoreFilters ?? null : null),
    },
  }, surface);
}

describe("VaultExclusions", () => {
  describe.each(["embeddings", "search"] as const)("%s surface", (surface) => {
    it.each([
      ["*.PNG", "Images/photo.png", true],
      ["*.PNG", "Images/photo.PNG.md", false],
      ["Daily/**", "Daily/2026-09-24.md", true],
      ["Daily/**", "Daily/Nested/entry.md", true],
      ["Daily/**", "Journal/Daily/entry.md", false],
      ["**/Archive/*", "Archive/old.md", true],
      ["**/Archive/*", "Projects/Archive/old.md", true],
      ["**/Archive/*", "Projects/Archive/Nested/old.md", false],
      ["draft-?.md", "Notes/draft-1.md", true],
      ["draft-?.md", "Notes/draft-10.md", false],
    ])("treats pattern %s as a glob for %s", (pattern, path, excluded) => {
      const exclusions = exclusionsFor(surface, { exclusions: { patterns: [pattern] } });
      expect(exclusions.isExcluded(path)).toBe(excluded);
    });

    it("keeps regex syntax in patterns literal", () => {
      const exclusions = exclusionsFor(surface, { exclusions: { patterns: ["(a+)+b", "[invalid", "\\.tmp$"] } });
      expect(exclusions.isExcluded("Notes/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md")).toBe(false);
      expect(exclusions.isExcluded("Notes/cache.tmp")).toBe(false);
      expect(exclusions.isExcluded("Notes/[invalid")).toBe(true);
    });

    it("matches Obsidian's excluded files: case-insensitive prefixes and /regex/ entries", () => {
      const exclusions = exclusionsFor(surface, {
        userIgnoreFilters: ["Templates/", "  Scratch  ", "/\\.excalidraw\\.md$/", "/[unclosed/", "", 42],
      });
      expect(exclusions.isExcluded("Templates/Meeting.md")).toBe(true);
      expect(exclusions.isExcluded("templates/meeting.md")).toBe(true);
      expect(exclusions.isExcluded("Projects/Templates/Meeting.md")).toBe(false);
      expect(exclusions.isExcluded("Scratchpad.md")).toBe(true);
      expect(exclusions.isExcluded("Drawings/Plan.Excalidraw.md")).toBe(true);
      expect(exclusions.isExcluded("Notes/Plan.md")).toBe(false);
    });

    it("ignores Obsidian's excluded files when the user opts out", () => {
      const exclusions = exclusionsFor(surface, {
        exclusions: { respectObsidianExclusions: false },
        userIgnoreFilters: ["Templates/"],
      });
      expect(exclusions.isExcluded("Templates/Meeting.md")).toBe(false);
    });

    it("survives a vault config lookup that throws", () => {
      const exclusions = resolveVaultExclusions({
        exclusions: { respectObsidianExclusions: true },
        settings: {},
        vault: { getConfig: () => { throw new Error("config unavailable"); } },
      }, surface);
      expect(exclusions.isExcluded("Notes/file.md")).toBe(false);
    });

    it("excludes user folders on whole path segments", () => {
      const exclusions = exclusionsFor(surface, { exclusions: { folders: ["Private", "/Work/Secret/", "", "   "] } });
      expect(exclusions.isExcluded("Private/plan.md")).toBe(true);
      expect(exclusions.isExcluded("private/plan.md")).toBe(true);
      expect(exclusions.isExcluded("Work/Secret/plan.md")).toBe(true);
      expect(exclusions.isExcluded("Private Notes/plan.md")).toBe(false);
      expect(exclusions.isExcluded("Work/Secrets.md")).toBe(false);
    });

    it("excludes configured and default chat directories while chat history is excluded", () => {
      const exclusions = exclusionsFor(surface, {
        settings: { chatsDirectory: "Archive/Chats", savedChatsDirectory: "Saved" },
      });
      expect(exclusions.isExcluded("Archive/Chats/today.md")).toBe(true);
      expect(exclusions.isExcluded("Saved/export.md")).toBe(true);
      // Transcripts left in SystemSculpt chat folders after a move stay excluded.
      expect(exclusions.isExcluded("SystemSculpt/Chats/old.md")).toBe(true);
      expect(exclusions.isExcluded("SystemSculpt/Saved Chats/old.md")).toBe(true);
      expect(exclusions.isExcluded("90 - system/systemsculpt-operations/Saved Chats/old.md")).toBe(true);
      expect(exclusions.isExcluded("Notes/Chats/meeting.md")).toBe(false);

      const included = exclusionsFor(surface, {
        exclusions: { ignoreChatHistory: false },
        settings: { chatsDirectory: "Archive/Chats" },
      });
      expect(included.isExcluded("Archive/Chats/today.md")).toBe(false);
      expect(included.isExcluded("SystemSculpt/Chats/old.md")).toBe(false);
    });

    it("normalizes separators and leading slashes in paths", () => {
      const exclusions = exclusionsFor(surface, { exclusions: { folders: ["Private"], patterns: ["Daily/**"] } });
      expect(exclusions.isExcluded("/Private/plan.md")).toBe(true);
      expect(exclusions.isExcluded("Daily\\entry.md")).toBe(true);
      expect(exclusions.isExcluded("")).toBe(false);
    });
  });

  it("hides plugin working folders, the config folder and node_modules from search only", () => {
    const options: Options = {
      settings: {
        recordingsDirectory: "Audio",
        attachmentsDirectory: "Files/Attachments",
        extractionsDirectory: "Extracted",
      },
      configDir: ".config-obsidian",
    };
    const search = exclusionsFor("search", options);
    const embeddings = exclusionsFor("embeddings", options);
    for (const path of [
      "Audio/memo.md",
      "Files/Attachments/scan.md",
      "Extracted/report.md",
      ".config-obsidian/plugins/data.json",
      "node_modules/pkg/readme.md",
      "Code/node_modules/pkg/readme.md",
    ]) {
      expect(search.isExcluded(path)).toBe(true);
      expect(embeddings.isExcluded(path)).toBe(false);
    }
  });

  it("uses configured working folders instead of hardcoded defaults", () => {
    const search = exclusionsFor("search", {
      settings: { recordingsDirectory: "Audio", attachmentsDirectory: "Files", extractionsDirectory: "Extracted" },
    });
    expect(search.isExcluded("SystemSculpt/Recordings/memo.md")).toBe(false);
    expect(search.isExcluded("SystemSculpt/Attachments/scan.md")).toBe(false);
    expect(search.isExcluded("SystemSculpt/Extractions/report.md")).toBe(false);
    // The legacy system prompts folder is ordinary vault content now.
    expect(search.isExcluded("SystemSculpt/System Prompts/prompt.md")).toBe(false);
  });

  it("compiles once per settings revision and recompiles when an input changes", () => {
    let filters: string[] = ["Templates/"];
    const plugin = {
      settings: {
        chatsDirectory: "Chats",
        embeddingsExclusions: { folders: ["Private"], patterns: ["*.png"], ignoreChatHistory: true, respectObsidianExclusions: true },
      },
      app: { vault: { configDir: ".obsidian", getConfig: jest.fn(() => filters) } },
    };

    const first = searchVaultExclusions(plugin);
    expect(searchVaultExclusions(plugin)).toBe(first);
    expect(searchVaultExclusions({ ...plugin, settings: { ...plugin.settings } })).toBe(first);

    filters = ["Scratch/"];
    const afterFilterEdit = searchVaultExclusions(plugin);
    expect(afterFilterEdit).not.toBe(first);
    expect(afterFilterEdit.signature).not.toBe(first.signature);
    expect(afterFilterEdit.isExcluded("Templates/a.md")).toBe(false);
    expect(afterFilterEdit.isExcluded("Scratch/a.md")).toBe(true);

    plugin.settings.embeddingsExclusions.folders = ["Private", "Journal"];
    const afterFolderEdit = searchVaultExclusions(plugin);
    expect(afterFolderEdit).not.toBe(afterFilterEdit);
    expect(afterFolderEdit.isExcluded("Journal/a.md")).toBe(true);
  });

  it("falls back to default rules when settings are missing", () => {
    const exclusions = searchVaultExclusions({ settings: {}, app: { vault: {} } });
    expect(exclusions.isExcluded("SystemSculpt/Chats/chat.md")).toBe(true);
    expect(exclusions.isExcluded("Notes/file.md")).toBe(false);
  });
});
