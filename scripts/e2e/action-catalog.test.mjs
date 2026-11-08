import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DRIVER_CLI_COMMANDS,
  SUPPORTED_DRIVER_ACTIONS,
} from "../../src/testing/driver/actionCatalog.js";
import { stepsForVerb } from "./e2e.mjs";

const cliPath = fileURLToPath(new URL("./e2e.mjs", import.meta.url));
const PUBLIC_VERBS = [
  "status", "open-chat", "click", "type", "press", "attach", "scroll", "select",
  "read", "query", "logs", "notices", "snapshot", "wait", "wait-run", "command",
  "tool-lifecycle-start", "tool-lifecycle", "tool-lifecycle-end", "assert-tool-settled",
  "assert-tool-results-completed", "assert-no-client-tools", "settings", "settings-close",
  "targets", "script",
];

const CLI_ARGUMENTS = {
  click: ["chat.header.new"],
  type: ["Hello from the catalog test"],
  press: ["Enter"],
  attach: [cliPath],
  scroll: ["top"],
  select: ["setting:Default chat font size", "large"],
  read: ["chat.composer.input"],
  query: ["css:.systemsculpt-agent-turn"],
  wait: ["chat.composer.send", "enabled"],
  command: ["systemsculpt-ai:open-chat"],
};

const ASSERTION_FLAGS = { "tool-label": "Read files", text: "Done" };

test("the shared catalog preserves every public CLI verb without aliases colliding", () => {
  const verbs = DRIVER_CLI_COMMANDS.map(({ verb }) => verb);
  assert.equal(new Set(verbs).size, verbs.length);
  assert.deepEqual([...verbs].sort(), [...PUBLIC_VERBS].sort());
  assert.deepEqual(
    DRIVER_CLI_COMMANDS.filter(({ action }) => action === undefined).map(({ verb }) => verb),
    ["script"],
  );
});

test("every catalog CLI alias produces its supported action with existing argument handling", () => {
  for (const { action, verb } of DRIVER_CLI_COMMANDS) {
    if (!action) continue;
    assert.ok(Object.hasOwn(SUPPORTED_DRIVER_ACTIONS, action), verb);
    const steps = stepsForVerb([verb, ...CLI_ARGUMENTS[verb] ?? []], ASSERTION_FLAGS);
    assert.deepEqual(steps.map((step) => step.action), [action], verb);
  }

  assert.deepEqual(stepsForVerb(["type", "Hello", "world"], { append: true, submit: true }), [{
    action: "type",
    params: { text: "Hello world", target: undefined, mode: "append", submit: true },
  }]);
  assert.deepEqual(stepsForVerb(["wait-run"], { timeout: "123", stall: "45" }), [{
    action: "waitForRun",
    params: { timeoutMs: 123, stallMs: 45 },
  }]);
});

test("CLI help derives every usage from the same supported catalog without connecting", () => {
  const help = spawnSync(process.execPath, [cliPath, "status", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  const usages = /^Verbs: (.+)$/mu.exec(help.stdout)?.[1].split(", ");
  assert.deepEqual(usages, DRIVER_CLI_COMMANDS.map(({ usage }) => usage));
  assert.ok(usages.includes("targets [--live]"));
  assert.ok(usages.includes("script <file>"));
});

test("unknown CLI errors enumerate the catalog before attempting target resolution", () => {
  const unknown = spawnSync(process.execPath, [cliPath, "not-a-driver-verb"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "");
  assert.equal(
    unknown.stderr.trim(),
    `[e2e] Unknown verb "not-a-driver-verb". Verbs: ${DRIVER_CLI_COMMANDS.map(({ verb }) => verb).join(", ")}.`,
  );
});
