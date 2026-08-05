import test from "node:test";
import assert from "node:assert/strict";

import makeAgentVaultToolRoundTrip from "../../testing/e2e/scenarios/agent-vault-tool-round-trip.mjs";
import makeAgentVaultToolStress from "../../testing/e2e/scenarios/agent-vault-tool-stress.mjs";
import makeChatLiveAcceptance from "./chatview-live-acceptance.mjs";

function stepByLabel(steps, label) {
  const step = steps.find((candidate) => candidate.label === label);
  assert.ok(step, `Missing scenario step: ${label}`);
  return step;
}

test("vault tool journeys use unique paths and exact completion markers", () => {
  const first = makeAgentVaultToolRoundTrip(1000);
  const second = makeAgentVaultToolRoundTrip(1001);
  const firstPrompt = stepByLabel(first, "submit a vault-tool prompt").params.text;
  const secondPrompt = stepByLabel(second, "submit a vault-tool prompt").params.text;
  assert.notEqual(firstPrompt, secondPrompt);
  assert.match(firstPrompt, /QA\/E2E\/round-trip-[A-Z0-9]+\.md/);
  assert.match(firstPrompt, /reply with exactly DONE-[A-Z0-9]+/);
  assert.equal(
    stepByLabel(first, "round-trip file has exact content").action,
    "vault.assertText",
  );

  const stressPrompt = stepByLabel(
    makeAgentVaultToolStress(2000),
    "submit a ~30 tool-call job",
  ).params.text;
  assert.match(stressPrompt, /QA\/Stress-[A-Z0-9]+/);
  assert.match(stressPrompt, /reply with exactly FINISHED-[A-Z0-9]+/);
  assert.equal(
    stepByLabel(makeAgentVaultToolStress(2000), "stress summary has exact content").action,
    "vault.assertText",
  );
});

test("normal live acceptance covers text, attachment, approval, and timing", () => {
  const steps = makeChatLiveAcceptance(3000);
  assert.equal(steps.filter((step) => step.action === "waitForRun").length, 4);
  assert.ok(steps.some((step) => step.label === "copy feedback"));
  assert.ok(steps.some((step) => step.label === "attachment content reached the response"));
  assert.ok(steps.some((step) => step.label === "approval is required"));
  assert.ok(steps.some((step) => step.label === "allow once"));
  assert.ok(steps.some((step) => step.label === "approval preview has the exact path"));
  assert.ok(steps.some((step) => step.label === "approval preview has the exact content"));
  assert.equal(
    stepByLabel(steps, "approval preview has the exact path").params.state,
    "textEquals",
  );
  assert.equal(
    stepByLabel(steps, "approval preview has the exact content").params.state,
    "textEquals",
  );
  assert.equal(
    stepByLabel(steps, "approved file has exact content").action,
    "vault.assertText",
  );
  const exactResponses = steps.filter((step) =>
    step.label === "expected response is visible"
    || step.label === "attachment content reached the response"
    || step.label === "expected completion marker");
  assert.equal(exactResponses.length, 3);
  assert.ok(exactResponses.every((step) => step.params.state === "textEquals"));
  assert.equal(
    stepByLabel(steps, "wait for approval or terminal").params.returnOnApproval,
    true,
  );
  assert.equal(steps.filter((step) => step.resumeAfterFailure === true).length, 4);
  assert.ok(steps.every((step) => step.action !== "waitForRun" || step.params.stallMs > 0));
});
