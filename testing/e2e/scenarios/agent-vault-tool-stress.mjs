/**
 * Guarded current-run stress: one approved seed write followed by exactly
 * thirty sequential read calls in a single assistant run.
 *
 * The declared action waits total 276 seconds and emit stall evidence after
 * 30 seconds without visible progress. The scenario runner does not enforce a
 * single wall-clock deadline or a provider/credit budget; the invocation must
 * separately pin the loaded artifact to the intended loopback API. Cleanup can
 * trash only the exact approved seed file beneath this run's unique marker.
 */

import {
  LATEST_DURABLE_ASSISTANT_TEXT,
  makeDevelopmentContext,
  withOwnedDevelopmentState,
} from "../../../scripts/e2e/chatview-development-state.mjs";

const SEED_APPROVAL_TIMEOUT_MS = 45000;
const SEED_RUN_TIMEOUT_MS = 60000;
const STRESS_RUN_TIMEOUT_MS = 120000;
const STALL_MS = 30000;
const TOOL_SETTLEMENT_TIMEOUT_MS = 15000;
const DURABILITY_TIMEOUT_MS = 2000;
const STRESS_TOOL_CALLS = 30;
export default function makeAgentVaultToolStress(now = Date.now()) {
  const context = makeDevelopmentContext("S", now);
  const seedPath = `${context.markerRoot}/stress-seed.md`;
  const seedContent = `STRESS-SEED-${context.runId}`;
  const seedCompletionMarker = `STRESS-READY-${context.runId}`;
  const completionMarker = `STRESS-FINISHED-${context.runId}`;
  return withOwnedDevelopmentState(context, [
      {
        label: "submit exact stress seed write",
        action: "chat.typeDevelopmentDraft",
        params: {
          text: `Create exactly one file at ${seedPath} containing exactly ${seedContent}. `
            + `Use your vault tools. Then reply with exactly ${seedCompletionMarker}.`,
          submit: true,
        },
      },
      {
        label: "stress seed approval is required",
        action: "chat.waitForDevelopmentRun",
        params: { until: "approval", timeoutMs: SEED_APPROVAL_TIMEOUT_MS },
      },
      {
        label: "allow exact stress seed write once",
        action: "chat.approveDevelopmentWriteOnce",
        params: { path: seedPath, text: seedContent },
      },
      {
        label: "stress seed run completes",
        action: "chat.waitForDevelopmentRun",
        params: { until: "complete", timeoutMs: SEED_RUN_TIMEOUT_MS },
      },
      {
        label: "stress seed tool settles before continuation",
        action: "chat.assertLatestToolSettledAfterContinuation",
        params: {
          toolLabel: "Write file",
          text: seedCompletionMarker,
          textMode: "contains",
          expectedState: "succeeded",
          expectedStateLabel: "Done",
          requireCommandAck: true,
          requireAllToolResultAcks: true,
          expectedAllToolResultState: "succeeded",
          timeoutMs: TOOL_SETTLEMENT_TIMEOUT_MS,
        },
      },
      {
        label: "stress seed completion is durable",
        action: "waitFor",
        params: {
          target: LATEST_DURABLE_ASSISTANT_TEXT,
          state: "textContains",
          text: seedCompletionMarker,
          timeoutMs: DURABILITY_TIMEOUT_MS,
        },
      },
      {
        label: "stress seed has exact content",
        action: "vault.assertText",
        params: { path: seedPath, text: seedContent },
      },
      {
        label: "submit exactly 30 sequential current-run reads",
        action: "chat.typeDevelopmentDraft",
        params: {
          text: [
            `Call the read vault tool exactly ${STRESS_TOOL_CALLS} separate times in this run.`,
            `Every call must contain one paths array with only ${JSON.stringify(seedPath)}.`,
            "Do not batch multiple reads into one call and do not use any other tool.",
            "Issue each call only after the previous call result is acknowledged.",
            "Do not emit response text before every read is complete.",
            `After all ${STRESS_TOOL_CALLS} results, reply with exactly ${completionMarker}.`,
          ].join(" "),
          submit: true,
        },
      },
      {
        label: "stress run completes with bounded stall evidence",
        action: "waitForRun",
        params: {
          timeoutMs: STRESS_RUN_TIMEOUT_MS,
          stallMs: STALL_MS,
          approve: false,
        },
      },
      {
        label: "exactly 30 sequential reads are terminal before exact continuation",
        action: "chat.assertExactSequentialToolPlan",
        params: {
          tools: Array.from({ length: STRESS_TOOL_CALLS }, () => ({
            name: "read",
            input: { paths: [seedPath] },
          })),
          text: completionMarker,
          textMode: "contains",
          requireNoOtherText: false,
          timeoutMs: TOOL_SETTLEMENT_TIMEOUT_MS,
        },
      },
      {
        label: "all stress tool result sends complete after continuation",
        action: "chat.assertAllToolResultSendsCompleted",
        params: {
          toolLabel: "Read 1 file",
          text: completionMarker,
          textMode: "contains",
          timeoutMs: TOOL_SETTLEMENT_TIMEOUT_MS,
        },
      },
      {
        label: "stress completion marker is durable",
        action: "waitFor",
        params: {
          target: LATEST_DURABLE_ASSISTANT_TEXT,
          state: "textContains",
          text: completionMarker,
          timeoutMs: DURABILITY_TIMEOUT_MS,
        },
      },
      { label: "stress lifecycle evidence", action: "chat.toolLifecycle" },
      { label: "stress transcript", action: "snapshot", params: { scope: "chat" } },
      {
        label: "no response-failure banner",
        action: "waitFor",
        params: {
          target: "chat:.systemsculpt-agent-banner",
          state: "hidden",
          timeoutMs: 2000,
        },
      },
      {
        label: "stress turn remains exact through its final paint boundary",
        action: "chat.assertExactToolPlanCleanClose",
        params: {},
      },
  ]);
}
