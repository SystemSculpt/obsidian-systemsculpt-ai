import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  countConfiguredTargets,
  createDevelopmentBuildIdentity,
  createBuildSyncController,
  DEFAULT_OBSIDIAN_RELOAD_TIMEOUT_MS,
  DEVELOPMENT_BUILD_MANIFEST_KEY,
  formatSyncTarget,
  loadConfiguredTargets,
  replaceFileAtomically,
  reloadConfiguredTargets,
  resolveSyncConfigPath,
  syncConfiguredTargets,
} from "./plugin-sync.mjs";
import { parseArgs as parseSyncLocalArgs } from "./sync-local-vaults.mjs";
import { STAGING_API_BASE_URL } from "./plugin-build-options.mjs";

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-plugin-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePluginArtifacts(root) {
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    '{"id":"systemsculpt-ai","version":"5.3.0","isDesktopOnly":false}\n',
  );
  fs.writeFileSync(
    path.join(root, "main.js"),
    "module.exports = { version: 'test', api: 'https://systemsculpt.com/api/plugin' };\n",
  );
  fs.writeFileSync(path.join(root, "styles.css"), "body { color: red; }\n");
}

function writeStagingPluginArtifacts(root) {
  writePluginArtifacts(root);
  fs.writeFileSync(
    path.join(root, "main.js"),
    `module.exports = { version: 'test', api: ${JSON.stringify(STAGING_API_BASE_URL)} };\n`,
  );
}

function writeSyncConfig(root, value) {
  const configPath = path.join(root, "systemsculpt-sync.config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
  return configPath;
}

const silentLogger = { info() {}, warn() {} };

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Condition was not met within ${timeoutMs}ms.`);
}

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
  });
  assert.equal(result.succeeded.length, 1);
  assert.equal(
    fs.readFileSync(path.join(pluginDir, "main.js"), "utf8"),
    "module.exports = { version: 'test', api: 'https://systemsculpt.com/api/plugin' };\n",
  );
  assert.equal(fs.readFileSync(path.join(root, "manifest.json"), "utf8"), sourceManifest);
  const syncedManifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));
  assert.deepEqual(syncedManifest[DEVELOPMENT_BUILD_MANIFEST_KEY], result.buildIdentity);
  assert.equal(syncedManifest.version, "5.3.0");
  assert.equal(fs.existsSync(path.join(pluginDir, "README.md")), false);
  assert.equal(fs.existsSync(path.join(pluginDir, "node_modules")), false);
  assert.equal(
    fs.readdirSync(pluginDir).some((name) => name.includes(".systemsculpt-replace-")),
    false,
  );
});

test("syncConfiguredTargets accepts staging only when the staging target is explicit", (t) => {
  const root = createTempRoot(t);
  writeStagingPluginArtifacts(root);
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });

  assert.throws(
    () => syncConfiguredTargets({ root, configPath, logger: silentLogger }),
    /canonical SystemSculpt API base/,
  );
  assert.equal(fs.existsSync(pluginDir), false);

  const result = syncConfiguredTargets({
    root,
    configPath,
    logger: silentLogger,
    apiBaseUrl: STAGING_API_BASE_URL,
  });
  assert.equal(result.succeeded.length, 1);
  assert.match(
    fs.readFileSync(path.join(pluginDir, "main.js"), "utf8"),
    /staging\.systemsculpt\.com\/api\/plugin/,
  );
});

test("repeat sync safely replaces existing target artifacts with Windows rename semantics", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });
  const replacement = (filePath, bytes) => replaceFileAtomically(filePath, bytes, {
    platform: "win32",
    maxRetries: 2,
    retryDelayMs: 0,
    sleep() {},
    fsImpl: {
      ...fs,
      renameSync(source, destination) {
        if (
          source.includes(".systemsculpt-replace-")
          && source.endsWith(".tmp")
          && destination === filePath
          && fs.existsSync(destination)
        ) {
          const error = new Error("Windows refuses to rename over an existing file");
          error.code = "EEXIST";
          throw error;
        }
        fs.renameSync(source, destination);
      },
    },
  });

  syncConfiguredTargets({
    root,
    configPath,
    logger: silentLogger,
    replaceFile: replacement,
  });
  fs.writeFileSync(
    path.join(root, "main.js"),
    "module.exports = { version: 'updated', api: 'https://systemsculpt.com/api/plugin' };\n",
  );
  syncConfiguredTargets({
    root,
    configPath,
    logger: silentLogger,
    replaceFile: replacement,
  });

  assert.equal(
    fs.readFileSync(path.join(pluginDir, "main.js"), "utf8"),
    "module.exports = { version: 'updated', api: 'https://systemsculpt.com/api/plugin' };\n",
  );
  assert.equal(
    fs.readdirSync(pluginDir).some((name) => name.includes(".systemsculpt-replace-")),
    false,
  );
});

test("failed Windows replacement restores the previous artifact", (t) => {
  const root = createTempRoot(t);
  const target = path.join(root, "main.js");
  fs.writeFileSync(target, "previous bytes\n", "utf8");
  let targetWasBackedUp = false;

  assert.throws(
    () => replaceFileAtomically(target, Buffer.from("new bytes\n"), {
      platform: "win32",
      maxRetries: 0,
      sleep() {},
      fsImpl: {
        ...fs,
        renameSync(source, destination) {
          if (source.endsWith(".tmp") && destination === target) {
            const error = new Error("replacement remained locked");
            error.code = "EPERM";
            throw error;
          }
          if (source === target && destination.endsWith(".bak")) {
            targetWasBackedUp = true;
          }
          fs.renameSync(source, destination);
        },
      },
    }),
    /replacement remained locked/,
  );
  assert.equal(targetWasBackedUp, true);
  assert.equal(fs.readFileSync(target, "utf8"), "previous bytes\n");
  assert.equal(
    fs.readdirSync(root).some((name) => name.includes(".systemsculpt-replace-")),
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

test("syncConfiguredTargets refuses every artifact inspection failure before touching a target", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  fs.appendFileSync(
    path.join(root, "main.js"),
    "//# sourceMappingURL=data:application/json;base64,e30=\n",
  );
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "main.js"), "previous bytes\n");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });

  assert.throws(
    () => syncConfiguredTargets({ root, configPath, logger: silentLogger }),
    /inline source map/,
  );
  assert.equal(fs.readFileSync(path.join(pluginDir, "main.js"), "utf8"), "previous bytes\n");
});

test("syncConfiguredTargets independently validates a supplied development identity", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });
  const identity = createDevelopmentBuildIdentity({
    root,
    revision: "1234567890abcdef1234567890abcdef12345678",
    branch: "test/build",
    dirty: true,
    syncedAt: "2026-07-26T20:55:00.000Z",
  });
  const mismatched = {
    ...identity,
    artifacts: {
      ...identity.artifacts,
      "main.js": "a".repeat(64),
    },
  };

  assert.throws(
    () => syncConfiguredTargets({
      root,
      configPath,
      logger: silentLogger,
      buildIdentity: mismatched,
    }),
    /identity does not match source main\.js/,
  );
  assert.equal(fs.existsSync(pluginDir), false);
});

test("syncConfiguredTargets reads back every generated target artifact", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });

  assert.throws(
    () => syncConfiguredTargets({
      root,
      configPath,
      logger: silentLogger,
      replaceFile(filePath, bytes) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          filePath.endsWith("styles.css") ? "corrupted styles\n" : bytes,
        );
      },
    }),
    /styles\.css failed byte-for-byte read-back/,
  );
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
    runCommand(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "Reloaded\n", stderr: "" };
    },
  });

  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [{
    command: "obsidian",
    args: ["plugin:reload", "id=systemsculpt-ai", "vault=QA Vault"],
  }]);
  assert.equal(calls[0].options.timeout, DEFAULT_OBSIDIAN_RELOAD_TIMEOUT_MS);
  assert.equal(calls[0].options.killSignal, "SIGKILL");
  assert.equal(result.reloaded.length, 1);
});

test("reloadConfiguredTargets kills and logs a hung Obsidian reload without waiting indefinitely", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const warnings = [];
  const startedAt = Date.now();

  assert.throws(
    () => reloadConfiguredTargets({
      root,
      targets: [{
        path: path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai"),
        vault: "QA Vault",
      }],
      env: { SYSTEMSCULPT_AUTO_RELOAD: "1" },
      timeoutMs: 100,
      logger: { info() {}, warn(value) { warnings.push(value); } },
      runCommand(_command, _args, options) {
        return spawnSync(
          process.execPath,
          ["-e", "setInterval(() => {}, 1_000)"],
          options,
        );
      },
    }),
    /Failed to reload QA Vault/,
  );

  assert.ok(Date.now() - startedAt < 5_000);
  assert.deepEqual(warnings, [
    "[sync] Obsidian reload timed out for QA Vault after 100ms; terminated child with SIGKILL.",
  ]);
});

test("reloadConfiguredTargets fails when Obsidian rejects a configured reload", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const warnings = [];

  assert.throws(
    () => reloadConfiguredTargets({
      root,
      targets: [{
        path: path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai"),
        vault: "QA Vault",
      }],
      env: { SYSTEMSCULPT_AUTO_RELOAD: "1" },
      logger: { info() {}, warn(value) { warnings.push(value); } },
      runCommand() {
        return { status: 7, stdout: "", stderr: "plugin reload failed\n" };
      },
    }),
    /Failed to reload QA Vault/,
  );
  assert.deepEqual(warnings, [
    "[sync] Obsidian reload skipped for QA Vault: plugin reload failed",
  ]);
});

test("sync-local honors SYSTEMSCULPT_SYNC_CONFIG when no CLI config is passed", () => {
  const previous = process.env.SYSTEMSCULPT_SYNC_CONFIG;
  const configured = path.resolve(os.tmpdir(), "systemsculpt-env-sync-config.json");
  process.env.SYSTEMSCULPT_SYNC_CONFIG = configured;
  try {
    const options = parseSyncLocalArgs([]);
    assert.equal(options.configPath, undefined);
    assert.equal(resolveSyncConfigPath(options.configPath), configured);
  } finally {
    if (previous === undefined) delete process.env.SYSTEMSCULPT_SYNC_CONFIG;
    else process.env.SYSTEMSCULPT_SYNC_CONFIG = previous;
  }
});

test("sync CLI exposes only production and staging artifact targets", () => {
  assert.equal(parseSyncLocalArgs([]).target, "production");
  assert.equal(parseSyncLocalArgs(["--target", "staging"]).target, "staging");
  assert.throws(
    () => parseSyncLocalArgs(["--target", "preview"]),
    /Unknown plugin sync target: preview/,
  );
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

test("createBuildSyncController accepts later cycles after a reload failure", async (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);
  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, { pluginTargets: [{ path: pluginDir }] });
  const warnings = [];
  let reloadAttempts = 0;
  const controller = createBuildSyncController({
    root,
    configPath,
    env: { SYSTEMSCULPT_AUTO_SYNC: "1" },
    logger: { info() {}, warn(value) { warnings.push(value); } },
    reloadTargets() {
      reloadAttempts += 1;
      if (reloadAttempts === 1) {
        throw new Error("Obsidian reload timed out.");
      }
      return { reloaded: [] };
    },
  });

  controller.schedule();
  await waitFor(() => reloadAttempts === 1);
  controller.schedule();
  await waitFor(() => reloadAttempts === 2);

  assert.equal(reloadAttempts, 2);
  assert.ok(warnings.some((warning) =>
    warning.includes("Auto-sync failed: Obsidian reload timed out.")));
});

function mockFunction() {
  const fn = (...args) => {
    fn.calls.push(args);
    return { reloaded: [] };
  };
  fn.calls = [];
  return fn;
}
