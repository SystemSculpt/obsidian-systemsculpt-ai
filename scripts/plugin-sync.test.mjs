import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  countConfiguredTargets,
  createBuildSyncController,
  formatSyncTarget,
  loadConfiguredTargets,
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

test("loadConfiguredTargets exposes only configured local plugin folders", (t) => {
  const root = createTempRoot(t);
  const first = path.join(root, "vault-a", ".obsidian", "plugins", "systemsculpt-ai");
  const second = path.join(root, "vault-b", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, {
    pluginTargets: [{ path: first }, { type: "local", path: second, label: "vault-b" }],
  });

  const loaded = loadConfiguredTargets({ root, configPath });
  assert.equal(countConfiguredTargets({ root, configPath }), 2);
  assert.deepEqual(loaded.targets.map((target) => target.path), [first, second]);
  assert.equal(formatSyncTarget(loaded.targets[1]), "plugin: vault-b");
});

test("syncConfiguredTargets copies local artifacts and removes obsolete extras", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  fs.mkdirSync(path.join(pluginDir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "README.md"), "obsolete\n");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });

  const result = syncConfiguredTargets({ root, configPath, logger: silentLogger });
  assert.equal(result.succeeded.length, 1);
  assert.equal(fs.readFileSync(path.join(pluginDir, "main.js"), "utf8"), "module.exports = { version: 'test' };\n");
  assert.equal(fs.existsSync(path.join(pluginDir, "README.md")), false);
  assert.equal(fs.existsSync(path.join(pluginDir, "node_modules")), false);
});

test("createBuildSyncController copies artifacts without a reload transport", async (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });
  const controller = createBuildSyncController({
    root,
    configPath,
    env: { SYSTEMSCULPT_AUTO_SYNC: "1" },
    logger: silentLogger,
  });

  assert.equal(controller.isEnabled(), true);
  controller.schedule();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(path.join(pluginDir, "main.js")), true);
});
