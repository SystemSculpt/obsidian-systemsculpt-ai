import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildWindowsNodeModuleWorkspace,
  buildRemoteWindowsNodeScript,
  mapLocalPathToParallelsRepoPath,
  parseRemoteRunArgs,
  runWindowsNodeModuleRemotely,
  startWindowsLocalPortForward,
  toPowerShellArrayLiteral,
} from "./remote-run.mjs";

test("toPowerShellArrayLiteral quotes each entry for PowerShell", () => {
  assert.equal(
    toPowerShellArrayLiteral(["alpha", "beta's"]),
    "@('alpha', 'beta''s')"
  );
});

test("buildRemoteWindowsNodeScript writes the task, captures exit code, and cleans up", () => {
  const script = buildRemoteWindowsNodeScript({
    entryRelativePath: "entry.mjs",
    workspaceFiles: [
      {
        relativePath: "entry.mjs",
        sourceBase64: Buffer.from("console.log('ok');", "utf8").toString("base64"),
      },
      {
        relativePath: "manifest.json",
        sourceBase64: Buffer.from('{"id":"systemsculpt-ai"}', "utf8").toString("base64"),
      },
    ],
    args: ["--provider-id", "google"],
    cleanupPaths: ["C:/Windows/Temp/secret.txt"],
  });

  assert.match(script, /\$workspacePath = Join-Path \$env:TEMP/);
  assert.match(script, /relativePath = 'entry\.mjs'/);
  assert.match(script, /relativePath = 'manifest\.json'/);
  assert.match(script, /\$scriptArgs = @\('--provider-id', 'google'\)/);
  assert.match(script, /Push-Location \$workspacePath/);
  assert.match(script, /& \$nodeCommand \$scriptPath @scriptArgs/);
  assert.match(script, /\$exitCode = if \(\$null -eq \$LASTEXITCODE\)/);
  assert.match(script, /Remove-Item \$workspacePath -Recurse -Force/);
  assert.match(script, /secret\.txt/);
  assert.match(script, /exit \$exitCode/);
});

test("buildWindowsNodeModuleWorkspace bundles sibling imports and ships plugin artifacts", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "windows-remote-run-"));
  const repoRoot = path.join(tempDir, "repo");
  const taskDir = path.join(repoRoot, "task");
  await fs.mkdir(taskDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(repoRoot, "manifest.json"), '{"id":"systemsculpt-ai","version":"5.3.0"}\n', "utf8"),
    fs.writeFile(path.join(repoRoot, "main.js"), "console.log('bundle ok');\n", "utf8"),
    fs.writeFile(path.join(repoRoot, "styles.css"), "body {}\n", "utf8"),
    fs.writeFile(path.join(taskDir, "shared.mjs"), "export const VALUE = 'bundled-import';\n", "utf8"),
    fs.writeFile(
      path.join(taskDir, "entry.mjs"),
      "import { VALUE } from './shared.mjs';\nconsole.log(VALUE);\n",
      "utf8"
    ),
  ]);
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const workspace = await buildWindowsNodeModuleWorkspace(path.join(taskDir, "entry.mjs"), {
    artifactRoot: repoRoot,
  });

  const entryFile = workspace.workspaceFiles.find((file) => file.relativePath === "entry.mjs");
  assert.equal(workspace.entryRelativePath, "entry.mjs");
  assert.ok(entryFile);
  assert.match(Buffer.from(entryFile.sourceBase64, "base64").toString("utf8"), /bundled-import/);
  assert.deepEqual(
    workspace.workspaceFiles
      .map((file) => file.relativePath)
      .sort(),
    ["entry.mjs", "main.js", "manifest.json", "styles.css"]
  );
});

test("mapLocalPathToParallelsRepoPath keeps repo-relative structure", () => {
  const repoRoot = path.join("/tmp", "obsidian-systemsculpt-ai");
  const mapped = mapLocalPathToParallelsRepoPath(path.join(repoRoot, "testing/native/device/windows/bootstrap.mjs"), {
    localRepoRoot: repoRoot,
    parallelsRepoRoot: "X:/repos/obsidian-systemsculpt-ai",
  });

  assert.equal(mapped, "X:/repos/obsidian-systemsculpt-ai/testing/native/device/windows/bootstrap.mjs");
});

test("parseRemoteRunArgs keeps transport config and task args after --", () => {
  const parsed = parseRemoteRunArgs([
    "--entry",
    "./testing/native/device/windows/clean-install-parity.mjs",
    "--transport",
    "parallels",
    "--vm-name",
    "Windows 11",
    "--host",
    "custom-host",
    "--",
    "--provider-id",
    "google",
  ]);

  assert.equal(parsed.transport, "parallels");
  assert.equal(parsed.vmName, "Windows 11");
  assert.equal(parsed.sshHost, "custom-host");
  assert.ok(parsed.entryPath.endsWith("/testing/native/device/windows/clean-install-parity.mjs"));
  assert.deepEqual(parsed.taskArgs, ["--provider-id", "google"]);
});

test("runWindowsNodeModuleRemotely forwards task args for Parallels runs", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "windows-remote-run-"));
  const repoRoot = path.join(tempDir, "repo");
  const entryPath = path.join(repoRoot, "testing", "native", "device", "windows", "bootstrap.mjs");
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.writeFile(entryPath, "console.log(process.argv.slice(2));\n", "utf8");
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  let capturedScript = "";
  const result = await runWindowsNodeModuleRemotely(
    entryPath,
    {
      transport: "parallels",
      artifactRoot: repoRoot,
      localRepoRoot: repoRoot,
      parallelsRepoRoot: "X:/repos/obsidian-systemsculpt-ai",
      args: ["--launch", "--timeout-ms", "123456"],
    },
    {
      runRemotePowerShellScriptImpl: async (script) => {
        capturedScript = script;
        return "ok";
      },
    }
  );

  assert.equal(result, "ok");
  assert.match(capturedScript, /\$scriptArgs = @\('--launch', '--timeout-ms', '123456'\)/);
  assert.match(capturedScript, /& \$nodeCommand \$scriptPath @scriptArgs/);
});

test("startWindowsLocalPortForward preserves remote port for Parallels runs", async () => {
  let capturedOptions = null;
  const result = await startWindowsLocalPortForward(
    {
      transport: "parallels",
      vmName: "Windows 11",
      remoteHost: "127.0.0.1",
      remotePort: 27124,
    },
    {
      startParallelsLocalPortForwardImpl: async (options) => {
        capturedOptions = options;
        return { ok: true };
      },
    }
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(capturedOptions?.transport, "parallels");
  assert.equal(capturedOptions?.vmName, "Windows 11");
  assert.equal(capturedOptions?.remoteHost, "127.0.0.1");
  assert.equal(capturedOptions?.remotePort, 27124);
});
