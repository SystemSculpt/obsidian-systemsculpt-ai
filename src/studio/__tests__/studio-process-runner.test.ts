import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { desktopHost } from "../../platform/desktopOnly";
import { StudioSandboxRunner } from "../StudioSandboxRunner";
import { StudioPermissionManager } from "../StudioPermissionManager";
import { processNode } from "../nodes/processNode";
import type { StudioNodeExecutionContext } from "../types";

function permissions(patterns = [process.execPath]) {
  return new StudioPermissionManager({ schema: "studio.policy.v1", version: 1, updatedAt: "2026-09-05", grants: [
    { id: "fs", capability: "filesystem", scope: { allowedPaths: [os.tmpdir()] }, grantedAt: "2026-09-05", grantedByUser: true },
    { id: "cli", capability: "cli", scope: { allowedCommandPatterns: patterns }, grantedAt: "2026-09-05", grantedByUser: true },
  ] });
}

describe("process execution through the desktop sandbox seam", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "studio-process-test-"));
    jest.spyOn(desktopHost, "childProcess").mockResolvedValue(childProcess);
    jest.spyOn(desktopHost, "path").mockResolvedValue(path);
    jest.spyOn(desktopHost, "environment").mockReturnValue({ PATH: path.dirname(process.execPath) });
  });
  afterEach(async () => { jest.restoreAllMocks(); await fs.rm(scratch, { recursive: true, force: true }); });

  it("uses real manifest files and stdin with an isolated fake helper process", async () => {
    const helper = path.join(scratch, "helper.cjs");
    await fs.writeFile(helper, `const fs = require('node:fs');
let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => stdin += data);
process.stdin.on('end', () => {
 const file = JSON.parse(fs.readFileSync(process.env.STUDIO_INPUTS, 'utf8'));
 const input = JSON.parse(stdin);
 if (file.schema !== 'studio.process.inputs.v1' || JSON.stringify(input) !== JSON.stringify(file)) process.exit(9);
 console.log('::studio-progress 50 Processing');
 console.error('helper diagnostic');
 fs.writeFileSync(process.env.STUDIO_OUTPUTS, JSON.stringify({schema:'studio.process.outputs.v1',outputs:{answer:file.inputs.question + ' received'}}));
 console.log('::studio-progress 100 Complete');
});`);
    let index = 0;
    const sandbox = new StudioSandboxRunner(permissions());
    const context = {
      runId: "real-protocol", projectPath: "Studio/Protocol.systemsculpt",
      node: { id: "helper", kind: "studio.process", version: "1.0.0", title: "Protocol helper", position: { x: 0, y: 0 }, config: { ...processNode.configDefaults, executable: process.execPath, arguments: [helper], workingDirectory: scratch, manifestToStdin: true, inputs: [{ id: "question", type: "text", required: true }], outputs: [{ id: "answer", type: "text", required: true }] } },
      inputs: { question: "hello" }, signal: new AbortController().signal, log: jest.fn(), reportProgress: jest.fn(),
      services: {
        resolveAbsolutePath: (value: string) => value,
        writeTempFile: async (bytes: ArrayBuffer) => { const file = path.join(scratch, `manifest-${index++}.json`); await fs.writeFile(file, new Uint8Array(bytes)); return file; },
        readLocalFileBinary: async (file: string, maxBytes: number) => { const bytes = await fs.readFile(file); if (bytes.byteLength > maxBytes) throw new Error("too large"); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
        runCli: sandbox.runCli.bind(sandbox),
      },
    } as unknown as StudioNodeExecutionContext;
    const result = await processNode.execute(context);
    expect(result.outputs.answer).toBe("hello received");
    expect(result.outputs.exit_code).toBe(0);
    expect(result.outputs.stderr).toContain("helper diagnostic");
    expect(context.reportProgress).toHaveBeenLastCalledWith(100, "Complete");
  });

  it("requires an exact grant for process nodes while preserving old CLI wildcard grants", async () => {
    const manager = permissions([`*${path.sep}${path.basename(process.execPath)}`]);
    expect(() => manager.assertCliCommand(process.execPath)).not.toThrow();
    expect(() => manager.assertCliCommand(process.execPath, true)).toThrow("permission denied");
    const spawn = jest.spyOn(childProcess, "spawn");
    await expect(new StudioSandboxRunner(manager).runCli({ command: process.execPath, cwd: scratch, requireExactCommandGrant: true })).rejects.toThrow("permission denied");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("captures UTF-8 within byte limits and bounds streaming callbacks", async () => {
    const onStdout = jest.fn();
    const result = await new StudioSandboxRunner(permissions()).runCli({ command: process.execPath, args: ["-e", "process.stdout.write('€'.repeat(10000)); process.stderr.write('x'.repeat(10000))"], cwd: scratch, maxOutputBytes: 1024, onStdout });
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(1024);
    expect(result.stdout).not.toContain("�");
    expect(result.stderr.length).toBe(1024);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(onStdout.mock.calls.map(([chunk]) => chunk).join("")).toBe(result.stdout);
  });

  it("also bounds replacement characters from malformed UTF-8 output", async () => {
    const result = await new StudioSandboxRunner(permissions()).runCli({ command: process.execPath, args: ["-e", "process.stdout.write(Buffer.alloc(10000, 255))"], cwd: scratch, maxOutputBytes: 1024 });
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(1024);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("kills a running process when aborted and never spawns an already-aborted request", async () => {
    const controller = new AbortController();
    const runner = new StudioSandboxRunner(permissions());
    const result = await runner.runCli({ command: process.execPath, args: ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], cwd: scratch, signal: controller.signal, onStdout: () => controller.abort() });
    expect(result.cancelled).toBe(true);
    const spawn = jest.spyOn(childProcess, "spawn");
    await expect(runner.runCli({ command: process.execPath, cwd: scratch, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a timeout and enforces the filesystem grant before spawn", async () => {
    const runner = new StudioSandboxRunner(permissions());
    const result = await runner.runCli({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: scratch, timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    await expect(runner.runCli({ command: process.execPath, cwd: "/outside-grant" })).rejects.toThrow("Filesystem permission denied");
  });
});
