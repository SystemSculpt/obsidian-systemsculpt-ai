import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function workflowText(name) {
  return fs.readFileSync(path.join(process.cwd(), ".github", "workflows", name), "utf8");
}

function indexOfRequired(text, needle) {
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `Expected workflow to contain: ${needle}`);
  return index;
}

test("Windows E2E workflow keeps the canonical build, bootstrap, clean-install, baselines order", () => {
  const text = workflowText("windows-e2e.yml");

  assert.match(text, /^\s*windows-e2e:/m);
  assert.match(text, /^\s*name: windows-e2e$/m);
  assert.match(text, /runs-on: windows-latest/);
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
