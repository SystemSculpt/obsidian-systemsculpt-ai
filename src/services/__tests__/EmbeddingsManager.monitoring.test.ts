jest.mock('../embeddings/storage/EmbeddingsStorage', () => {
  const storageMock = {
    initialize: jest.fn(),
    loadEmbeddings: jest.fn(),
    clear: jest.fn(),
    countVectors: jest.fn(() => 0),
    importFromLegacyGlobalDb: jest.fn(async () => ({ imported: 0, skipped: 0 })),
    upgradeVectorsToCanonicalFormat: jest.fn(async () => ({ updated: 0, skipped: 0, removed: 0 })),
    backfillRootCompleteness: jest.fn(async () => ({ updated: 0, skipped: 0 })),
    getAllVectors: jest.fn(() => []),
    getVectorsByPath: jest.fn(() => []),
    getVectorsByNamespace: jest.fn(() => []),
    getVectorsByNamespacePrefix: jest.fn(() => []),
    peekBestNamespaceForPrefix: jest.fn(() => null),
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
    getDistinctPaths: jest.fn(() => []),
  };
  const EmbeddingsStorage = jest.fn(() => storageMock);
  (EmbeddingsStorage as any).buildDbName = jest.fn(() => "SystemSculptEmbeddings::test-vault");
  return {
    EmbeddingsStorage,
  };
});

jest.mock('../embeddings/processing/EmbeddingsProcessor', () => {
  return {
    EmbeddingsProcessor: jest.fn().mockImplementation(() => ({
      processFiles: jest.fn(),
      cancel: jest.fn(),
      setProvider: jest.fn(),
    })),
  };
});

jest.mock('../../core/ui/notifications', () => ({
  showNoticeWhenReady: jest.fn(),
}));

import { EmbeddingsManager } from '../embeddings/EmbeddingsManager';
import { EmbeddingsProviderError } from '../embeddings/providers/ProviderError';
import { DEFAULT_EMBEDDING_DIMENSION } from '../../constants/embeddings';

function createPluginStub() {
  const emitter = {
    emit: jest.fn(),
    on: jest.fn(() => jest.fn()),
  };
  const settingsManager = {
    updateSettings: jest.fn(async () => {}),
  };

  const settings = {
    vaultInstanceId: "test-vault",
    embeddingsVectorFormatVersion: 2,
    embeddingsProvider: 'systemsculpt',
    embeddingsCustomEndpoint: '',
    embeddingsCustomApiKey: '',
    embeddingsCustomModel: '',
    embeddingsModel: '',
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
    licenseKey: 'fake-license',
    licenseValid: true,
    serverUrl: 'https://api.systemsculpt.com/api/v1',
  };

  const vault = {
    getMarkdownFiles: jest.fn(() => []),
    read: jest.fn(),
    on: jest.fn(() => jest.fn()),
    offref: jest.fn(),
    remove: jest.fn(),
  };

  const app = { vault };

  return {
    emitter,
    settings,
    app,
    getSettingsManager: jest.fn(() => settingsManager),
  };
}

describe('EmbeddingsManager monitoring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records failures, schedules cooldown, and returns aborted result', async () => {
    const pluginStub = createPluginStub();
    pluginStub.app.vault.getMarkdownFiles.mockReturnValue([
      {
        path: 'Test.md',
        basename: 'Test',
        extension: 'md',
        stat: { mtime: Date.now(), size: 10 },
      },
    ]);

    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
    (manager as any).shouldProcessFile = () => true;

    const processorInstance = (require('../embeddings/processing/EmbeddingsProcessor') as any).EmbeddingsProcessor.mock
      .results[0].value;

    const outageError = new EmbeddingsProviderError('Embeddings host temporarily unavailable. Retry in 120000ms', {
      code: 'HOST_UNAVAILABLE',
      transient: true,
      retryInMs: 120000,
      providerId: 'systemsculpt',
    });

    processorInstance.processFiles.mockImplementation(async () => {
      throw outageError;
    });

    const result = await manager.processVault();

    expect(result.status).toBe('aborted');
    expect(result.failure).toBe(outageError);
    expect(result.retryAt).toBeGreaterThan(Date.now());

    const snapshot = manager.getHealthSnapshot();
    expect(snapshot.consecutiveFailures).toBe(1);
    expect(snapshot.lastError?.code).toBe('HOST_UNAVAILABLE');

    expect(pluginStub.emitter.emit).toHaveBeenCalledWith(
      'embeddings:error',
      expect.objectContaining({
        error: expect.objectContaining({ code: 'HOST_UNAVAILABLE' }),
      })
    );
    expect(pluginStub.emitter.emit).toHaveBeenCalledWith(
      'embeddings:retry-scheduled',
      expect.objectContaining({ scope: 'vault' })
    );

    pluginStub.settings.licenseValid = false;
    expect(manager.isProviderReady()).toBe(false);

    processorInstance.processFiles.mockReset();
  });

  it('deduplicates chunk-level matches when retrieving similar notes', async () => {
    const pluginStub = createPluginStub();
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);

    const storageMock = (
      (require('../embeddings/storage/EmbeddingsStorage') as any).EmbeddingsStorage.mock.results.slice(-1)[0]
        .value
    );

    const namespace = `systemsculpt:openrouter/openai/text-embedding-3-small:v2:${DEFAULT_EMBEDDING_DIMENSION}`;

    const makeVector = (path: string, chunkId: number, vector: number[], section: string, length = 2000) => ({
      id: `${path}#${chunkId}`,
      path,
      chunkId,
      vector: Float32Array.from(vector),
      metadata: {
        title: path.replace('.md', ''),
        excerpt: `${section} preview`,
        mtime: Date.now(),
        contentHash: `${path}-${chunkId}`,
        provider: 'systemsculpt',
        model: 'openrouter/openai/text-embedding-3-small',
        dimension: DEFAULT_EMBEDDING_DIMENSION,
        createdAt: Date.now(),
        namespace,
        sectionTitle: section,
        headingPath: [section],
        chunkLength: length,
        ...(chunkId === 0 ? { complete: true, chunkCount: 2 } : {}),
      },
    });

    storageMock.getVectorsByPath.mockResolvedValue([
      makeVector('Source.md', 0, [1, 0, 0], 'Source Intro', 2100),
      makeVector('Source.md', 1, [0, 1, 0], 'Source Details', 1800),
    ]);

    const candidateVectors = [
      makeVector('Source.md', 0, [1, 0, 0], 'Source Intro', 2100),
      makeVector('Source.md', 1, [0, 1, 0], 'Source Details', 1800),
      makeVector('NoteA.md', 0, [1, 0, 0], 'NoteA Overview', 2050),
      makeVector('NoteA.md', 1, [0.8, 0.2, 0], 'NoteA Deep Dive', 1950),
      makeVector('NoteB.md', 0, [0, 1, 0], 'NoteB Summary', 2000),
    ];

    storageMock.getAllVectors.mockResolvedValue(candidateVectors);
    storageMock.getVectorsByNamespace.mockResolvedValue(candidateVectors);

    const results = await manager.findSimilar('Source.md', 5);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.path).sort()).toEqual(['NoteA.md', 'NoteB.md']);
    expect(results[0].metadata.sectionTitle).toBeTruthy();
  });

  it('marks files with legacy namespaces as schema mismatches', () => {
    const pluginStub = createPluginStub();
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
    const storageMock = (
      (require('../embeddings/storage/EmbeddingsStorage') as any).EmbeddingsStorage.mock.results.slice(-1)[0]
        .value
    );

    const legacyNamespace = 'systemsculpt:text-embedding-004:v2:768';
    storageMock.getVectorSync.mockReturnValue({
      id: 'Legacy.md#0',
      path: 'Legacy.md',
      chunkId: 0,
      vector: new Float32Array([0.1, 0.2]),
      metadata: {
        provider: 'systemsculpt',
        model: 'text-embedding-004',
        namespace: legacyNamespace,
        mtime: Date.now() - 10,
        dimension: 768,
      },
    });

    const file = {
      path: 'Legacy.md',
      basename: 'Legacy',
      extension: 'md',
      stat: { mtime: Date.now(), size: 500 },
    };

    const state = (manager as any).evaluateFileProcessingState(file);
    expect(state.needsProcessing).toBe(true);
    expect(state.reason).toBe('schema-mismatch');
    expect(state.existingNamespace).toBe(legacyNamespace);
  });

  it('deduplicates reprocess paths when queueing repairs', () => {
    const pluginStub = createPluginStub();
    const manager = new EmbeddingsManager(pluginStub.app as any, pluginStub as any);
    const scheduleSpy = jest.spyOn(manager as any, 'scheduleRepairsForPaths').mockImplementation(() => {});

    (manager as any).queueReprocessForPaths(['Legacy.md', 'Legacy.md']);

    expect(scheduleSpy).toHaveBeenCalledWith(['Legacy.md']);
  });
});
