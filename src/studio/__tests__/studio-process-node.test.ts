import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processNode } from "../nodes/processNode";
import { StudioGraphCompiler } from "../StudioGraphCompiler";
import { registerBuiltInStudioNodes } from "../StudioBuiltInNodes";
import { StudioNodeRegistry } from "../StudioNodeRegistry";
import { parseStudioProject, serializeStudioProject } from "../schema";
import { validateNodeConfig } from "../StudioNodeConfigValidation";
import type { StudioCliExecutionRequest, StudioJsonValue, StudioNodeExecutionContext, StudioNodeOutputMap } from "../types";

const projectText = readFileSync(join(__dirname, "fixtures/process-protocol.systemsculpt"), "utf8");
const projectPath = "SystemSculpt/Studio/Process Protocol Example.systemsculpt";
const registry = new StudioNodeRegistry();
registerBuiltInStudioNodes(registry);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;

function harness(config: Record<string, StudioJsonValue> = {}) {
  const files = new Map<string, ArrayBuffer>();
  const controller = new AbortController();
  const execute = jest.fn(async (request: StudioCliExecutionRequest) => {
    files.set(request.env!.STUDIO_OUTPUTS, encode({ schema: "studio.process.outputs.v1", outputs: {} }));
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  });
  const context: StudioNodeExecutionContext = {
    runId: "run_protocol", projectPath,
    node: { id: "process", kind: "studio.process", version: "1.0.0", title: "Process", position: { x: 0, y: 0 }, config: { ...processNode.configDefaults, executable: "/bin/helper", workingDirectory: "/vault", ...config } },
    inputs: {}, signal: controller.signal, log: jest.fn(), reportProgress: jest.fn(),
    services: {
      api: { generateText: jest.fn(), generateImage: jest.fn(), transcribeAudio: jest.fn(), beginLocalCommit: jest.fn(), completeLocalCommit: jest.fn() },
      storeAsset: jest.fn(async (bytes, mimeType) => ({ path: "assets/staged", hash: "hash", sizeBytes: bytes.byteLength, mimeType })),
      readAsset: jest.fn(), resolveAbsolutePath: (path) => path.startsWith("/") ? path : `/vault/${path}`,
      readVaultText: jest.fn(), statVaultFileSize: jest.fn(), readVaultBinary: jest.fn(), statLocalFileSize: jest.fn(),
      readLocalFileBinary: jest.fn(async (path, limit) => { const bytes = files.get(path)!; if (!bytes) throw new Error("Missing file"); if (limit && bytes.byteLength > limit) throw new Error("File exceeds limit"); return bytes; }),
      writeTempFile: jest.fn(async (bytes, options) => { const path = `/tmp/studio/${options?.prefix}-${files.size}.json`; files.set(path, bytes); return path; }),
      deleteLocalFile: jest.fn(), runCli: execute, assertFilesystemPath: jest.fn(),
    },
  };
  return { context, files, execute, controller };
}

function output(h: ReturnType<typeof harness>, request: StudioCliExecutionRequest, outputs: unknown) {
  h.files.set(request.env!.STUDIO_OUTPUTS, encode({ schema: "studio.process.outputs.v1", outputs }));
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
}

describe("typed process nodes", () => {
  it("compiles a saved v2 process project and preserves its typed edges on save", () => {
    const project = parseStudioProject(projectText, { projectPath, registry });
    const compiled = new StudioGraphCompiler().compile(project, registry);
    expect(compiled.executionOrder).toEqual(["capture", "render", "publish"]);
    expect(compiled.nodesById.get("capture")!.definition.outputPorts).toContainEqual(expect.objectContaining({ id: "snapshot", type: "json", required: true }));
    expect(compiled.nodesById.get("publish")!.definition.inputPorts.map((port) => port.id)).toEqual(["report", "expected_sha"]);
    const restored = parseStudioProject(serializeStudioProject(project), { projectPath, registry });
    expect(new StudioGraphCompiler().compile(restored, registry).executionOrder).toEqual(compiled.executionOrder);
    expect(restored.graph.edges).toEqual(project.graph.edges);
    expect(processNode.cachePolicy).toBe("never");
  });

  it("executes capture → render → publish with actual v1 manifests, typed connections, and no managed API", async () => {
    const compiled = new StudioGraphCompiler().compile(parseStudioProject(projectText, { projectPath, registry }), registry);
    const h = harness();
    const observed: string[] = [];
    h.execute.mockImplementation(async (request) => {
      expect(request.requireExactCommandGrant).toBe(true);
      expect(request.signal).toBe(h.controller.signal);
      const input = JSON.parse(new TextDecoder().decode(h.files.get(request.env!.STUDIO_INPUTS)!));
      expect(input.schema).toBe("studio.process.inputs.v1");
      expect(input.nodeId).toBe(request.env!.STUDIO_NODE_ID);
      expect(request.args![1]).toBe(input.nodeId);
      observed.push(input.nodeId);
      request.onStdout?.("::studio-progress 10 Reading\n");
      request.onStdout?.("::studio-progress 100 Complete\n");
      if (input.nodeId === "capture") return output(h, request, { snapshot: { tasks: 3, expected_sha: "before" } });
      if (input.nodeId === "render") {
        expect(input.inputs.snapshot).toEqual({ tasks: 3, expected_sha: "before" });
        return output(h, request, { report: "# Runtime Status\n3 tasks", expected_sha: "before" });
      }
      expect(input.inputs).toEqual({ report: "# Runtime Status\n3 tasks", expected_sha: "before" });
      return output(h, request, { publication: { status: "updated" } });
    });
    const outputs = new Map<string, StudioNodeOutputMap>();
    for (const id of compiled.executionOrder) {
      const entry = compiled.nodesById.get(id)!;
      const inputs = Object.fromEntries(entry.inboundEdges.map((edge) => [edge.toPortId, outputs.get(edge.fromNodeId)![edge.fromPortId]]));
      outputs.set(id, (await entry.definition.execute({ ...h.context, node: entry.node, inputs })).outputs);
    }
    expect(observed).toEqual(["capture", "render", "publish"]);
    expect(outputs.get("publish")!.publication).toEqual({ status: "updated" });
    expect(h.context.reportProgress).toHaveBeenCalledWith(100, "Complete");
    expect(h.context.services.api.generateText).not.toHaveBeenCalled();
  });

  it("expands exact arrays into separate arguments and can deliver the same manifest over stdin", async () => {
    const h = harness({ inputs: [{ id: "items", type: "json", required: true }], arguments: ["{{input.items}}", "prefix={{inputs}}", "{{outputs}}", "{{run_dir}}"], manifestToStdin: true });
    h.context.inputs = { items: ["one space", "$(literal)", 2] };
    await processNode.execute(h.context);
    const request = h.execute.mock.calls[0][0];
    expect(request.args!.slice(0, 3)).toEqual(["one space", "$(literal)", "2"]);
    expect(JSON.parse(request.input!).inputs.items).toEqual(h.context.inputs.items);
    expect(request.args![3]).toBe(`prefix=${request.env!.STUDIO_INPUTS}`);
  });

  it.each([
    { outputs: [{ id: "stdout", type: "text" }] },
    { inputs: [{ id: "x", type: "json" }, { id: "x", type: "text" }] },
    { outputs: [{ id: "x", type: "unknown" }] },
    { inputs: Array.from({ length: 33 }, (_, i) => ({ id: `p${i}`, type: "json" })) },
  ])("rejects invalid dynamic ports before spawning: %j", async (config) => {
    const h = harness(config);
    expect(validateNodeConfig(processNode, h.context.node.config).isValid).toBe(false);
    await expect(processNode.execute(h.context)).rejects.toThrow();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["missing required output", {}, /required/],
    ["wrong output type", { answer: 4 }, /must have type text/],
  ])("rejects %s", async (_label, outputs, expected) => {
    const h = harness({ outputs: [{ id: "answer", type: "text", required: true }] });
    h.execute.mockImplementation(async (request) => output(h, request, outputs));
    await expect(processNode.execute(h.context)).rejects.toThrow(expected as RegExp);
  });

  it("rejects oversized input and output manifests", async () => {
    const h = harness({ inputs: [{ id: "data", type: "text" }] });
    h.context.inputs.data = "x".repeat(1024 * 1024);
    await expect(processNode.execute(h.context)).rejects.toThrow("1 MB manifest limit");
    expect(h.execute).not.toHaveBeenCalled();
    h.context.inputs = {};
    h.execute.mockImplementation(async (request) => output(h, request, { extra: "x".repeat(1024 * 1024) }));
    await expect(processNode.execute(h.context)).rejects.toThrow("exceeds limit");
  });

  it("rejects reserved environment names, incompatible schema, failures, and cancellation", async () => {
    const h = harness({ environment: { STUDIO_OUTPUTS: "override" } });
    await expect(processNode.execute(h.context)).rejects.toThrow("reserved");
    h.context.node.config.environment = {};
    h.execute.mockImplementation(async (request) => { h.files.set(request.env!.STUDIO_OUTPUTS, encode({ schema: "unexpected", outputs: {} })); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; });
    await expect(processNode.execute(h.context)).rejects.toThrow("Unsupported process output schema");
    h.execute.mockResolvedValue({ exitCode: 3, stdout: "", stderr: "failure detail", timedOut: false });
    await expect(processNode.execute(h.context)).rejects.toThrow("failure detail");
    h.execute.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
    await expect(processNode.execute(h.context)).rejects.toThrow("timed out");
    h.controller.abort();
    await expect(processNode.execute(h.context)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not mistake inherited object properties for a required output", async () => {
    const h = harness({ outputs: [{ id: "constructor", type: "json", required: true }] });
    await expect(processNode.execute(h.context)).rejects.toThrow('Process output "constructor" is required');
  });

  it("stages file outputs with a total byte budget", async () => {
    const h = harness({ maxArtifactMb: 1, outputs: [{ id: "file", type: "binary_ref", required: true }] });
    h.files.set("/vault/export.bin", new Uint8Array([1, 2, 3]).buffer);
    h.execute.mockImplementation(async (request) => output(h, request, { file: "export.bin" }));
    const result = await processNode.execute(h.context);
    expect(h.context.services.readLocalFileBinary).toHaveBeenCalledWith("/vault/export.bin", 1024 * 1024);
    expect(result.artifacts![0].sizeBytes).toBe(3);
    h.files.set("/vault/export.bin", new ArrayBuffer(1024 * 1024 + 1));
    await expect(processNode.execute(h.context)).rejects.toThrow("exceeds limit");
  });
});
