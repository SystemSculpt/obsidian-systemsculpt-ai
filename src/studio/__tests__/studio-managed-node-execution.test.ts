import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerBuiltInStudioNodes } from "../StudioBuiltInNodes";
import { migrateStudioProjectToPathOnlyPorts } from "../StudioGraphMigrations";
import { StudioNodeRegistry } from "../StudioNodeRegistry";
import { imageGenerationNode } from "../nodes/imageGenerationNode";
import { textGenerationNode } from "../nodes/textGenerationNode";
import { transcriptionNode } from "../nodes/transcriptionNode";
import type { StudioProjectV1 } from "../types";

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
    readVaultBinary: jest.fn(),
    readLocalFileBinary: jest.fn(async () => new Uint8Array([1]).buffer),
    writeTempFile: jest.fn(),
    deleteLocalFile: jest.fn(),
    runCli: jest.fn(),
    assertFilesystemPath: jest.fn(),
  };
}

describe("managed-only Studio remote nodes", () => {
  it("registers exactly three remote executors and keeps retired HTTP hidden and inert", async () => {
    const registry = new StudioNodeRegistry();
    registerBuiltInStudioNodes(registry);
    expect(registry.list().filter(definition => definition.capabilityClass === "api").map(definition => definition.kind).sort()).toEqual([
      "studio.image_generation",
      "studio.text_generation",
      "studio.transcription",
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

  it("contains no Studio generic stream, provider, model, credit, or arbitrary network path", () => {
    const root = join(__dirname, "../..");
    const adapter = readFileSync(join(root, "studio/StudioApiExecutionAdapter.ts"), "utf8");
    const runtime = readFileSync(join(root, "studio/StudioRuntime.ts"), "utf8");
    const builtIns = readFileSync(join(root, "studio/StudioBuiltInNodes.ts"), "utf8");
    expect(`${adapter}\n${runtime}`).not.toMatch(/streamMessage|modelService|getCreditsBalance|requestUrl|\bfetch\b|estimateRunCredits/);
    expect(builtIns).not.toContain("httpRequestNode");
    for (const definition of [textGenerationNode, imageGenerationNode, transcriptionNode]) {
      expect(definition.cachePolicy).toBe("never");
    }
  });
});
