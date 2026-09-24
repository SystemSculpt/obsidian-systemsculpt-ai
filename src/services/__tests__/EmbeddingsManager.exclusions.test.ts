jest.mock("../embeddings/storage/EmbeddingsStorage", () => {
  const storageMock = {
    initialize: jest.fn(),
    loadEmbeddings: jest.fn(),
    clear: jest.fn(),
    getAllVectors: jest.fn(() => []),
    getVectorsByPath: jest.fn(() => []),
    peekCurrentManagedNamespace: jest.fn(() => null),
    size: jest.fn(() => 0),
    storeVectors: jest.fn(),
    removeCurrentManagedGeneration: jest.fn(),
    removeByPath: jest.fn(),
    renameByPath: jest.fn(),
    renameByDirectory: jest.fn(),
    removeByDirectory: jest.fn(),
    getVectorSync: jest.fn(),
    purgeCorruptedVectors: jest.fn(() => ({
      removedCount: 0,
      correctedCount: 0,
      removedPaths: [],
      correctedPaths: [],
    })),
  };
  const EmbeddingsStorage = jest.fn(() => storageMock);
  (EmbeddingsStorage as any).buildDbName = jest.fn(() => "SystemSculptEmbeddings::test-vault");
  return { EmbeddingsStorage };
});

jest.mock("../embeddings/processing/EmbeddingsProcessor", () => {
  return {
    EmbeddingsProcessor: jest.fn().mockImplementation(() => ({
      processFiles: jest.fn(),
      cancel: jest.fn(),
      setConfig: jest.fn(),
      cleanup: jest.fn(),
    })),
  };
});

import { EmbeddingsManager } from "../embeddings/EmbeddingsManager";
import { SystemSculptSearchEngine } from "../search/SystemSculptSearchEngine";
import { shouldExcludeFromSearch } from "../../tools/vault/searchUtils";
import { App, TFile } from "obsidian";

function createPluginStub(overrides?: Partial<any>) {
  const settings = {
    vaultInstanceId: "test-vault",
    embeddingsVectorFormatVersion: 2,
    embeddingsExclusions: {
      folders: [],
      patterns: [],
      ignoreChatHistory: true,
      respectObsidianExclusions: true,
    },
    embeddingsEnabled: true,
    licenseKey: "fake-license",
    licenseValid: true,
    serverUrl: "https://systemsculpt.com/api/plugin",
    chatsDirectory: "SystemSculpt/Chats",
    savedChatsDirectory: "SystemSculpt/Saved Chats",
    ...(overrides?.settings || {}),
  };

  const vault = {
    getMarkdownFiles: jest.fn(() => []),
    getAbstractFileByPath: jest.fn(() => null),
    read: jest.fn(),
    on: jest.fn(() => jest.fn()),
    offref: jest.fn(),
  };

  const app = { vault };

  return {
    app,
    settings,
    emitter: {
      emit: jest.fn(),
      on: jest.fn(() => jest.fn()),
    },
    getManagedCapabilityGraph: jest.fn(() => ({
      embeddingsIndex: {
        activeGeneration: undefined,
        metadata: undefined,
      },
    })),
    ...(overrides || {}),
  };
}

describe("EmbeddingsManager exclusions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["Private/**/*.md", "Private/Note.md", true],
    ["Private/**/*.md", "Private/Deep/Folder/Note.md", true],
    ["Private/*.md", "Private/Deep/Note.md", false],
    ["Private/?.md", "Private/A.md", true],
    ["Private/?.md", "Private/AB.md", false],
    ["[draft]*.md", "Notes/[draft] hello.md", true],
    ["*.MD", "Notes/example.md", true],
  ])("applies %s to %s through the file-index interface", (pattern, path, excluded) => {
    const plugin = createPluginStub({ settings: {
      embeddingsExclusions: { folders: [], patterns: [pattern], ignoreChatHistory: false },
    } });
    const file = new TFile({ path, name: path.split("/").pop(), extension: "md", stat: { mtime: 1, size: 10 } });
    plugin.app.vault.getAbstractFileByPath.mockReturnValue(file);
    const manager = new EmbeddingsManager(plugin.app as any, plugin as any);
    expect(manager.getFileIndexSnapshot(path).state === "excluded").toBe(excluded);
  });

  it("excludes files in chatsDirectory and savedChatsDirectory when ignoreChatHistory is enabled", () => {
    const pluginStub = createPluginStub({
      settings: {
        embeddingsExclusions: {
          folders: [],
          patterns: [],
          ignoreChatHistory: true,
          respectObsidianExclusions: true,
        },
        chatsDirectory: "SystemSculpt/Chats",
        savedChatsDirectory: "SystemSculpt/SystemSculpt Operations/Saved Chats",
      },
    });

    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    const chatFile = {
      path: "SystemSculpt/Chats/abc.md",
      basename: "abc",
      extension: "md",
      stat: { mtime: Date.now(), size: 200 },
    };
    const savedChatFile = {
      path: "SystemSculpt/SystemSculpt Operations/Saved Chats/2025-09-03-Chat.md",
      basename: "2025-09-03-Chat",
      extension: "md",
      stat: { mtime: Date.now(), size: 200 },
    };

    expect((manager as any).evaluateFileProcessingState(chatFile).reason).toBe("excluded");
    expect((manager as any).evaluateFileProcessingState(savedChatFile).reason).toBe("excluded");
  });

  it("does not exclude chat files when ignoreChatHistory is disabled", () => {
    const pluginStub = createPluginStub({
      settings: {
        embeddingsExclusions: {
          folders: [],
          patterns: [],
          ignoreChatHistory: false,
          respectObsidianExclusions: true,
        },
        chatsDirectory: "SystemSculpt/Chats",
        savedChatsDirectory: "SystemSculpt/Saved Chats",
      },
    });

    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    const chatFile = {
      path: "SystemSculpt/Chats/abc.md",
      basename: "abc",
      extension: "md",
      stat: { mtime: Date.now(), size: 200 },
    };

    const state = (manager as any).evaluateFileProcessingState(chatFile);
    expect(state.reason).not.toBe("excluded");
  });

  it("excludes legacy Saved Chats paths under SystemSculpt even when savedChatsDirectory differs", () => {
    const pluginStub = createPluginStub({
      settings: {
        embeddingsExclusions: {
          folders: [],
          patterns: [],
          ignoreChatHistory: true,
          respectObsidianExclusions: true,
        },
        // Current configured saved chats directory differs from where older notes live.
        savedChatsDirectory: "SystemSculpt/Saved Chats",
      },
    });

    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    const legacySavedChatFile = {
      path: "SystemSculpt/SystemSculpt Operations/Saved Chats/2025-09-03-Chat.md",
      basename: "2025-09-03-Chat",
      extension: "md",
      stat: { mtime: Date.now(), size: 200 },
    };

    expect((manager as any).evaluateFileProcessingState(legacySavedChatFile).reason).toBe("excluded");
  });

  it("excludes Saved Chats paths nested under other SystemSculpt folders", () => {
    const pluginStub = createPluginStub({
      settings: {
        embeddingsExclusions: {
          folders: [],
          patterns: [],
          ignoreChatHistory: true,
          respectObsidianExclusions: true,
        },
        // User may have moved chat transcripts under another SystemSculpt-related folder.
        savedChatsDirectory: "SystemSculpt/Saved Chats",
      },
    });

    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    const nestedSavedChatFile = {
      path: "90 - system/systemsculpt-operations/Saved Chats/2025-09-03-Chat.md",
      basename: "2025-09-03-Chat",
      extension: "md",
      stat: { mtime: Date.now(), size: 200 },
    };

    expect((manager as any).evaluateFileProcessingState(nestedSavedChatFile).reason).toBe("excluded");
  });

  describe("existing embeddings exclusion behaviour", () => {
    function managerWith(
      exclusions: Record<string, unknown>,
      options: { userIgnoreFilters?: string[]; settings?: Record<string, unknown>; config?: any } = {},
    ) {
      const plugin = createPluginStub({ settings: {
        embeddingsExclusions: {
          folders: [],
          patterns: [],
          ignoreChatHistory: true,
          respectObsidianExclusions: true,
          ...exclusions,
        },
        ...options.settings,
      } });
      (plugin.app.vault as any).getConfig = jest.fn((key: string) => (
        key === "userIgnoreFilters" ? options.userIgnoreFilters ?? null : null
      ));
      const manager = new EmbeddingsManager(plugin.app as any, plugin as any, options.config);
      return { manager, plugin, excluded: (path: string) => (manager as any).isPathExcluded(path) as boolean };
    }

    it("excludes configured folders by path prefix", () => {
      const { excluded } = managerWith({ folders: ["Private", "Work/Secret/"] });
      expect(excluded("Private/plan.md")).toBe(true);
      expect(excluded("Private/Deep/plan.md")).toBe(true);
      expect(excluded("Work/Secret/plan.md")).toBe(true);
      expect(excluded("Private Notes/plan.md")).toBe(false);
      expect(excluded("Notes/Private/plan.md")).toBe(false);
    });

    it("matches slash-free globs against the file name and path globs against the vault path", () => {
      const { excluded } = managerWith({ patterns: ["draft-*.md", "Projects/*/scratch.md"] });
      expect(excluded("Anywhere/Deep/draft-1.md")).toBe(true);
      expect(excluded("Projects/Launch/scratch.md")).toBe(true);
      expect(excluded("Projects/Launch/Deep/scratch.md")).toBe(false);
      expect(excluded("Notes/final.md")).toBe(false);
    });

    it("normalizes backslashes and leading slashes before matching", () => {
      const { excluded } = managerWith({ folders: ["Private"] });
      expect(excluded("\\Private\\plan.md")).toBe(true);
      expect(excluded("/Private/plan.md")).toBe(true);
      expect(excluded("")).toBe(false);
    });

    it("excludes Obsidian excluded folders and stops when the user opts out", () => {
      const respected = managerWith({}, { userIgnoreFilters: ["Templates/"] });
      expect(respected.excluded("Templates/Meeting.md")).toBe(true);
      expect(respected.excluded("Notes/Meeting.md")).toBe(false);

      const ignored = managerWith({ respectObsidianExclusions: false }, { userIgnoreFilters: ["Templates/"] });
      expect(ignored.excluded("Templates/Meeting.md")).toBe(false);
    });

    it("keeps indexing plugin working folders that only search hides", () => {
      const { excluded } = managerWith({}, { settings: {
        recordingsDirectory: "SystemSculpt/Recordings",
        attachmentsDirectory: "SystemSculpt/Attachments",
        extractionsDirectory: "SystemSculpt/Extractions",
      } });
      expect(excluded("SystemSculpt/Recordings/memo.md")).toBe(false);
      expect(excluded("SystemSculpt/Attachments/scan.md")).toBe(false);
      expect(excluded("SystemSculpt/Extractions/report.md")).toBe(false);
    });

    it("prefers constructor exclusion overrides over saved settings", () => {
      const { excluded } = managerWith({ folders: ["FromSettings"] }, {
        config: { exclusions: { folders: ["FromConfig"] } },
      });
      expect(excluded("FromConfig/a.md")).toBe(true);
      expect(excluded("FromSettings/a.md")).toBe(false);
    });

    it("applies updated exclusions after a settings sync", () => {
      const { manager, plugin, excluded } = managerWith({ patterns: [] });
      expect(excluded("Daily/today.md")).toBe(false);
      plugin.settings.embeddingsExclusions = {
        ...plugin.settings.embeddingsExclusions,
        patterns: ["Daily/**"],
      };
      plugin.settings.embeddingsEnabled = false;
      (manager as any).cleanupExcludedEmbeddings = jest.fn(async () => undefined);
      manager.syncFromSettings();
      expect(excluded("Daily/today.md")).toBe(true);
      expect((manager as any).cleanupExcludedEmbeddings).toHaveBeenCalledTimes(1);
    });
  });

  describe("one policy across embeddings, search and agent vault tools", () => {
    const cases: Array<[string, string, string]> = [
      ["*.PNG", "Images/photo.png", "Images/photo.md"],
      ["Daily/**", "Daily/2026/today.md", "Journal/Daily/today.md"],
      ["**/Archive/*", "Projects/Archive/old.md", "Projects/Archive/Nested/old.md"],
    ];

    it.each(cases)("%s excludes %s but not %s everywhere", async (pattern, excludedPath, includedPath) => {
      const settings = {
        embeddingsEnabled: false,
        chatsDirectory: "SystemSculpt/Chats",
        savedChatsDirectory: "SystemSculpt/Saved Chats",
        embeddingsExclusions: {
          folders: [],
          patterns: [pattern],
          ignoreChatHistory: true,
          respectObsidianExclusions: true,
        },
      };

      const pluginStub = createPluginStub({ settings });
      const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
      expect((manager as any).isPathExcluded(excludedPath)).toBe(true);
      expect((manager as any).isPathExcluded(includedPath)).toBe(false);

      const app = new App();
      const toolPlugin = { app, settings } as any;
      expect(shouldExcludeFromSearch(new TFile({ path: excludedPath }), toolPlugin)).toBe(true);
      expect(shouldExcludeFromSearch(new TFile({ path: includedPath }), toolPlugin)).toBe(false);

      const files = [excludedPath, includedPath].map((path) => new TFile({ path, stat: { mtime: Date.now() } }));
      app.vault.getFiles.mockReturnValue(files);
      app.vault.cachedRead.mockResolvedValue("shared keyword");
      app.vault.getAbstractFileByPath.mockImplementation((path: string) => files.find((file) => file.path === path) ?? null);
      (app.workspace as any).offref = jest.fn();
      const engine = new SystemSculptSearchEngine(app as any, toolPlugin);
      try {
        const hits = (await engine.search("shared keyword", { mode: "lexical", limit: 10 })).results.map((hit) => hit.path);
        const eligible = (engine as any).getEligibleFiles().map((file: TFile) => file.path);
        expect(eligible).not.toContain(excludedPath);
        expect(eligible).toContain(includedPath);
        expect(hits).not.toContain(excludedPath);
        expect(hits).toContain(includedPath);
      } finally {
        engine.destroy();
      }
    });

    it("matches globs without case in search too: *.CANVAS hides a lowercase canvas", async () => {
      const app = new App();
      const settings = {
        embeddingsEnabled: false,
        embeddingsExclusions: { folders: [], patterns: ["*.CANVAS"], ignoreChatHistory: true, respectObsidianExclusions: true },
      };
      const files = [
        new TFile({ path: "Boards/plan.canvas", stat: { mtime: Date.now() } }),
        new TFile({ path: "Boards/plan.md", stat: { mtime: Date.now() } }),
      ];
      app.vault.getFiles.mockReturnValue(files);
      app.vault.cachedRead.mockResolvedValue("{\"nodes\":[{\"id\":\"a\",\"type\":\"text\",\"text\":\"plan\"}]}");
      (app.workspace as any).offref = jest.fn();
      const engine = new SystemSculptSearchEngine(app as any, { app, settings } as any);
      try {
        const hits = (await engine.search("plan", { mode: "lexical", limit: 10 })).results.map((hit) => hit.path);
        expect(hits).toEqual(["Boards/plan.md"]);
      } finally {
        engine.destroy();
      }
    });
  });
});
