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
  expectedApiBaseUrlFromTarget,
  expectedArtifactIdFromTarget,
  expectedBuildStampFromTarget,
  removeOwnedHandshakeFile,
  resolvePluginTarget,
  runScenario,
  runSteps,
  scenarioFromModule,
  validateIncidentReportCopy,
  validateScenario,
  writeHandshakeFileAtomically,
} from "./driver-session.mjs";
import { PLUGIN_ARTIFACT_ID_PREFIX } from "../plugin-artifact-identity.mjs";

const TEST_ARTIFACT_ID = `${PLUGIN_ARTIFACT_ID_PREFIX}${"1".repeat(32)}`;
const STALE_ARTIFACT_ID = `${PLUGIN_ARTIFACT_ID_PREFIX}${"2".repeat(32)}`;

function makeTempPluginDir() {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-e2e-driver-"));
  fs.writeFileSync(
    path.join(pluginDir, "main.js"),
    `const artifact = ${JSON.stringify(TEST_ARTIFACT_ID)};\n`,
  );
  return pluginDir;
}

function readHandshake(pluginDir) {
  return JSON.parse(fs.readFileSync(path.join(pluginDir, HANDSHAKE_FILE), "utf8"));
}

function connectFakeDriver(pluginDir, {
  token,
  replies = {},
  onCancel,
  artifactId = TEST_ARTIFACT_ID,
  buildStamp = "dev",
} = {}) {
  const handshake = readHandshake(pluginDir);
  const socket = new WebSocket(`ws://127.0.0.1:${handshake.port}/`);
  socket.on("open", () => {
    socket.send(JSON.stringify({
      type: "hello",
      token: token ?? handshake.token,
      serverId: handshake.serverId,
      marker: DRIVER_MARKER,
      artifactId,
      vault: "fixture-vault",
      pluginVersion: "0.0.0-test",
      buildStamp,
      apiBaseUrl: "http://127.0.0.1:8787/api/plugin",
    }));
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "cancel") {
      onCancel?.(message.id);
      return;
    }
    if (message.type !== "action") return;
    const configured = replies[message.action];
    const reply = typeof configured === "function"
      ? configured(message)
      : configured ?? { ok: true, result: { echoed: message.action } };
    if (reply.defer === true) return;
    socket.send(JSON.stringify({ type: "result", id: message.id, ...reply }));
  });
  return socket;
}

function canonicalForTest(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalForTest(value[key])}`).join(",")}}`;
}

function incidentReportText() {
  const report = {
    schema_version: "systemsculpt.incident/2",
    report_id: `report_${"a".repeat(32)}`,
    created_at: "2026-08-13T12:00:00.000Z",
    incident: {
      classification: "operation_failure",
      impact: "run_failed",
      outcome: "failed",
      severity_text: "ERROR",
      severity_number: 17,
      failure_authority: "server",
      origin: "agent_terminal",
      terminal_evidence: "server_protocol_validated",
      artifact_integrity: "unauthenticated_client_record",
      evidence_scope: "client_observation_only",
      causal_assessment: "not_established",
      observation_source: "server_protocol_terminal",
      failure_stage: "response_terminal",
      failure_mechanism: "service_terminal",
      failure_code: "agent_turn_failed",
      retryable: true,
    },
    correlation: {},
    grouping: {
      strategy: "systemsculpt.failure-contract/1",
      fingerprint: "systemsculpt.failure-contract/1|authority=server|stage=response_terminal|mechanism=service_terminal|failure=agent_turn_failed|status=not_recorded|terminal=not_recorded",
    },
    environment: {},
    run_summary: {
      partial_output: {
        assistant_text_part_count: 1,
        assistant_text_character_count: 27,
      },
    },
    tools: [],
    timeline: [],
    transport_segments: [],
    rendering: {
      before_terminal_publish: {
        first_dom_commit_observed: false,
        first_paint_opportunity_observed: false,
      },
      after_terminal_commit: {
        first_dom_commit_observed: true,
        first_paint_opportunity_observed: true,
      },
      failure_surface_dom_committed: true,
      failure_surface_paint_opportunity_observed: true,
    },
    resource_samples: [],
    capture_quality: { report_bytes: 1 },
    privacy: {
      policy: "strict_allowlist_content_free",
      policy_version: "systemsculpt.incident-privacy/1",
      capture_implementation_version: "agent-incident-recorder/1",
      storage_target: "vault_local",
      host_sync: "may_sync_with_vault",
      automatic_upload: false,
      excluded_data_categories: [
        "prompt_text",
        "assistant_text",
        "reasoning_text",
        "vault_names",
        "paths_and_filenames",
        "file_contents",
        "tool_arguments_and_results",
        "tool_call_ids",
        "search_queries",
        "urls",
        "provider_and_model_names",
        "license_and_account_data",
        "tokens_and_headers",
        "raw_errors_and_stacks",
        "hostnames_usernames_and_device_ids",
        "conversation_and_request_ids",
      ],
    },
  };
  for (;;) {
    const serialized = canonicalForTest(report);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (report.capture_quality.report_bytes === bytes) return serialized;
    report.capture_quality.report_bytes = bytes;
  }
}

test("incident copy validation enforces canonical privacy and rendering evidence", () => {
  const serialized = incidentReportText();
  const validated = validateIncidentReportCopy(serialized);
  assert.equal(validated.reportId, `report_${"a".repeat(32)}`);
  assert.equal(validated.bytes, Buffer.byteLength(serialized, "utf8"));
  assert.match(validated.sha256, /^[a-f0-9]{64}$/u);
  assert.throws(
    () => validateIncidentReportCopy(`${serialized}\n`),
    /not canonical JSON|validation failed/u,
  );
  assert.throws(
    () => validateIncidentReportCopy(serialized, { forbiddenStrings: ["systemsculpt.incident/2"] }),
    /private canary/u,
  );
  const missingPaint = canonicalForTest({
    ...JSON.parse(serialized),
    rendering: {
      ...JSON.parse(serialized).rendering,
      failure_surface_paint_opportunity_observed: false,
    },
  });
  assert.throws(
    () => validateIncidentReportCopy(missingPaint),
    /rendering evidence is incomplete|byte accounting is invalid/u,
  );
  const deprecatedIncidentFields = JSON.parse(serialized);
  deprecatedIncidentFields.incident.handled = true;
  deprecatedIncidentFields.incident.synthetic = false;
  assert.throws(
    () => validateIncidentReportCopy(canonicalForTest(deprecatedIncidentFields)),
    /terminal evidence is invalid/u,
  );
});

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

test("expectedArtifactIdFromTarget ignores mutable manifest labels", () => {
  const pluginDir = makeTempPluginDir();
  try {
    fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
      systemsculptDevBuild: { id: "first-label" },
    }));
    assert.equal(expectedArtifactIdFromTarget(pluginDir), TEST_ARTIFACT_ID);
    fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
      systemsculptDevBuild: { id: "replacement-label" },
    }));
    assert.equal(expectedArtifactIdFromTarget(pluginDir), TEST_ARTIFACT_ID);
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("expectedArtifactIdFromTarget fails closed on missing, malformed, and duplicate sentinels", () => {
  const pluginDir = makeTempPluginDir();
  const secret = "bundle-secret-that-must-not-appear";
  try {
    for (const [bundle, expected] of [
      [`const value = ${JSON.stringify(secret)};`, /identity is missing/],
      [`const value = ${JSON.stringify(`${PLUGIN_ARTIFACT_ID_PREFIX}BAD-${secret}`)};`, /malformed/],
      [`${TEST_ARTIFACT_ID}\n${TEST_ARTIFACT_ID}\n${secret}`, /ambiguous/],
    ]) {
      fs.writeFileSync(path.join(pluginDir, "main.js"), bundle);
      assert.throws(
        () => expectedArtifactIdFromTarget(pluginDir),
        (error) => error instanceof Error
          && expected.test(error.message)
          && !error.message.includes(secret)
          && !error.message.includes(pluginDir),
      );
    }
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("expectedApiBaseUrlFromTarget reads one exact compiled API route", () => {
  const pluginDir = makeTempPluginDir();
  try {
    fs.writeFileSync(
      path.join(pluginDir, "main.js"),
      'const api = "http://127.0.0.1:8787/api/plugin";\n',
    );
    assert.equal(
      expectedApiBaseUrlFromTarget(pluginDir),
      "http://127.0.0.1:8787/api/plugin",
    );

    fs.writeFileSync(
      path.join(pluginDir, "main.js"),
      [
        'const local = "http://127.0.0.1:8787/api/plugin";',
        'const production = "https://systemsculpt.com/api/plugin";',
      ].join("\n"),
    );
    assert.throws(
      () => expectedApiBaseUrlFromTarget(pluginDir),
      /Expected exactly one compiled SystemSculpt API base.*found 2/u,
    );
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("handshakes are private regular files and cleanup is ownership-safe", () => {
  const pluginDir = makeTempPluginDir();
  const handshakePath = path.join(pluginDir, HANDSHAKE_FILE);
  const first = { serverId: "server-a", token: "token-a" };
  const replacement = { serverId: "server-b", token: "token-b" };
  try {
    writeHandshakeFileAtomically(handshakePath, first);
    const installed = fs.lstatSync(handshakePath);
    assert.equal(installed.isFile(), true);
    assert.equal(installed.isSymbolicLink(), false);
    if (process.platform !== "win32") {
      assert.equal(installed.mode & 0o777, 0o600);
    }

    writeHandshakeFileAtomically(handshakePath, replacement);
    assert.equal(removeOwnedHandshakeFile(handshakePath, first), false);
    assert.deepEqual(readHandshake(pluginDir), replacement);
    assert.equal(removeOwnedHandshakeFile(handshakePath, replacement), true);
    assert.equal(fs.existsSync(handshakePath), false);
    assert.equal(fs.existsSync(`${handshakePath}.lock`), false);
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("atomic handshake replacement does not follow an existing symlink", (t) => {
  if (process.platform === "win32") {
    t.skip("Creating symlinks requires environment-specific Windows privileges.");
    return;
  }
  const pluginDir = makeTempPluginDir();
  const handshakePath = path.join(pluginDir, HANDSHAKE_FILE);
  const protectedPath = path.join(pluginDir, "protected.json");
  try {
    fs.writeFileSync(protectedPath, "protected\n");
    fs.symlinkSync(protectedPath, handshakePath);
    writeHandshakeFileAtomically(handshakePath, {
      serverId: "server-safe",
      token: "token-safe",
    });

    assert.equal(fs.readFileSync(protectedPath, "utf8"), "protected\n");
    assert.equal(fs.lstatSync(handshakePath).isSymbolicLink(), false);
    assert.deepEqual(readHandshake(pluginDir), {
      serverId: "server-safe",
      token: "token-safe",
    });
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("scenario validation preserves arrays and accepts explicit cleanup", () => {
  assert.deepEqual(validateScenario([{ action: "status" }]), {
    steps: [{ action: "status" }],
    cleanup: [],
  });
  assert.deepEqual(validateScenario({
    steps: [{ action: "primary" }],
    cleanup: [{ action: "cleanup" }],
  }), {
    steps: [{ action: "primary" }],
    cleanup: [{ action: "cleanup" }],
  });
  assert.throws(
    () => validateScenario({ steps: [{ action: "" }] }),
    /requires a non-empty action/,
  );
});

test("scenario module loading preserves cleanup across every supported export shape", async () => {
  const step = { action: "primary" };
  const cleanup = { action: "cleanup" };
  assert.deepEqual(await scenarioFromModule({
    default: [step],
    cleanup: [cleanup],
  }), {
    steps: [step],
    cleanup: [cleanup],
  });
  assert.deepEqual(await scenarioFromModule({
    scenario: { steps: [step] },
    cleanup: async () => [cleanup],
  }), {
    steps: [step],
    cleanup: [cleanup],
  });
  assert.deepEqual(await scenarioFromModule({
    steps: async () => [step],
    cleanup: async () => [cleanup],
  }), {
    steps: [step],
    cleanup: [cleanup],
  });
  assert.deepEqual(await scenarioFromModule({
    default: { steps: [step], cleanup: [{ action: "inner-cleanup" }] },
    cleanup: [cleanup],
  }), {
    steps: [step],
    cleanup: [{ action: "inner-cleanup" }, cleanup],
  });
  await assert.rejects(
    scenarioFromModule({ default: [step], cleanup: async () => ({ action: "invalid" }) }),
    /cleanup export must resolve to an array/,
  );
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
    assert.equal(hello.artifactId, TEST_ARTIFACT_ID);
    assert.equal(hello.apiBaseUrl, "http://127.0.0.1:8787/api/plugin");

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

test("harness actions preserve incident bytes and ownership across one plugin reload", async () => {
  const pluginDir = makeTempPluginDir();
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    id: "systemsculpt-ai",
    version: "0.0.0-test",
  }));
  const serialized = incidentReportText();
  const reportId = `report_${"a".repeat(32)}`;
  const receipt = {
    version: 1,
    marker: "SS-DEV-TEST-RELOAD",
    ownedChatId: "owned-chat",
    previousChatId: "previous-chat",
    initialApprovalMode: "ask",
    chatPath: "SystemSculpt/Chats/owned-chat.md",
    chatSha256: "b".repeat(64),
  };
  let owner;
  let replacement;
  let importedReceipt = null;
  const cleanLogs = {
    ok: true,
    result: { entries: [], lastSeq: 0, dropped: 0 },
  };
  const replacementReplies = {
    logs: cleanLogs,
    "chat.importDevelopmentOwnershipReceipt": (message) => {
      importedReceipt = message.params.receipt;
      return { ok: true, result: { restored: true } };
    },
    "chat.readCopiedIncidentReport": {
      ok: true,
      result: { reportId, serialized },
    },
  };
  const session = new DriverSession({
    pluginDir,
    connectTimeoutMs: 5000,
    actionTimeoutMs: 5000,
    reloadPlugin: async ({ pluginId, vault }) => {
      assert.equal(pluginId, "systemsculpt-ai");
      assert.equal(vault, "fixture-vault");
      const closed = new Promise((resolve) => owner.once("close", resolve));
      owner.close(1000, "fixture reload");
      await closed;
      replacement = connectFakeDriver(pluginDir, { replies: replacementReplies });
    },
  });
  try {
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    owner = connectFakeDriver(pluginDir, {
      replies: {
        logs: cleanLogs,
        "chat.exportDevelopmentOwnershipReceipt": {
          ok: true,
          result: receipt,
        },
        "chat.readCopiedIncidentReport": {
          ok: true,
          result: { reportId, serialized },
        },
      },
    });
    await connected;

    await session.run("e2e.console.baseline");
    const captured = await session.run("e2e.incident.captureCopiedReport");
    assert.equal(captured.captured, true);
    assert.equal(captured.reportId, reportId);
    assert.equal("serialized" in captured, false);

    const reloaded = await session.run("e2e.plugin.reloadOwnedDevelopmentChat", {
      timeoutMs: 5000,
    });
    assert.deepEqual(reloaded, {
      reloaded: true,
      exactPluginIdentityPreserved: true,
      developmentOwnershipRestored: true,
    });
    assert.deepEqual(importedReceipt, receipt);

    const exact = await session.run("e2e.incident.assertCopiedReportExact");
    assert.equal(exact.exact, true);
    assert.equal(exact.reportId, reportId);
    assert.equal("serialized" in exact, false);
    assert.deepEqual(await session.run("e2e.console.assertNoErrors"), {
      exact: true,
      addedConsoleErrors: 0,
    });
  } finally {
    replacement?.close();
    owner?.close();
    session.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("DriverSession rejects stale executable code even when its manifest label matches", async () => {
  const pluginDir = makeTempPluginDir();
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
    systemsculptDevBuild: { id: "current-label" },
  }));
  const session = new DriverSession({ pluginDir, connectTimeoutMs: 1500, actionTimeoutMs: 1500 });
  let driver;
  try {
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    driver = connectFakeDriver(pluginDir, {
      artifactId: STALE_ARTIFACT_ID,
      buildStamp: "current-label",
    });
    const closed = new Promise((resolve) => driver.on("close", (code) => resolve(code)));
    await assert.rejects(
      connected,
      /Loaded plugin executable does not match the installed JavaScript bundle/,
    );
    assert.equal(await closed, 1008);
    await assert.rejects(session.run("status"), /not connected/);
  } finally {
    driver?.close();
    session.close();
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

test("DriverSession rejects a replacement socket without disturbing the owner", async () => {
  const pluginDir = makeTempPluginDir();
  const session = new DriverSession({ pluginDir, connectTimeoutMs: 1500, actionTimeoutMs: 1500 });
  let owner;
  let replacement;
  try {
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    owner = connectFakeDriver(pluginDir);
    await connected;

    replacement = connectFakeDriver(pluginDir);
    const closeCode = await new Promise((resolve) => {
      replacement.on("close", (code) => resolve(code));
    });
    assert.equal(closeCode, 1008);
    assert.deepEqual(await session.run("status"), { echoed: "status" });
  } finally {
    replacement?.close();
    owner?.close();
    session.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("DriverSession cancels a timed-out action before sending later diagnostics", async () => {
  const pluginDir = makeTempPluginDir();
  const session = new DriverSession({ pluginDir, connectTimeoutMs: 1500, actionTimeoutMs: 50 });
  const cancelled = [];
  let driver;
  try {
    const connected = session.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    driver = connectFakeDriver(pluginDir, {
      replies: { hanging: { defer: true } },
      onCancel: (id) => cancelled.push(id),
    });
    await connected;

    await assert.rejects(session.run("hanging"), /timed out after 50ms/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(cancelled, [1]);
    assert.deepEqual(await session.run("logs"), { echoed: "logs" });
  } finally {
    driver?.close();
    session.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("runScenario executes every cleanup step from its outer finally", async () => {
  const calls = [];
  const originalNow = Date.now;
  let nowCalls = 0;
  Date.now = () => {
    nowCalls += 1;
    if (nowCalls === 3) throw new Error("controlled runner failure");
    return originalNow();
  };
  try {
    await assert.rejects(
      runScenario({
        async run(action) {
          calls.push(action);
          return {};
        },
      }, {
        steps: [{ action: "owned.side-effect" }, { action: "unreached" }],
        cleanup: [
          { action: "cleanup.first" },
          { action: "cleanup.second" },
        ],
      }),
      /controlled runner failure/,
    );
  } finally {
    Date.now = originalNow;
  }
  assert.deepEqual(calls, [
    "owned.side-effect",
    "cleanup.first",
    "cleanup.second",
  ]);
});

test("runScenario continues cleanup after an action failure", async () => {
  const calls = [];
  const outcome = await runScenario({
    async run(action) {
      calls.push(action);
      if (action === "cleanup.first") throw new Error("cleanup failed");
      return { echoed: action };
    },
  }, {
    steps: [{ action: "status" }],
    cleanup: [
      { action: "cleanup.first" },
      { action: "cleanup.second" },
    ],
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(calls, ["status", "cleanup.first", "cleanup.second"]);
  assert.equal(outcome.cleanup[0].ok, false);
  assert.equal(outcome.cleanup[1].ok, true);
});
