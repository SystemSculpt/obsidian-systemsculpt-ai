import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import {
  DriverSession,
  DRIVER_MARKER,
  HANDSHAKE_FILE,
  PROTOCOL_VERSION,
  expectedBuildStampFromTarget,
  resolvePluginTarget,
  runSteps,
} from "./driver-session.mjs";

function makeTempPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ss-e2e-driver-"));
}

function readHandshake(pluginDir) {
  return JSON.parse(fs.readFileSync(path.join(pluginDir, HANDSHAKE_FILE), "utf8"));
}

function connectFakeDriver(pluginDir, { token, replies = {} } = {}) {
  const handshake = readHandshake(pluginDir);
  const socket = new WebSocket(`ws://127.0.0.1:${handshake.port}/`);
  socket.on("open", () => {
    socket.send(JSON.stringify({
      type: "hello",
      token: token ?? handshake.token,
      serverId: handshake.serverId,
      marker: DRIVER_MARKER,
      vault: "fixture-vault",
      pluginVersion: "0.0.0-test",
      buildStamp: "dev",
    }));
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== "action") return;
    const reply = replies[message.action] ?? { ok: true, result: { echoed: message.action } };
    socket.send(JSON.stringify({ type: "result", id: message.id, ...reply }));
  });
  return socket;
}

test("resolvePluginTarget prefers explicit paths and validates config targets", () => {
  const explicit = resolvePluginTarget({ explicitPath: "/tmp/vault/.obsidian/plugins/systemsculpt-ai" });
  assert.equal(explicit.path, "/tmp/vault/.obsidian/plugins/systemsculpt-ai");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-e2e-config-"));
  fs.writeFileSync(path.join(root, "systemsculpt-sync.config.json"), JSON.stringify({
    pluginTargets: [
      { path: "/vaults/alpha/.obsidian/plugins/systemsculpt-ai", vault: "alpha" },
      { path: "/vaults/beta/.obsidian/plugins/systemsculpt-ai", vault: "beta" },
    ],
  }));
  assert.equal(resolvePluginTarget({ root }).vault, "alpha");
  assert.equal(resolvePluginTarget({ root, vaultName: "beta" }).vault, "beta");
  assert.throws(() => resolvePluginTarget({ root, vaultName: "missing" }), /Known targets: alpha, beta/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("expectedBuildStampFromTarget reads the synced development identity", () => {
  const pluginDir = makeTempPluginDir();
  try {
    fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
      id: "systemsculpt-ai",
      systemsculptDevBuild: { id: "abc12345-dirty-20260805T120000000Z" },
    }));
    assert.equal(
      expectedBuildStampFromTarget(pluginDir),
      "abc12345-dirty-20260805T120000000Z",
    );
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("DriverSession writes a valid handshake, accepts the driver, and round-trips actions", async () => {
  const pluginDir = makeTempPluginDir();
  const session = new DriverSession({ pluginDir, connectTimeoutMs: 5000, actionTimeoutMs: 5000 });
  try {
    const connected = session.connect();
    // The handshake file must exist as soon as the server listens.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const handshake = readHandshake(pluginDir);
    assert.equal(handshake.version, PROTOCOL_VERSION);
    assert.ok(handshake.port > 0);
    assert.ok(handshake.token.length > 10);

    const driver = connectFakeDriver(pluginDir, {
      replies: {
        failing: { ok: false, error: { message: "boom" } },
      },
    });
    const hello = await connected;
    assert.equal(hello.vault, "fixture-vault");

    const result = await session.run("status");
    assert.deepEqual(result, { echoed: "status" });

    const outcome = await runSteps(session, [
      { action: "status" },
      { action: "failing" },
      { action: "never-reached" },
    ]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.steps[0].ok, true);
    assert.equal(outcome.steps[1].ok, false);
    assert.match(outcome.steps[1].error, /boom/);
    assert.equal(outcome.steps[2].skipped, true);

    const resumed = await runSteps(session, [
      { action: "status" },
      { action: "failing" },
      { action: "skipped-after-failure" },
      { action: "status", resumeAfterFailure: true },
      { action: "reached-after-resume" },
    ]);
    assert.equal(resumed.ok, false);
    assert.equal(resumed.steps[2].skipped, true);
    assert.equal(resumed.steps[3].ok, true);
    assert.equal(resumed.steps[4].ok, true);
    assert.deepEqual(resumed.steps[1].diagnostics.logs, { echoed: "logs" });

    driver.close();
  } finally {
    session.close();
    assert.equal(fs.existsSync(path.join(pluginDir, HANDSHAKE_FILE)), false);
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("DriverSession rejects a driver presenting the wrong token", async () => {
  const pluginDir = makeTempPluginDir();
  const session = new DriverSession({ pluginDir, connectTimeoutMs: 1500, actionTimeoutMs: 1500 });
  try {
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rejected = connectFakeDriver(pluginDir, { token: "wrong-token" });
    const closeCode = await new Promise((resolve) => {
      rejected.on("close", (code) => resolve(code));
    });
    assert.equal(closeCode, 1008);
    await assert.rejects(connected, /No driver connected/);
  } finally {
    session.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});
