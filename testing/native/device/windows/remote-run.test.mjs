import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildWindowsNodeModuleWorkspace,
  buildRemoteWindowsNodeScript,
  parseRemoteRunArgs,
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
    cleanupPaths: ["C:/Users/Administrator/AppData/Local/Temp/secret.txt"],
  });

  assert.match(script, /\$workspacePath = Join-Path \$env:TEMP/);
  assert.match(script, /relativePath = 'entry\.mjs'/);
  assert.match(script, /relativePath = 'manifest\.json'/);
  assert.match(script, /\$scriptArgs = @\('--provider-id', 'google'\)/);
  assert.match(script, /Push-Location \$workspacePath/);
  assert.match(script, /node \$scriptPath @scriptArgs/);
  assert.match(script, /\$exitCode = \$LASTEXITCODE/);
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

test("parseRemoteRunArgs keeps task args after --", () => {
  const parsed = parseRemoteRunArgs([
    "--entry",
    "./testing/native/device/windows/clean-install-parity.mjs",
    "--host",
    "custom-host",
    "--",
    "--provider-id",
    "google",
  ]);

  assert.equal(parsed.sshHost, "custom-host");
  assert.ok(parsed.entryPath.endsWith("/testing/native/device/windows/clean-install-parity.mjs"));
  assert.deepEqual(parsed.taskArgs, ["--provider-id", "google"]);
});
