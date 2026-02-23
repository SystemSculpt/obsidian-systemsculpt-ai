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
    kind: "studio.prompt_template",
    version: "1.0.0",
    title: "Prompt",
    position: { x: 0, y: 0 },
    config: config || { template: "{{text}}" },
  };
}

describe("StudioNodeResultCacheStore", () => {
  it("produces deterministic input fingerprints independent of object key order", async () => {
    const node = nodeFixture({
      template: "{{text}}",
      variables: {
        alpha: "A",
        beta: "B",
      },
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

    const fingerprintC = await buildNodeInputFingerprint(nodeFixture({ template: "Different" }), {
      data: {
        a: 1,
        b: 2,
      },
    });
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
