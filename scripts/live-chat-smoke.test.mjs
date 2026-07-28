import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bundleLiveChatSmoke,
  DEFAULT_LIVE_CHAT_SMOKE_ROOT,
  runLiveChatSmoke,
} from "./live-chat-smoke.mjs";

const scriptPath = fileURLToPath(new URL("./live-chat-smoke.mjs", import.meta.url));

test("bundles the real managed chat smoke entry with the installed esbuild API", (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-smoke-bundle-test-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const outFile = path.join(outDir, "live-chat-smoke.cjs");

  assert.equal(
    bundleLiveChatSmoke({ outFile }),
    outFile,
  );
  assert.equal(fs.statSync(outFile).isFile(), true);
  const bundle = fs.readFileSync(outFile, "utf8");
  assert.match(bundle, /https:\/\/systemsculpt\.com/);
  assert.match(bundle, /follow-up after save\/reload over legacy server-tool history/);
});

test("executes a built smoke with the current Node runtime and removes temporary bytes", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-smoke-run-test-"));
  let execution = null;

  const result = runLiveChatSmoke({
    args: [],
    makeTemporaryDirectoryImpl: () => outDir,
    buildImpl: ({ outfile }) => fs.writeFileSync(outfile, "module.exports = {};\n"),
    executeImpl: (command, args, options) => {
      execution = { command, args, options };
      assert.equal(fs.existsSync(args[0]), true);
    },
  });

  assert.deepEqual(result, { bundleOnly: false, executed: true });
  assert.equal(execution.command, process.execPath);
  assert.deepEqual(execution.args, [path.join(outDir, "live-chat-smoke.cjs")]);
  assert.equal(execution.options.cwd, DEFAULT_LIVE_CHAT_SMOKE_ROOT);
  assert.equal(execution.options.stdio, "inherit");
  assert.equal(fs.existsSync(outDir), false);
});

test("--bundle-only performs the real hermetic preflight without a key or network", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--bundle-only"], {
    cwd: DEFAULT_LIVE_CHAT_SMOKE_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      SYSTEMSCULPT_LICENSE_KEY: "",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[smoke\] Bundle preflight OK\./);
  assert.equal(result.stderr, "");
});
