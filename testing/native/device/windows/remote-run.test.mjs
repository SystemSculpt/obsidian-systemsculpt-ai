import test from "node:test";
import assert from "node:assert/strict";
import {
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
    sourceBase64: Buffer.from("console.log('ok');", "utf8").toString("base64"),
    args: ["--provider-id", "google"],
    cleanupPaths: ["C:/Users/Administrator/AppData/Local/Temp/secret.txt"],
  });

  assert.match(script, /\$scriptPath = Join-Path \$env:TEMP/);
  assert.match(script, /\$scriptArgs = @\('--provider-id', 'google'\)/);
  assert.match(script, /node \$scriptPath @scriptArgs/);
  assert.match(script, /\$exitCode = \$LASTEXITCODE/);
  assert.match(script, /Remove-Item \$scriptPath -Force/);
  assert.match(script, /secret\.txt/);
  assert.match(script, /exit \$exitCode/);
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
