/**
 * End-to-end proof that a turn actually completes, including the client-tool
 * round trip.
 *
 * A text-only prompt exercises none of the client-tool path, so it stays green
 * while tool delivery is broken. This scenario therefore makes the model write
 * a uniquely named vault file through the guarded development-state driver.
 * The driver owns the temporary chat, requires exact Ask Approval consent,
 * records the live tool lifecycle, and cleans only the marker-owned artifacts.
 */

import {
  LATEST_DURABLE_ASSISTANT_TEXT,
  makeDevelopmentContext,
  withOwnedDevelopmentState,
} from "../../../scripts/e2e/chatview-development-state.mjs";

export { LATEST_DURABLE_ASSISTANT_TEXT } from "../../../scripts/e2e/chatview-development-state.mjs";

const STALL_MS = 60000;
const RUN_TIMEOUT_MS = 180000;

export default function makeAgentVaultToolRoundTrip(now = Date.now()) {
  const context = makeDevelopmentContext("", now);
  const filePath = `${context.markerRoot}/round-trip.md`;
  const completionMarker = `DONE-${context.runId}`;
  return withOwnedDevelopmentState(context, [
      {
        label: "submit a vault-tool prompt",
        action: "chat.typeDevelopmentDraft",
        params: {
          text: `Create exactly one file at ${filePath} containing exactly ${context.runId}. `
            + `Use your vault tools. Then reply with exactly ${completionMarker}.`,
          submit: true,
        },
      },
      {
        label: "approval is required",
        action: "chat.waitForDevelopmentRun",
        params: { until: "approval", timeoutMs: RUN_TIMEOUT_MS },
      },
      {
        label: "allow exact write once",
        action: "chat.approveDevelopmentWriteOnce",
        params: { path: filePath, text: context.runId },
      },
      {
        label: "run completes without stalling",
        action: "chat.waitForDevelopmentRun",
        params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
      },
      {
        label: "tool settles before continuation",
        action: "chat.assertLatestToolSettledAfterContinuation",
        params: {
          toolLabel: "Write file",
          text: completionMarker,
          textMode: "contains",
          requireCommandAck: true,
          timeoutMs: STALL_MS,
        },
      },
      {
        label: "expected completion marker",
        action: "waitFor",
        params: {
          target: LATEST_DURABLE_ASSISTANT_TEXT,
          state: "textContains",
          text: completionMarker,
          timeoutMs: 5000,
        },
      },
      {
        label: "round-trip file has exact content",
        action: "vault.assertText",
        params: { path: filePath, text: context.runId },
      },
      { label: "transcript", action: "snapshot", params: { scope: "chat" } },
      {
        label: "no error banner",
        action: "waitFor",
        params: {
          target: "chat:.systemsculpt-agent-banner",
          state: "hidden",
          timeoutMs: 2000,
        },
      },
  ]);
}
