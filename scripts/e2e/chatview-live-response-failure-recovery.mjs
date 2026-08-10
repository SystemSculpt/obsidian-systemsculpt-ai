/**
 * Visible local-fixture acceptance for a genuine response-level failure and
 * a successful follow-up in the same authoritative chat.
 */

import {
  LATEST_DURABLE_ASSISTANT_TEXT,
  makeDevelopmentContext,
  withOwnedDevelopmentState,
} from "./chatview-development-state.mjs";

export const RESPONSE_FAILURE_MARKER = "RESPONSE-FAILURE-V1";
export const RESPONSE_FAILURE_RECOVERY_MARKER =
  "RESPONSE-FAILURE-RECOVERED-V1";
export const RESPONSE_FAILURE_VISIBLE_MESSAGE =
  "SystemSculpt could not complete the response.";

const RUN_TIMEOUT_MS = 180000;
const ANIMATED_RUN_INDICATORS =
  "chat:.systemsculpt-agent-tail-status-icon.is-animated, "
  + ".systemsculpt-agent-tool-icon.is-animated";
const LATEST_ASSISTANT_ERROR =
  "chat:.systemsculpt-agent-turn.is-assistant:last-child "
  + ".systemsculpt-agent-part.is-error";

export function makeChatLiveResponseFailureRecovery(now = Date.now()) {
  const context = makeDevelopmentContext("F", now);
  return withOwnedDevelopmentState(context, [
    {
      label: "submit deterministic response failure",
      action: "chat.typeDevelopmentDraft",
      params: { text: RESPONSE_FAILURE_MARKER, submit: true },
    },
    {
      label: "failed response reaches a terminal run",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: "one response-wide terminal error is visible",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-error",
        state: "exists",
        timeoutMs: 5000,
      },
    },
    {
      label: "failed response heading is exact",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-error-heading",
        state: "textEquals",
        text: "Could not finish",
        timeoutMs: 5000,
      },
    },
    {
      label: "failed response message is exact",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-error-message",
        state: "textEquals",
        text: RESPONSE_FAILURE_VISIBLE_MESSAGE,
        timeoutMs: 5000,
      },
    },
    {
      label: "failed response has no active tail",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-tail-status",
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "failed response has no animated indicators",
      action: "waitFor",
      params: {
        target: ANIMATED_RUN_INDICATORS,
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "Stop is hidden after response failure",
      action: "waitFor",
      params: {
        target: "chat.composer.stop",
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "composer unlocks after response failure",
      action: "waitFor",
      params: {
        target: "chat.composer.input",
        state: "enabled",
        timeoutMs: 5000,
      },
    },
    {
      label: "response terminal does not become a transport banner",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    {
      label: "failed response visible transcript",
      action: "snapshot",
      params: { scope: "chat" },
    },
    {
      label: "submit same-chat response recovery",
      action: "chat.typeDevelopmentDraft",
      params: { text: RESPONSE_FAILURE_RECOVERY_MARKER, submit: true },
    },
    {
      label: "same-chat recovery reaches a terminal run",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: "same-chat recovery marker is exact and durable",
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textEquals",
        text: RESPONSE_FAILURE_RECOVERY_MARKER,
        timeoutMs: 5000,
      },
    },
    {
      label: "recovery assistant is not active",
      action: "waitFor",
      params: {
        target:
          "chat:.systemsculpt-agent-turn.is-assistant:last-child.is-active",
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "recovery adds no response-wide terminal error",
      action: "waitFor",
      params: {
        target: LATEST_ASSISTANT_ERROR,
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "recovery has no active tail",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-tail-status",
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "recovery has no animated indicators",
      action: "waitFor",
      params: {
        target: ANIMATED_RUN_INDICATORS,
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "Stop stays hidden after recovery",
      action: "waitFor",
      params: {
        target: "chat.composer.stop",
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "composer remains unlocked after recovery",
      action: "waitFor",
      params: {
        target: "chat.composer.input",
        state: "enabled",
        timeoutMs: 5000,
      },
    },
    {
      label: "recovery has no tool cards",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    {
      label: "recovered response visible transcript",
      action: "snapshot",
      params: { scope: "chat" },
    },
  ]);
}

export default makeChatLiveResponseFailureRecovery();
