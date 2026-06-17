import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSanitizedCanaryDiagnostics,
  sanitizePreflightDiagnostics,
  sanitizeRuntimeSmokeDiagnostics,
} from "./sanitize-canary-diagnostics.mjs";

test("sanitizePreflightDiagnostics keeps readiness facts and strips paths/device identity", () => {
  const sanitized = sanitizePreflightDiagnostics({
    ok: true,
    config: {
      path: "/Users/michael/Vault/.obsidian/plugins/systemsculpt-ai/systemsculpt-sync.ios.json",
      pluginTargets: 1,
      mirrorTargets: 2,
    },
    tools: {
      xcodePath: "/Applications/Xcode.app/Contents/Developer",
      xcrunPath: "/usr/bin/xcrun",
      remotedebugIosWebkitAdapterPath: "/opt/homebrew/bin/remotedebug_ios_webkit_adapter",
    },
    device: {
      label: "Michael's iPad",
      identifier: "00008101-0011223344556677",
      udid: "00008101-0011223344556677",
      platform: "iPadOS",
      osVersion: "18.5",
      transportType: "wired",
      developerModeStatus: "enabled",
    },
  });

  assert.deepEqual(sanitized, {
    ok: true,
    config: {
      pluginTargets: 1,
      mirrorTargets: 2,
    },
    tools: {
      xcode: true,
      xcrun: true,
      webkitAdapter: true,
    },
    device: {
      platform: "iPadOS",
      osVersion: "18.5",
      transportType: "wired",
      tunnelState: null,
      developerModeStatus: "enabled",
    },
  });
  assert.equal(JSON.stringify(sanitized).includes("Michael"), false);
  assert.equal(JSON.stringify(sanitized).includes("00008101"), false);
  assert.equal(JSON.stringify(sanitized).includes("/Users/"), false);
});

test("sanitizeRuntimeSmokeDiagnostics summarizes cases without URLs or fixture paths", () => {
  const sanitized = sanitizeRuntimeSmokeDiagnostics({
    mode: "ios",
    jsonUrl: "http://127.0.0.1:9000/json",
    targetUrl: "http://127.0.0.1:9000/page/1",
    fixtureDir: "/Users/michael/Vault/SystemSculpt/QA",
    hostedAuthBootstrapped: true,
    repeat: 1,
    iterations: [
      {
        iteration: 1,
        results: {
          "chat-exact": {
            ok: true,
            attemptsUsed: 1,
            durationMs: 321,
            text: "ok",
          },
        },
      },
    ],
  });

  assert.deepEqual(sanitized, {
    mode: "ios",
    hostedAuthBootstrapped: true,
    repeat: 1,
    iterations: [
      {
        iteration: 1,
        cases: [
          {
            name: "chat-exact",
            ok: true,
            attemptsUsed: 1,
            durationMs: 321,
          },
        ],
      },
    ],
  });
  assert.equal(JSON.stringify(sanitized).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(sanitized).includes("/Users/"), false);
});

test("buildSanitizedCanaryDiagnostics creates a stable combined artifact shape", () => {
  const sanitized = buildSanitizedCanaryDiagnostics({
    preflight: { ok: true },
    runtime: { mode: "ios", iterations: [] },
  });

  assert.equal(sanitized.schemaVersion, 1);
  assert.equal(sanitized.preflight.ok, true);
  assert.equal(sanitized.runtime.mode, "ios");
});
