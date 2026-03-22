import {
  buildNodeInputFingerprint,
  StudioNodeResultCacheStore,
} from "../StudioNodeResultCacheStore";
import type {
  StudioNodeCacheSnapshotV1,
  StudioNodeInstance,
} from "../types";

type InMemoryApp = {
  vault: {
    adapter: {
      exists: (path: string) => Promise<boolean>;
      mkdir: (path: string) => Promise<void>;
      write: (path: string, data: string) => Promise<void>;
      read: (path: string) => Promise<string>;
    };
  };
};

function createCacheStore() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || dirs.has(path)),
    mkdir: jest.fn(async (path: string) => {
      dirs.add(path);
    }),
    write: jest.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    read: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (typeof value === "undefined") {
        throw new Error(`File not found: ${path}`);
      }
      return value;
    }),
  };

  const app: InMemoryApp = {
    vault: {
      adapter,
    },
  };

  return {
    files,
    store: new StudioNodeResultCacheStore(app as any),
  };
}

function nodeFixture(config?: StudioNodeInstance["config"]): StudioNodeInstance {
  return {
    id: "node_1",
    kind: "studio.text_generation",
    version: "1.0.0",
    title: "Text Generation",
    position: { x: 0, y: 0 },
    config: config || { systemPrompt: "System instructions", modelId: "openai/gpt-5-mini" },
  };
}

describe("StudioNodeResultCacheStore", () => {
  it("produces deterministic input fingerprints independent of object key order", async () => {
    const node = nodeFixture({
      systemPrompt: "Use {{prompt}} and {{alpha}}",
      alpha: "A",
      beta: "B",
    });

    const fingerprintA = await buildNodeInputFingerprint(node, {
      data: {
        b: 2,
        a: 1,
      },
    });
    const fingerprintB = await buildNodeInputFingerprint(node, {
      data: {
        a: 1,
        b: 2,
      },
    });

    expect(fingerprintA).toBe(fingerprintB);

    const fingerprintC = await buildNodeInputFingerprint(nodeFixture({ systemPrompt: "Different" }), {
      data: {
        a: 1,
        b: 2,
      },
    });
    expect(fingerprintC).not.toBe(fingerprintA);
  });

  it("ignores unlocked text-generation snapshot value when building fingerprints", async () => {
    const inputs = {
      prompt: "Generate title options",
    };
    const baseConfig = {
      systemPrompt: "You are concise.",
      modelId: "openai/gpt-5-mini",
      sourceMode: "systemsculpt",
      textDisplayMode: "raw",
    };

    const fingerprintA = await buildNodeInputFingerprint(
      nodeFixture({
        ...baseConfig,
        value: "Old generated output",
      }),
      inputs
    );
    const fingerprintB = await buildNodeInputFingerprint(
      nodeFixture({
        ...baseConfig,
        value: "New generated output",
      }),
      inputs
    );

    expect(fingerprintA).toBe(fingerprintB);
  });

  it("includes locked text-generation value in fingerprints", async () => {
    const inputs = {
      prompt: "Generate title options",
    };
    const baseConfig = {
      systemPrompt: "You are concise.",
      modelId: "openai/gpt-5-mini",
      sourceMode: "systemsculpt",
      lockOutput: true,
    };

    const fingerprintA = await buildNodeInputFingerprint(
      nodeFixture({
        ...baseConfig,
        value: "Locked output A",
      }),
      inputs
    );
    const fingerprintB = await buildNodeInputFingerprint(
      nodeFixture({
        ...baseConfig,
        value: "Locked output B",
      }),
      inputs
    );

    expect(fingerprintA).not.toBe(fingerprintB);
  });

  it("ignores transcription display snapshots in fingerprinting", async () => {
    const transcriptionNode = (config: StudioNodeInstance["config"]): StudioNodeInstance => ({
      id: "node_tx",
      kind: "studio.transcription",
      version: "1.0.0",
      title: "Transcription",
      position: { x: 0, y: 0 },
      config,
    });

    const inputs = {
      path: "/mock/downloads/audio.wav",
    };
    const fingerprintA = await buildNodeInputFingerprint(
      transcriptionNode({
        textDisplayMode: "raw",
        value: "Transcript one",
      }),
      inputs
    );
    const fingerprintB = await buildNodeInputFingerprint(
      transcriptionNode({
        textDisplayMode: "rendered",
        value: "Transcript two",
      }),
      inputs
    );

    expect(fingerprintA).toBe(fingerprintB);
  });

  it("includes caption board labels in media-ingest fingerprints but ignores rendered asset snapshots", async () => {
    const mediaNode = (config: StudioNodeInstance["config"]): StudioNodeInstance => ({
      id: "node_media",
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: "Media",
      position: { x: 0, y: 0 },
      config,
    });

    const baseConfig = {
      sourcePath: "Assets/source.png",
      captionBoard: {
        version: 1,
        labels: [
          {
            id: "label-1",
            text: "Quarterly update",
            x: 0.16,
            y: 0.12,
            width: 0.52,
            height: 0.24,
            fontSize: 56,
            textAlign: "center",
            textColor: "#ffffff",
            styleVariant: "banner",
            zIndex: 0,
          },
        ],
        sourceAssetPath: "Assets/source.png",
        lastRenderedAsset: {
          hash: "hash-a",
          path: "Studio/assets/captioned-a.svg",
          mimeType: "image/svg+xml",
          sizeBytes: 256,
        },
        updatedAt: "2026-03-22T01:00:00.000Z",
      },
    };

    const fingerprintA = await buildNodeInputFingerprint(mediaNode(baseConfig), {});
    const fingerprintB = await buildNodeInputFingerprint(
      mediaNode({
        ...baseConfig,
        captionBoard: {
          ...baseConfig.captionBoard,
          lastRenderedAsset: {
            hash: "hash-b",
            path: "Studio/assets/captioned-b.svg",
            mimeType: "image/svg+xml",
            sizeBytes: 999,
          },
          updatedAt: "2026-03-22T02:00:00.000Z",
        },
      }),
      {}
    );
    const fingerprintC = await buildNodeInputFingerprint(
      mediaNode({
        ...baseConfig,
        captionBoard: {
          ...baseConfig.captionBoard,
          labels: [
            {
              ...baseConfig.captionBoard.labels[0],
              text: "New caption text",
            },
          ],
        },
      }),
      {}
    );

    expect(fingerprintA).toBe(fingerprintB);
    expect(fingerprintC).not.toBe(fingerprintA);
  });

  it("round-trips cache snapshots to the project cache file", async () => {
    const { store } = createCacheStore();
    const projectPath = "SystemSculpt/Studio/Cache Test.systemsculpt";
    const projectId = "proj_cache_test";

    const empty = await store.load(projectPath, projectId);
    expect(empty.projectId).toBe(projectId);
    expect(Object.keys(empty.entries)).toHaveLength(0);

    const snapshot: StudioNodeCacheSnapshotV1 = {
      schema: "studio.node-cache.v1",
      projectId,
      updatedAt: new Date().toISOString(),
      entries: {
        node_1: {
          nodeId: "node_1",
          nodeKind: "studio.transcription",
          nodeVersion: "1.0.0",
          inputFingerprint: "abc123",
          outputs: { text: "hello world" },
          updatedAt: new Date().toISOString(),
          runId: "run_1",
        },
      },
    };

    await store.save(projectPath, snapshot);
    const loaded = await store.load(projectPath, projectId);
    expect(loaded.projectId).toBe(projectId);
    expect(loaded.entries.node_1?.nodeKind).toBe("studio.transcription");
    expect(loaded.entries.node_1?.outputs.text).toBe("hello world");
  });
});
