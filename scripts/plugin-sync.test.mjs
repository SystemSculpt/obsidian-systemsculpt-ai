import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  countConfiguredTargets,
  createDevelopmentBuildIdentity,
  createBuildSyncController,
  DEVELOPMENT_BUILD_MANIFEST_KEY,
  formatSyncTarget,
  loadConfiguredTargets,
  reloadConfiguredTargets,
  syncConfiguredTargets,
} from "./plugin-sync.mjs";

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-plugin-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePluginArtifacts(root) {
  fs.writeFileSync(path.join(root, "manifest.json"), '{"id":"systemsculpt-ai","version":"5.3.0"}\n');
  fs.writeFileSync(path.join(root, "main.js"), "module.exports = { version: 'test' };\n");
  fs.writeFileSync(path.join(root, "styles.css"), "body { color: red; }\n");
}

function writeSyncConfig(root, value) {
  const configPath = path.join(root, "systemsculpt-sync.config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
  return configPath;
}

const silentLogger = { info() {}, warn() {} };
const digest = "a".repeat(64);
const buildIdentity = Object.freeze({
  schemaVersion: 1,
  id: "12345678-dirty-20260726T205500000Z",
  revision: "1234567890abcdef1234567890abcdef12345678",
  branch: "test/dev-sync",
  dirty: true,
  syncedAt: "2026-07-26T20:55:00.000Z",
  sourcePath: "/test/plugin",
  artifacts: Object.freeze({
    "main.js": digest,
    "manifest.json": digest,
    "styles.css": digest,
  }),
});

test("loadConfiguredTargets exposes only configured local plugin folders", (t) => {
  const root = createTempRoot(t);
  const first = path.join(root, "vault-a", ".obsidian", "plugins", "systemsculpt-ai");
  const second = path.join(root, "vault-b", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, {
    pluginTargets: [{ path: first }, { type: "local", path: second, label: "vault-b", vault: "My Vault" }],
  });

  const loaded = loadConfiguredTargets({ root, configPath });
  assert.equal(countConfiguredTargets({ root, configPath }), 2);
  assert.deepEqual(loaded.targets.map((target) => target.path), [first, second]);
  assert.equal(formatSyncTarget(loaded.targets[1]), "plugin: vault-b");
  assert.equal(loaded.targets[1].vault, "My Vault");
});

test("syncConfiguredTargets copies local artifacts and removes obsolete extras", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  fs.mkdirSync(path.join(pluginDir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "README.md"), "obsolete\n");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });

  const sourceManifest = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
  const result = syncConfiguredTargets({
    root,
    configPath,
    logger: silentLogger,
    buildIdentity,
  });
  assert.equal(result.succeeded.length, 1);
  assert.equal(fs.readFileSync(path.join(pluginDir, "main.js"), "utf8"), "module.exports = { version: 'test' };\n");
  assert.equal(fs.readFileSync(path.join(root, "manifest.json"), "utf8"), sourceManifest);
  const syncedManifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));
  assert.deepEqual(syncedManifest[DEVELOPMENT_BUILD_MANIFEST_KEY], buildIdentity);
  assert.equal(syncedManifest.version, "5.3.0");
  assert.equal(fs.existsSync(path.join(pluginDir, "README.md")), false);
  assert.equal(fs.existsSync(path.join(pluginDir, "node_modules")), false);
  assert.equal(
    fs.readdirSync(pluginDir).some((name) => name.includes(".systemsculpt-sync-")),
    false,
  );
});

test("createDevelopmentBuildIdentity fingerprints every source artifact", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const identity = createDevelopmentBuildIdentity({
    root,
    revision: "1234567890abcdef1234567890abcdef12345678",
    branch: "test/build",
    dirty: false,
    syncedAt: "2026-07-26T20:55:00.000Z",
  });

  assert.equal(identity.id, "12345678-20260726T205500000Z");
  assert.deepEqual(Object.keys(identity.artifacts).sort(), [
    "main.js",
    "manifest.json",
    "styles.css",
  ]);
  assert.match(identity.artifacts["main.js"], /^[a-f0-9]{64}$/);
  assert.equal(identity.sourcePath, root);
});

test("reloadConfiguredTargets uses Obsidian CLI with the configured vault", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const calls = [];
  const result = reloadConfiguredTargets({
    root,
    targets: [{
      path: path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai"),
      vault: "QA Vault",
    }],
    env: { SYSTEMSCULPT_AUTO_RELOAD: "1" },
    logger: silentLogger,
    runCommand(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: "Reloaded\n", stderr: "" };
    },
  });

  assert.deepEqual(calls, [{
    command: "obsidian",
    args: ["plugin:reload", "id=systemsculpt-ai", "vault=QA Vault"],
  }]);
  assert.equal(result.reloaded.length, 1);
});

test("createBuildSyncController copies artifacts and reloads the plugin", async (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });
  const reloadTargets = mockFunction();
  const controller = createBuildSyncController({
    root,
    configPath,
    env: { SYSTEMSCULPT_AUTO_SYNC: "1" },
    logger: silentLogger,
    reloadTargets,
  });

  assert.equal(controller.isEnabled(), true);
  controller.schedule();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(path.join(pluginDir, "main.js")), true);
  assert.equal(reloadTargets.calls.length, 1);
});

function mockFunction() {
  const fn = (...args) => {
    fn.calls.push(args);
    return { reloaded: [] };
  };
  fn.calls = [];
  return fn;
}
