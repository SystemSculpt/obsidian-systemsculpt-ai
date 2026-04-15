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
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writePluginArtifacts(root) {
  fs.writeFileSync(path.join(root, "manifest.json"), '{"id":"systemsculpt-ai","version":"5.3.0"}\n', "utf8");
  fs.writeFileSync(path.join(root, "main.js"), "module.exports = { version: 'test' };\n", "utf8");
  fs.writeFileSync(path.join(root, "styles.css"), "body { color: red; }\n", "utf8");
}

function writeSyncConfig(root, value) {
  const configPath = path.join(root, "systemsculpt-sync.config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return configPath;
}

function createSilentLogger() {
  return {
    info() {},
    warn() {},
  };
}

test("loadConfiguredTargets includes local plugin targets, Windows SSH mirrors, and legacy env mirrors", (t) => {
  const root = createTempRoot(t);
  const localPluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  const localMirrorDir = path.join(root, "mirror");
  const configPath = writeSyncConfig(root, {
    pluginTargets: [{ path: localPluginDir }],
    mirrorTargets: [
      { path: localMirrorDir, label: "local-mirror" },
      {
        type: "windows-ssh",
        host: "windows-test-host",
        path: "C:/SystemSculptWindowsQA/.obsidian/plugins/systemsculpt-ai",
        label: "windows-host",
      },
    ],
  });

  const env = {
    SYSTEMSCULPT_AUTO_SYNC_PATH: path.join(root, "env-mirror"),
  };

  const loaded = loadConfiguredTargets({
    root,
    configPath,
    env,
  });

  assert.equal(loaded.configExists, true);
  assert.equal(countConfiguredTargets({ root, configPath, env }), 4);
  assert.deepEqual(
    loaded.targets.map((target) => target.type),
    ["local", "local", "windows-ssh", "local"]
  );
  assert.equal(
    formatSyncTarget(loaded.targets[2]),
    "mirror: windows-host -> windows-test-host:C:/SystemSculptWindowsQA/.obsidian/plugins/systemsculpt-ai"
  );
});

test("syncConfiguredTargets copies local artifacts and removes legacy extras", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);

  const pluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  fs.mkdirSync(path.join(pluginDir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "README.md"), "legacy\n", "utf8");
  fs.writeFileSync(path.join(pluginDir, "node_modules", "legacy.txt"), "legacy\n", "utf8");

  const configPath = writeSyncConfig(root, {
    pluginTargets: [{ path: pluginDir }],
    mirrorTargets: [],
  });

  const result = syncConfiguredTargets({
    root,
    configPath,
    logger: createSilentLogger(),
  });

  assert.equal(result.succeeded.length, 1);
  assert.equal(
    fs.readFileSync(path.join(pluginDir, "main.js"), "utf8"),
    "module.exports = { version: 'test' };\n"
  );
  assert.equal(fs.existsSync(path.join(pluginDir, "README.md")), false);
  assert.equal(fs.existsSync(path.join(pluginDir, "node_modules")), false);
});

test("syncConfiguredTargets drives windows ssh mirrors through ssh plus scp", (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);

  const configPath = writeSyncConfig(root, {
    pluginTargets: [],
    mirrorTargets: [
      {
        type: "windows-ssh",
        host: "windows-test-host",
        path: "C:/SystemSculptWindowsQA/.obsidian/plugins/systemsculpt-ai",
      },
    ],
  });

  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  };

  const result = syncConfiguredTargets({
    root,
    configPath,
    logger: createSilentLogger(),
    spawnSyncImpl,
  });

  assert.equal(result.succeeded.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "ssh");
  assert.equal(calls[1].command, "scp");
  assert.match(calls[1].args[calls[1].args.length - 1], /^windows-test-host:C:\/SystemSculptWindowsQA/);
  assert.deepEqual(calls[1].args.slice(0, 1), ["-Cq"]);
});

test("loadConfiguredTargets rejects unsupported Windows transports", (t) => {
  const root = createTempRoot(t);

  const configPath = writeSyncConfig(root, {
    pluginTargets: [],
    mirrorTargets: [
      {
        type: "windows-host",
        path: "C:/SystemSculptWindowsQA/.obsidian/plugins/systemsculpt-ai",
      },
    ],
  });

  assert.throws(
    () => loadConfiguredTargets({ root, configPath }),
    /Unsupported Windows sync target type: windows-host/
  );
});

test("createBuildSyncController hot reloads only after local plugin target success", async (t) => {
  const root = createTempRoot(t);
  writePluginArtifacts(root);

  const localPluginDir = path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai");
  const configPath = writeSyncConfig(root, {
    pluginTargets: [{ path: localPluginDir }],
    mirrorTargets: [],
  });

  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  };

  const controller = createBuildSyncController({
    root,
    configPath,
    env: {
      SYSTEMSCULPT_AUTO_SYNC: "1",
      SYSTEMSCULPT_AUTO_RELOAD: "1",
    },
    logger: createSilentLogger(),
    spawnSyncImpl,
    quiet: true,
  });

  assert.equal(controller.isEnabled(), true);
  controller.schedule();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "node");
  assert.equal(
    fs.readFileSync(path.join(localPluginDir, "manifest.json"), "utf8"),
    '{"id":"systemsculpt-ai","version":"5.3.0"}\n'
  );
});
