import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const liveScripts = Object.entries(packageJson.scripts).filter(([name]) =>
  name.startsWith("qa:chatview:live"),
);

test("every guarded live QA phase resolves to a real scenario module", async () => {
  assert.ok(liveScripts.length > 0, "expected qa:chatview:live scripts");
  for (const [name, command] of liveScripts) {
    const match = /e2e\.mjs script (\S+\.mjs)/.exec(command);
    assert.ok(match, `${name} must run a scenario through scripts/e2e/e2e.mjs`);
    const scenarioPath = path.join(root, match[1]);
    assert.equal(fs.existsSync(scenarioPath), true, `${name}: ${match[1]} must exist`);
    const module = await import(pathToFileURL(scenarioPath).href);
    assert.equal(
      Object.values(module).some((value) => value !== undefined && value !== null),
      true,
      `${name}: ${match[1]} must export a scenario`,
    );
  }
});

test("response failure recovery covers Retry, incident copy, reload, and console cleanliness", async () => {
  const module = await import("./chatview-live-response-failure-recovery.mjs");
  const scenario = module.makeChatLiveResponseFailureRecovery(1_786_579_200_000);
  const actions = scenario.steps.map((step) => step.action);
  const labels = scenario.steps.map((step) => step.label);

  assert.equal(actions.filter((action) => action === "chat.waitForDevelopmentRun").length, 3);
  assert.equal(actions.filter((action) => action === "e2e.incident.captureCopiedReport").length, 1);
  assert.equal(actions.filter((action) => action === "e2e.incident.assertCopiedReportExact").length, 1);
  assert.equal(actions.filter((action) => action === "e2e.plugin.reloadOwnedDevelopmentChat").length, 1);
  assert.equal(actions.filter((action) => action === "e2e.console.assertNoErrors").length, 1);
  assert.equal(scenario.cleanup.at(-1).action, "e2e.console.assertNoErrors");
  assert.ok(labels.includes("Retry resubmits the failed turn"));
  assert.ok(labels.includes("copy report enters its preparing state immediately"));
  assert.ok(labels.includes("reload preserves the exact canonical copied report bytes"));

  const capture = scenario.steps.find((step) =>
    step.action === "e2e.incident.captureCopiedReport");
  assert.ok(capture.params.forbiddenStrings.includes(module.RESPONSE_FAILURE_MARKER));
  assert.ok(capture.params.forbiddenStrings.includes(module.RESPONSE_FAILURE_PARTIAL_MARKER));
  assert.ok(capture.params.forbiddenStrings.includes(module.RESPONSE_FAILURE_RECOVERY_MARKER));
});
