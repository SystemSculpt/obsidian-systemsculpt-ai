import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

function workflowText(name) {
  return fs.readFileSync(path.join(process.cwd(), ".github", "workflows", name), "utf8");
}

function indexOfRequired(text, needle) {
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `Expected workflow to contain: ${needle}`);
  return index;
}

for (const workflowName of fs.readdirSync(path.join(process.cwd(), ".github", "workflows")).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))) {
  test(`${workflowName} parses as YAML`, () => {
    assert.doesNotThrow(() => YAML.parse(workflowText(workflowName)));
  });
}

test("Windows E2E workflow keeps the canonical build, bootstrap, clean-install, baselines order", () => {
  const text = workflowText("windows-e2e.yml");

  assert.match(text, /^\s*windows-e2e:/m);
  assert.match(text, /^\s*name: windows-e2e$/m);
  assert.match(text, /runs-on: windows-2025-vs2026/);
  assert.match(text, /XAI_API_KEY: \$\{\{ secrets\.XAI_API_KEY \}\}/);
  assert.match(text, /--skip-trust-prompt/);

  const build = indexOfRequired(text, "npm run build");
  const bootstrap = indexOfRequired(text, "node testing/native/device/windows/bootstrap.mjs");
  const cleanInstall = indexOfRequired(text, "node testing/native/device/windows/run-clean-install-parity.mjs");
  const baselines = indexOfRequired(text, "npm run test:native:windows:baselines");

  assert.ok(build < bootstrap, "build must happen before bootstrap copies artifacts");
  assert.ok(bootstrap < cleanInstall, "bootstrap must launch the vault before clean-install parity");
  assert.ok(cleanInstall < baselines, "baselines must reuse the clean-install vault");
});

test("iOS canary workflow stays self-hosted, trusted, and ordered", () => {
  const text = workflowText("ios-canary.yml");

  assert.match(text, /^\s*ios-canary:/m);
  assert.match(text, /ios-canary-release/);
  assert.match(text, /ios-canary-ad-hoc/);
  assert.match(text, /runs-on: \[self-hosted, macOS, ios-canary\]/);
  assert.doesNotMatch(text, /^\s*pull_request:/m);
  assert.match(text, /SYSTEMSCULPT_IOS_SYNC_CONFIG_B64: \$\{\{ secrets\.SYSTEMSCULPT_IOS_SYNC_CONFIG_B64 \}\}/);
  assert.match(text, /SYSTEMSCULPT_RUNTIME_SMOKE_LICENSE_KEY: \$\{\{ secrets\.SYSTEMSCULPT_E2E_LICENSE_KEY \}\}/);
  assert.match(text, /Require iOS canary secrets/);
  assert.match(text, /\$\{\{ env\.IOS_CANARY_DIR \}\}\/preflight\.json/);
  assert.match(text, /\$\{\{ env\.IOS_CANARY_DIR \}\}\/runtime-smoke\.json/);
  assert.doesNotMatch(text, /preflight\.raw\.json\s*$/m);
  assert.doesNotMatch(text, /runtime-smoke\.raw\.json\s*$/m);
  assert.doesNotMatch(text, /^\s+\$\{\{ runner\.temp \}\}\/systemsculpt-ios-canary$/m);
  assert.match(text, /sanitize-canary-diagnostics\.mjs --preflight/);
  assert.match(text, /sanitize-canary-diagnostics\.mjs --runtime/);
  assert.match(text, /--require-hosted-auth/);
  assert.match(text, /Remove iOS canary temp files/);

  const build = indexOfRequired(text, "npm run build");
  const requireSecrets = indexOfRequired(text, "Require iOS canary secrets");
  const host = indexOfRequired(text, "npm --silent run test:native:ios:canary:preflight -- --config");
  const sync = indexOfRequired(text, "npm run test:native:ios:debug:open -- --config");
  const inspect = indexOfRequired(text, "npm run test:native:ios:inspect:plugin -- --strict");
  const smoke = indexOfRequired(text, "npm run test:native:ios -- --case");

  assert.ok(build < host, "plugin must build before host/device verification");
  assert.ok(build < requireSecrets, "build must happen before canary secret validation");
  assert.ok(requireSecrets < host, "canary secrets must be present before host/device verification");
  assert.ok(host < sync, "host/device verification must happen before sync/relaunch");
  assert.ok(sync < inspect, "sync/relaunch must happen before plugin inspection");
  assert.ok(inspect < smoke, "plugin inspection must happen before runtime smoke");
});
