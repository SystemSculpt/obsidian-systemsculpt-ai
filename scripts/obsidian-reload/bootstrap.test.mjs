import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bootstrapObsidianReloadClient,
  ensureObsidianReloadSettings,
  loadPluginTargetsFromSyncConfig,
  resolveObsidianReloadTarget,
} from "./bootstrap.mjs";

async function createTarget(t, settings = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-reload-bootstrap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, "vault");
  const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", "systemsculpt-ai");
  const dataFilePath = path.join(pluginDir, "data.json");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(dataFilePath, `${JSON.stringify(settings, null, 2)}\n`);
  return { index: 0, pluginDir, dataFilePath, vaultRoot, vaultName: "vault" };
}

test("loadPluginTargetsFromSyncConfig resolves local vault metadata", async (t) => {
  const target = await createTarget(t);
  const configPath = path.join(path.dirname(target.vaultRoot), "sync.json");
  await fs.writeFile(configPath, JSON.stringify({ pluginTargets: [{ path: target.pluginDir }] }));
  const [loaded] = await loadPluginTargetsFromSyncConfig(configPath);
  assert.equal(loaded.vaultRoot, target.vaultRoot);
  assert.equal(loaded.dataFilePath, target.dataFilePath);
});

test("resolveObsidianReloadTarget prefers an explicit target, then a matching live vault", async () => {
  const targets = [
    { index: 0, vaultName: "a", vaultRoot: "/tmp/a" },
    { index: 1, vaultName: "b", vaultRoot: "/tmp/b" },
  ];
  assert.equal(await resolveObsidianReloadTarget(targets, { targetIndex: 0 }), targets[0]);
  assert.equal(
    await resolveObsidianReloadTarget(targets, {
      createClient: async () => ({ record: { vaultPath: "/tmp/b" } }),
    }),
    targets[1],
  );
});

test("ensureObsidianReloadSettings changes only bridge enablement and vault identity", async (t) => {
  const target = await createTarget(t, {
    settingsMode: "basic",
    favoriteChats: ["keep-me"],
    customValue: 42,
  });
  const first = await ensureObsidianReloadSettings(target);
  const stored = JSON.parse(await fs.readFile(target.dataFilePath, "utf8"));
  assert.equal(first.wrote, true);
  assert.equal(stored.desktopAutomationBridgeEnabled, true);
  assert.match(stored.vaultInstanceId, /^[0-9a-f-]{36}$/i);
  assert.equal(stored.settingsMode, "basic");
  assert.deepEqual(stored.favoriteChats, ["keep-me"]);
  assert.equal(stored.customValue, 42);
  assert.equal((await ensureObsidianReloadSettings(target)).wrote, false);
});

test("bootstrapObsidianReloadClient reloads one selected vault and waits for stability", async (t) => {
  const target = await createTarget(t);
  const calls = [];
  const liveClient = {
    record: { startedAt: "old-generation" },
    async reloadPlugin() { calls.push("reload"); },
  };
  const stableClient = { record: { startedAt: "new-generation" } };
  const result = await bootstrapObsidianReloadClient({
    targets: [target],
    targetIndex: 0,
    createClient: async () => liveClient,
    waitForStableClient: async (options) => {
      calls.push(options.excludeStartedAt);
      return stableClient;
    },
  });
  assert.deepEqual(calls, ["reload", "old-generation"]);
  assert.equal(result.client, stableClient);
  assert.equal(result.target, target);
});

test("bootstrapObsidianReloadClient reports a bounded not-running result", async (t) => {
  const target = await createTarget(t);
  await assert.rejects(
    bootstrapObsidianReloadClient({
      targets: [target],
      targetIndex: 0,
      createClient: async () => { throw new Error("not running"); },
      waitForClient: async () => { throw new Error("timed out"); },
    }),
    /Keep that vault open and do one manual plugin reload/,
  );
});
