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
import { TFile } from "obsidian";

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
});
