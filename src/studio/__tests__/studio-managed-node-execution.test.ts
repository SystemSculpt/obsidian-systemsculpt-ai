import { registerBuiltInStudioNodes } from "../StudioBuiltInNodes";
import { migrateStudioProjectToPathOnlyPorts } from "../StudioGraphMigrations";
import { StudioNodeRegistry } from "../StudioNodeRegistry";
import { imageGenerationNode } from "../nodes/imageGenerationNode";
import { textGenerationNode } from "../nodes/textGenerationNode";
import { transcriptionNode } from "../nodes/transcriptionNode";
import { DESKTOP_TRANSCRIPTION_MAX_FILE_SIZE } from "../../services/transcription/TranscriptionCoordinator";
import type { StudioProjectV1, StudioTranscriptionRequest } from "../types";
import { createHash } from "crypto";

function fileSource(bytes = new Uint8Array([1]).buffer) {
  return {
    sizeBytes: bytes.byteLength,
    readSlice: jest.fn(async (start: number, end: number) => bytes.slice(start, end)),
    release: jest.fn(),
  };
}

function projectWithHttpSecret(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "project-http",
    name: "Legacy HTTP",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "1.0.0" },
    graph: {
      nodes: [{
        id: "http-1",
        kind: "studio.http_request",
        version: "1.0.0",
        title: "Send secret",
        position: { x: 0, y: 0 },
        config: { url: "https://example.com", bearerToken: "sentinel-secret", headers: { authorization: "sentinel-header" } },
      }],
      edges: [],
      entryNodeIds: ["http-1"],
      groups: [],
    },
    permissionsRef: { policyVersion: 1, policyPath: "Studio/Legacy.systemsculpt-assets/policy/grants.json" },
    settings: { runConcurrency: "adaptive", defaultFsScope: "vault", retention: { maxRuns: 10, maxArtifactsMb: 10 } },
    migrations: { projectSchemaVersion: "1.0.0", applied: [{ id: "studio.text-node-kinds.v1", at: "2026-07-12T00:00:00.000Z" }] },
  };
}

function services(api: Record<string, unknown>) {
  return {
    api,
    storeAsset: jest.fn(),
    readAsset: jest.fn(),
    resolveAbsolutePath: (path: string) => `/vault/${path}`,
    readVaultText: jest.fn(),
    statVaultFileSize: jest.fn(async () => 1),
    openVaultFileSource: jest.fn(async () => fileSource()),
    readVaultBinary: jest.fn(async () => new Uint8Array([1]).buffer),
    statLocalFileSize: jest.fn(async () => 1),
    openLocalFileSource: jest.fn(async () => fileSource()),
    readLocalFileBinary: jest.fn(async () => new Uint8Array([1]).buffer),
    writeTempFile: jest.fn(),
    deleteLocalFile: jest.fn(),
    runCli: jest.fn(),
    assertFilesystemPath: jest.fn(),
  };
}

describe("managed-only Studio remote nodes", () => {
  it("registers exactly four remote executors and keeps retired HTTP hidden and inert", async () => {
    const registry = new StudioNodeRegistry();
    registerBuiltInStudioNodes(registry);
    expect(registry.list().filter(definition => definition.capabilityClass === "api").map(definition => definition.kind).sort()).toEqual([
      "studio.image_generation",
      "studio.text_generation",
      "studio.transcription",
      "studio.video_generation",
    ]);
    expect(registry.get("studio.http_request", "1.0.0")).toBeNull();
    const retired = registry.get("studio.retired_http_request", "1.0.0");
    expect(retired?.hiddenFromInsertMenu).toBe(true);
    await expect(retired?.execute({} as never)).rejects.toThrow("retired");
  });

  it("sanitizes old HTTP nodes into a secret-free unsupported placeholder", () => {
    const migrated = migrateStudioProjectToPathOnlyPorts(projectWithHttpSecret());
    expect(migrated.changed).toBe(true);
    expect(migrated.project.graph.nodes[0]).toMatchObject({
      kind: "studio.retired_http_request",
      config: { reason: expect.stringContaining("retired") },
    });
    expect(JSON.stringify(migrated.project)).not.toMatch(/sentinel-secret|sentinel-header|example\.com/);
  });

  it("keeps prompt and media work lazy until each managed adapter accepts the operation", async () => {
    let textReads = 0;
    const textInputs = {} as Record<string, unknown>;
    Object.defineProperty(textInputs, "prompt", { get: () => { textReads += 1; return "Summarize"; } });
    const generateText = jest.fn(async request => {
      expect(textReads).toBe(0);
      const payload = await request.buildPayload();
      return { text: payload.prompt, operation: { capability: "text_generation", operationId: "text-op" } };
    });
    await textGenerationNode.execute({
      runId: "run", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
      node: { id: "text", kind: textGenerationNode.kind, version: textGenerationNode.version, title: "Text", position: { x: 0, y: 0 }, config: {} },
      inputs: textInputs as never, services: services({ generateText }) as never, log: jest.fn(),
    });
    expect(textReads).toBeGreaterThan(0);

    let imageReads = 0;
    const imageInputs = {} as Record<string, unknown>;
    Object.defineProperty(imageInputs, "prompt", { get: () => { imageReads += 1; return "Draw"; } });
    const generateImage = jest.fn(async request => {
      expect(imageReads).toBe(0);
      const payload = await request.buildPayload();
      expect(payload).toEqual({
        prompt: "Draw",
        count: 1,
        aspectRatio: "1:1",
        inputImages: [],
      });
      return { images: [], operation: { capability: "image_generation", operationId: "image-op" }, payload };
    });
    await imageGenerationNode.execute({
      runId: "run", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
      node: { id: "image", kind: imageGenerationNode.kind, version: imageGenerationNode.version, title: "Image", position: { x: 0, y: 0 }, config: { count: 1, aspectRatio: "1:1" } },
      inputs: imageInputs as never, services: services({ generateImage }) as never, log: jest.fn(),
    });
    expect(imageReads).toBeGreaterThan(0);

    let pathReads = 0;
    const transcriptionInputs = {} as Record<string, unknown>;
    Object.defineProperty(transcriptionInputs, "path", { get: () => { pathReads += 1; return "audio.wav"; } });
    const transcribeAudio = jest.fn(async request => {
      expect(pathReads).toBe(0);
      await request.source.fingerprint();
      await request.source.load();
      return { text: "done", operation: { capability: "transcription", operationId: "transcription-op" } };
    });
    await transcriptionNode.execute({
      runId: "run", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
      node: { id: "transcription", kind: transcriptionNode.kind, version: transcriptionNode.version, title: "Transcription", position: { x: 0, y: 0 }, config: {} },
      inputs: transcriptionInputs as never, services: services({ transcribeAudio }) as never, log: jest.fn(),
    });
    expect(pathReads).toBeGreaterThan(0);
  });

  it.each(["audio.wav", "/mock/audio.wav"])("opens %s lazily and memoizes bounded hashing without a full-file read", async (sourcePath) => {
    const bytesByRun = [
      new Uint8Array(2 * 1024 * 1024 + 3).fill(1).buffer,
      new Uint8Array(2 * 1024 * 1024 + 3).fill(2).buffer,
    ];
    const sources = bytesByRun.map(bytes => fileSource(bytes));
    const events: string[] = [];
    const fingerprints: string[] = [];
    const identities: string[] = [];
    let runIndex = 0;
    const statFileSize = jest.fn(async () => {
      events.push(`size:${runIndex}`);
      return bytesByRun[runIndex].byteLength;
    });
    const openFileSource = jest.fn(async () => {
      events.push(`open:${runIndex}`);
      return sources[runIndex];
    });
    const transcribeAudio = jest.fn(async (request: StudioTranscriptionRequest) => {
      events.push(`admission:${runIndex}`);
      const openedBefore = openFileSource.mock.calls.length;
      identities.push(request.source.identity);
      expect(openFileSource).toHaveBeenCalledTimes(openedBefore);
      const loaded = await request.source.load();
      expect(loaded).toMatchObject({ filename: "audio.wav", contentType: "audio/wav", sizeBytes: bytesByRun[runIndex].byteLength });
      expect(loaded).not.toHaveProperty("bytes");
      expect(sources[runIndex].readSlice).not.toHaveBeenCalled();
      const fingerprint = await request.source.fingerprint();
      expect(fingerprint).toBe(`sha256:${createHash("sha256").update(new Uint8Array(bytesByRun[runIndex])).digest("hex")}`);
      expect(sources[runIndex].readSlice.mock.calls).toEqual([
        [0, 1024 * 1024],
        [1024 * 1024, 2 * 1024 * 1024],
        [2 * 1024 * 1024, bytesByRun[runIndex].byteLength],
      ]);
      expect(await request.source.fingerprint()).toBe(fingerprint);
      expect(sources[runIndex].readSlice).toHaveBeenCalledTimes(3);
      expect(await request.source.load()).toMatchObject({ filename: loaded.filename, contentType: loaded.contentType, sizeBytes: loaded.sizeBytes });
      expect(sources[runIndex].readSlice).toHaveBeenCalledTimes(3);
      expect(openFileSource).toHaveBeenCalledTimes(openedBefore + 1);
      expect(new Uint8Array(await loaded.readSlice(1, 3))).toEqual(new Uint8Array(bytesByRun[runIndex].slice(1, 3)));
      request.source.release?.();
      await Promise.resolve();
      expect(sources[runIndex].release).toHaveBeenCalledTimes(1);
      fingerprints.push(fingerprint);
      runIndex += 1;
      return {
        text: "done",
        operation: { capability: "transcription", operationId: `transcription-op-${runIndex}` },
      };
    });

    const execute = async () => {
      const nodeServices = services({ transcribeAudio });
      if (sourcePath.startsWith("/")) {
        nodeServices.statLocalFileSize = statFileSize;
        nodeServices.openLocalFileSource = openFileSource;
      } else {
        nodeServices.statVaultFileSize = statFileSize;
        nodeServices.openVaultFileSource = openFileSource;
      }
      const result = await transcriptionNode.execute({
        runId: `run-${runIndex}`,
        projectPath: "Studio/Test.systemsculpt",
        signal: new AbortController().signal,
        node: { id: "transcription", kind: transcriptionNode.kind, version: transcriptionNode.version, title: "Transcription", position: { x: 0, y: 0 }, config: {} },
        inputs: { path: sourcePath },
        services: nodeServices as never,
        log: jest.fn(),
      });
      expect(result).toEqual({ outputs: { text: "done" }, managedOperations: [{ capability: "transcription", operationId: `transcription-op-${runIndex}` }] });
      expect(nodeServices.readVaultBinary).not.toHaveBeenCalled();
      expect(nodeServices.readLocalFileBinary).not.toHaveBeenCalled();
    };

    await execute();
    await execute();

    expect(events).toEqual(["admission:0", "size:0", "open:0", "admission:1", "size:1", "open:1"]);
    expect(fingerprints[1]).not.toBe(fingerprints[0]);
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const expectedIdentity = `transcription:${hash(JSON.stringify({
      schema: "transcription-source-v1",
      callerScope: "studio/transcription-node",
      projectHash: hash("Studio/Test.systemsculpt"),
      nodeId: "transcription",
      logicalSourceHash: hash(sourcePath),
    }))}`;
    expect(identities).toEqual([expectedIdentity, expectedIdentity]);
    expect(statFileSize).toHaveBeenCalledTimes(2);
    expect(statFileSize).toHaveBeenCalledWith(sourcePath);
    expect(openFileSource).toHaveBeenCalledTimes(2);
    expect(openFileSource).toHaveBeenCalledWith(sourcePath);
  });

  it("rejects oversized vault audio before allocating bytes", async () => {
    const readVaultBinary = jest.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    const transcribeAudio = jest.fn(async request => {
      await request.source.fingerprint();
      return {
        text: "done",
        operation: { capability: "transcription", operationId: "transcription-op" },
      };
    });
    const nodeServices = services({ transcribeAudio });
    nodeServices.statVaultFileSize = jest.fn(async () => DESKTOP_TRANSCRIPTION_MAX_FILE_SIZE + 1);
    nodeServices.readVaultBinary = readVaultBinary;

    await expect(transcriptionNode.execute({
      runId: "run-oversize-vault",
      projectPath: "Studio/Test.systemsculpt",
      signal: new AbortController().signal,
      node: { id: "transcription", kind: transcriptionNode.kind, version: transcriptionNode.version, title: "Transcription", position: { x: 0, y: 0 }, config: {} },
      inputs: { path: "audio.wav" },
      services: nodeServices as never,
      log: jest.fn(),
    })).rejects.toThrow("Audio file is too large");

    expect(nodeServices.statVaultFileSize).toHaveBeenCalledWith("audio.wav");
    expect(nodeServices.openVaultFileSource).not.toHaveBeenCalled();
    expect(readVaultBinary).not.toHaveBeenCalled();
  });

  it("rejects oversized absolute local audio before allocating bytes", async () => {
    const readLocalFileBinary = jest.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    const transcribeAudio = jest.fn(async request => {
      await request.source.load();
      return {
        text: "done",
        operation: { capability: "transcription", operationId: "transcription-op" },
      };
    });
    const nodeServices = services({ transcribeAudio });
    nodeServices.statLocalFileSize = jest.fn(async () => DESKTOP_TRANSCRIPTION_MAX_FILE_SIZE + 1);
    nodeServices.readLocalFileBinary = readLocalFileBinary;

    await expect(transcriptionNode.execute({
      runId: "run-oversize-local",
      projectPath: "Studio/Test.systemsculpt",
      signal: new AbortController().signal,
      node: { id: "transcription", kind: transcriptionNode.kind, version: transcriptionNode.version, title: "Transcription", position: { x: 0, y: 0 }, config: {} },
      inputs: { path: "/mock/audio.wav" },
      services: nodeServices as never,
      log: jest.fn(),
    })).rejects.toThrow("Audio file is too large");

    expect(nodeServices.statLocalFileSize).toHaveBeenCalledWith("/mock/audio.wav");
    expect(nodeServices.openLocalFileSource).not.toHaveBeenCalled();
    expect(readLocalFileBinary).not.toHaveBeenCalled();
  });

  it.each([
    ["", 1, "requires a path input"],
    ["notes.md", 1, "only accepts audio paths"],
    ["audio.wav", 0, "Audio file is empty"],
    ["audio.wav", -1, "Audio file is empty"],
    ["audio.wav", NaN, "Audio file is empty"],
    ["audio.wav", Infinity, "Audio file is empty"],
  ])("rejects invalid source %s with size %s before opening", async (path, size, message) => {
    const nodeServices = services({ transcribeAudio: async (request: StudioTranscriptionRequest) => request.source.load() });
    nodeServices.statVaultFileSize.mockResolvedValue(size);
    await expect(transcriptionNode.execute({
      runId: "invalid", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
      node: { id: "transcription", kind: transcriptionNode.kind, version: transcriptionNode.version, title: "Transcription", position: { x: 0, y: 0 }, config: {} },
      inputs: { path }, services: nodeServices as never, log: jest.fn(),
    })).rejects.toThrow(message);
    expect(nodeServices.openVaultFileSource).not.toHaveBeenCalled();
    expect(nodeServices.openLocalFileSource).not.toHaveBeenCalled();
    expect(nodeServices.readVaultBinary).not.toHaveBeenCalled();
    expect(nodeServices.readLocalFileBinary).not.toHaveBeenCalled();
  });

  it("releases an audio source that changed size after validation without reading it", async () => {
    const content = fileSource(new Uint8Array([1, 2]).buffer);
    const nodeServices = services({ transcribeAudio: async (request: StudioTranscriptionRequest) => request.source.fingerprint() });
    nodeServices.openVaultFileSource.mockResolvedValue(content);
    await expect(transcriptionNode.execute({
      runId: "changed", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
      node: { id: "transcription", kind: transcriptionNode.kind, version: transcriptionNode.version, title: "Transcription", position: { x: 0, y: 0 }, config: {} },
      inputs: { path: "audio.wav" }, services: nodeServices as never, log: jest.fn(),
    })).rejects.toThrow("changed while it was being opened");
    expect(content.readSlice).not.toHaveBeenCalled();
    expect(content.release).toHaveBeenCalledTimes(1);
  });

  it("does not touch a denied operation's source, even when the adapter releases it", async () => {
    const path = jest.fn(() => "audio.wav");
    const inputs = Object.defineProperty({}, "path", { get: path });
    const nodeServices = services({ transcribeAudio: async (request: StudioTranscriptionRequest) => {
      request.source.release?.();
      throw new Error("Admission denied");
    } });
    await expect(transcriptionNode.execute({
      runId: "denied", projectPath: "Studio/Test.systemsculpt", signal: new AbortController().signal,
      node: { id: "transcription", kind: transcriptionNode.kind, version: transcriptionNode.version, title: "Transcription", position: { x: 0, y: 0 }, config: {} },
      inputs, services: nodeServices as never, log: jest.fn(),
    })).rejects.toThrow("Admission denied");
    expect(path).not.toHaveBeenCalled();
    expect(nodeServices.statVaultFileSize).not.toHaveBeenCalled();
    expect(nodeServices.statLocalFileSize).not.toHaveBeenCalled();
    expect(nodeServices.openVaultFileSource).not.toHaveBeenCalled();
    expect(nodeServices.openLocalFileSource).not.toHaveBeenCalled();
  });

  it("never caches managed node outputs", () => {
    for (const definition of [textGenerationNode, imageGenerationNode, transcriptionNode]) {
      expect(definition.cachePolicy).toBe("never");
    }
  });
});
