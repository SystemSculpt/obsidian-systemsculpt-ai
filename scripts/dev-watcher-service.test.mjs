import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDevWatcherLaunchAgentPlist,
  DEV_WATCHER_SERVICE_LABEL,
  installDevWatcherService,
  inspectDevWatcherService,
  uninstallDevWatcherService,
} from "./dev-watcher-service.mjs";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-dev-watcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("launch agent plist keeps the watcher alive and preserves escaped paths", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, "Home & QA");
  const plist = createDevWatcherLaunchAgentPlist({
    root: path.join(root, "plugin <dev>"),
    configPath: path.join(root, "sync & reload.json"),
    home,
  });

  assert.match(plist, new RegExp(`<string>${DEV_WATCHER_SERVICE_LABEL}</string>`));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /plugin &lt;dev&gt;\/run\.sh/);
  assert.match(plist, /sync &amp; reload\.json/);
  assert.match(
    plist,
    /<string>--<\/string>\s*<string>production-watch<\/string>/,
  );
});

test("launch agent selects staging through an explicit watcher target", (t) => {
  const root = tempRoot(t);
  const plist = createDevWatcherLaunchAgentPlist({
    root: path.join(root, "plugin"),
    configPath: path.join(root, "sync.json"),
    home: path.join(root, "home"),
    target: "staging",
  });

  assert.match(plist, /<string>staging-watch<\/string>/);
  assert.doesNotMatch(plist, /SYSTEMSCULPT_API_BASE_URL|SYSTEMSCULPT_TEST_DRIVER/);
  assert.doesNotMatch(plist, /MASTER_LICENSE_KEY|OPENROUTER|DATABASE_URL/);
});

test("install writes and bootstraps a per-user persistent watcher", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, "home");
  const configPath = path.join(root, "systemsculpt-sync.config.json");
  fs.writeFileSync(path.join(root, "run.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(configPath, JSON.stringify({
    pluginTargets: [{ path: path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai") }],
  }));
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "print") return { status: 113, stdout: "", stderr: "not found" };
    return { status: 0, stdout: "ok", stderr: "" };
  };

  const result = installDevWatcherService({
    root,
    home,
    configPath,
    platform: "darwin",
    uid: 501,
    runCommand,
  });

  assert.equal(fs.existsSync(result.plistPath), true);
  assert.deepEqual(calls.map(([, args]) => args[0]), [
    "bootout",
    "print",
    "bootstrap",
    "kickstart",
  ]);
  assert.match(fs.readFileSync(result.plistPath, "utf8"), /--headless/);
  assert.match(fs.readFileSync(result.plistPath, "utf8"), /--sync-config/);
  assert.match(
    fs.readFileSync(result.plistPath, "utf8"),
    /<string>production-watch<\/string>/,
  );
});

test("install waits for an asynchronous launchd bootout before bootstrapping", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, "home");
  const configPath = path.join(root, "systemsculpt-sync.config.json");
  fs.writeFileSync(path.join(root, "run.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(configPath, JSON.stringify({
    pluginTargets: [{ path: path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai") }],
  }));
  const calls = [];
  let printCount = 0;
  let sleepCount = 0;
  const runCommand = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "print") {
      printCount += 1;
      return printCount < 3
        ? { status: 0, stdout: "still unloading", stderr: "" }
        : { status: 113, stdout: "", stderr: "not found" };
    }
    return { status: 0, stdout: "ok", stderr: "" };
  };

  installDevWatcherService({
    root,
    home,
    configPath,
    platform: "darwin",
    uid: 501,
    runCommand,
    sleep: () => {
      sleepCount += 1;
    },
  });

  assert.equal(printCount, 3);
  assert.equal(sleepCount, 2);
  assert.deepEqual(calls.map(([, args]) => args[0]), [
    "bootout",
    "print",
    "print",
    "print",
    "bootstrap",
    "kickstart",
  ]);
});

test("install fails safely when launchd never completes the bootout", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, "home");
  const configPath = path.join(root, "systemsculpt-sync.config.json");
  fs.writeFileSync(path.join(root, "run.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(configPath, JSON.stringify({
    pluginTargets: [{ path: path.join(root, "vault", ".obsidian", "plugins", "systemsculpt-ai") }],
  }));
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: "still unloading", stderr: "" };
  };

  assert.throws(() => installDevWatcherService({
    root,
    home,
    configPath,
    platform: "darwin",
    uid: 501,
    runCommand,
    sleep: () => {},
    unloadTimeoutMs: 3,
    unloadPollIntervalMs: 1,
  }), /did not unload.*within 3ms/);
  assert.equal(calls.some(([, args]) => args[0] === "bootstrap"), false);
});

test("install refuses to run without an explicit local vault target", (t) => {
  const root = tempRoot(t);
  const configPath = path.join(root, "systemsculpt-sync.config.json");
  fs.writeFileSync(path.join(root, "run.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(configPath, JSON.stringify({ pluginTargets: [] }));

  assert.throws(() => installDevWatcherService({
    root,
    home: path.join(root, "home"),
    configPath,
    platform: "darwin",
    uid: 501,
    runCommand: () => ({ status: 0 }),
  }), /No plugin targets/);
});

test("status and uninstall use the same launchd label", (t) => {
  const root = tempRoot(t);
  const home = path.join(root, "home");
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(launchAgents, { recursive: true });
  const plistPath = path.join(launchAgents, `${DEV_WATCHER_SERVICE_LABEL}.plist`);
  fs.writeFileSync(plistPath, "test");
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: "running", stderr: "" };
  };

  assert.deepEqual(inspectDevWatcherService({
    platform: "darwin",
    uid: 501,
    runCommand,
  }), { running: true, detail: "running" });
  uninstallDevWatcherService({
    home,
    platform: "darwin",
    uid: 501,
    runCommand,
  });
  assert.equal(fs.existsSync(plistPath), false);
  assert.match(calls[0][1][1], new RegExp(DEV_WATCHER_SERVICE_LABEL));
  assert.match(calls[1][1][1], new RegExp(DEV_WATCHER_SERVICE_LABEL));
});
