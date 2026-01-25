jest.mock("../embeddings/storage/EmbeddingsStorage", () => {
  const storageMock = {
    initialize: jest.fn(),
    loadEmbeddings: jest.fn(),
    clear: jest.fn(),
    getAllVectors: jest.fn(() => []),
    getVectorsByPath: jest.fn(() => []),
    size: jest.fn(() => 0),
    storeVectors: jest.fn(),
    removeByNamespacePrefix: jest.fn(),
    removeByPath: jest.fn(),
    removeByPathExceptIds: jest.fn(),
    moveVectorId: jest.fn(),
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
      setProvider: jest.fn(),
    })),
  };
});

jest.mock("../../core/ui/notifications", () => ({
  showNoticeWhenReady: jest.fn(),
}));

import { EmbeddingsManager } from "../embeddings/EmbeddingsManager";

function createPluginStub(overrides?: Partial<any>) {
  const settings = {
    vaultInstanceId: "test-vault",
    embeddingsVectorFormatVersion: 2,
    embeddingsProvider: "systemsculpt",
    embeddingsCustomEndpoint: "",
    embeddingsCustomApiKey: "",
    embeddingsCustomModel: "",
    embeddingsModel: "",
    embeddingsBatchSize: 8,
    embeddingsAutoProcess: false,
    embeddingsExclusions: {
      folders: [],
      patterns: [],
      ignoreChatHistory: true,
      respectObsidianExclusions: true,
    },
    embeddingsRateLimitPerMinute: 30,
    embeddingsEnabled: true,
    embeddingsQuietPeriodMs: 500,
    licenseKey: "fake-license",
    licenseValid: true,
    serverUrl: "https://api.systemsculpt.com/api/v1",
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
    ...(overrides || {}),
  };
}

describe("EmbeddingsManager exclusions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
