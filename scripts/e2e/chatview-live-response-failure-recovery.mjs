/**
 * Visible local-fixture acceptance for response failure, Retry, canonical
 * incident copying, successful recovery, and exact durability across reload.
 */

import {
  LATEST_DURABLE_ASSISTANT_TEXT,
  makeDevelopmentContext,
  withOwnedDevelopmentState,
} from "./chatview-development-state.mjs";

export const RESPONSE_FAILURE_MARKER = "RESPONSE-FAILURE-V1";
export const RESPONSE_FAILURE_PARTIAL_MARKER = "RESPONSE-FAILURE-PARTIAL-V1";
export const RESPONSE_FAILURE_RECOVERY_MARKER =
  "RESPONSE-FAILURE-RECOVERED-V1";
export const RESPONSE_FAILURE_VISIBLE_MESSAGE =
  "SystemSculpt could not complete the response.";

const RUN_TIMEOUT_MS = 180000;
const RELOAD_TIMEOUT_MS = 60000;
const ANIMATED_RUN_INDICATORS =
  "chat:.systemsculpt-agent-tail-status-icon.is-animated, "
  + ".systemsculpt-agent-tool-icon.is-animated";
const LATEST_ASSISTANT_ERROR =
  "chat:.systemsculpt-agent-turn.is-assistant:last-child "
  + ".systemsculpt-agent-part.is-error";
const FAILED_PARTIAL_AFTER_RELOAD =
  "chat:.systemsculpt-agent-history"
  + " > .systemsculpt-agent-turn.is-assistant:has(.systemsculpt-agent-part.is-error)"
  + " > .systemsculpt-agent-turn-body"
  + " > .systemsculpt-agent-part.is-text";
const OPEN_CHAT_DRAWERS = "chat:.systemsculpt-agent-turn details[open]";

function failureTerminalSteps(prefix) {
  return [
    {
      label: `${prefix} reaches a terminal run`,
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: `${prefix} retains the exact partial assistant text`,
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textEquals",
        text: RESPONSE_FAILURE_PARTIAL_MARKER,
        timeoutMs: 10000,
      },
    },
    {
      label: `${prefix} shows one failed response card`,
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-error",
        state: "exists",
        timeoutMs: 10000,
      },
    },
    {
      label: `${prefix} heading is exact`,
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-error-heading",
        state: "textEquals",
        text: "Could not finish",
        timeoutMs: 5000,
      },
    },
    {
      label: `${prefix} message is exact`,
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-error-message",
        state: "textEquals",
        text: RESPONSE_FAILURE_VISIBLE_MESSAGE,
        timeoutMs: 5000,
      },
    },
    {
      label: `${prefix} Retry action is ready`,
      action: "waitFor",
      params: {
        target: "chat.turn.retry-failed",
        state: "textEquals",
        text: "Retry",
        timeoutMs: 10000,
      },
    },
    {
      label: `${prefix} leaves every drawer closed`,
      action: "waitFor",
      params: {
        target: OPEN_CHAT_DRAWERS,
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    {
      label: `${prefix} has no active tail`,
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-tail-status",
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: `${prefix} has no animated indicators`,
      action: "waitFor",
      params: {
        target: ANIMATED_RUN_INDICATORS,
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: `${prefix} unlocks the composer`,
      action: "waitFor",
      params: {
        target: "chat.composer.input",
        state: "enabled",
        timeoutMs: 5000,
      },
    },
    {
      label: `${prefix} does not become a transport banner`,
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
  ];
}

function reportCanaries(context) {
  return [
    context.marker,
    RESPONSE_FAILURE_MARKER,
    RESPONSE_FAILURE_PARTIAL_MARKER,
    RESPONSE_FAILURE_RECOVERY_MARKER,
    RESPONSE_FAILURE_VISIBLE_MESSAGE,
  ];
}

export function makeChatLiveResponseFailureRecovery(now = Date.now()) {
  const context = makeDevelopmentContext("F", now);
  const canaries = reportCanaries(context);
  const scenario = withOwnedDevelopmentState(context, [
    {
      label: "submit deterministic response failure",
      action: "chat.typeDevelopmentDraft",
      params: { text: RESPONSE_FAILURE_MARKER, submit: true },
    },
    ...failureTerminalSteps("first failed response"),
    {
      label: "first failed response visible transcript",
      action: "snapshot",
      params: { scope: "chat" },
    },
    {
      label: "Retry resubmits the failed turn",
      action: "click",
      params: { target: "chat.turn.retry-failed" },
    },
    ...failureTerminalSteps("retried failed response"),
    {
      label: "local incident report action becomes available",
      action: "waitFor",
      params: {
        target: "chat.turn.copy-incident-report",
        state: "textEquals",
        text: "Copy report",
        timeoutMs: 15000,
      },
    },
    {
      label: "copy report enters its preparing state immediately",
      action: "click",
      params: {
        target: "chat.turn.copy-incident-report",
        immediateTextEquals: "Preparing…",
      },
    },
    {
      label: "copy report reaches its ready state",
      action: "waitFor",
      params: {
        target: "chat.turn.copy-incident-report",
        state: "textEquals",
        text: "Copied",
        timeoutMs: 15000,
      },
    },
    {
      label: "copied report is canonical, private, rendered, painted, and persisted",
      action: "e2e.incident.captureCopiedReport",
      params: { forbiddenStrings: canaries },
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
        timeoutMs: 10000,
      },
    },
    {
      label: "recovery assistant is not active",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-turn.is-assistant:last-child.is-active",
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
      label: "recovery leaves every drawer closed",
      action: "waitFor",
      params: {
        target: OPEN_CHAT_DRAWERS,
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    {
      label: "recovered response visible transcript",
      action: "snapshot",
      params: { scope: "chat" },
    },
    {
      label: "reload the plugin and restore exact development ownership",
      action: "e2e.plugin.reloadOwnedDevelopmentChat",
      params: { timeoutMs: RELOAD_TIMEOUT_MS },
    },
    {
      label: "reload preserves the failed partial assistant text",
      action: "waitFor",
      params: {
        target: FAILED_PARTIAL_AFTER_RELOAD,
        state: "textEquals",
        text: RESPONSE_FAILURE_PARTIAL_MARKER,
        timeoutMs: 15000,
      },
    },
    {
      label: "reload preserves the successful recovery response",
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textEquals",
        text: RESPONSE_FAILURE_RECOVERY_MARKER,
        timeoutMs: 15000,
      },
    },
    {
      label: "reload restores the failed report action",
      action: "waitFor",
      params: {
        target: "chat.turn.copy-incident-report",
        state: "textEquals",
        text: "Copy report",
        timeoutMs: 15000,
      },
    },
    {
      label: "reloaded report copy enters its preparing state immediately",
      action: "click",
      params: {
        target: "chat.turn.copy-incident-report",
        immediateTextEquals: "Preparing…",
      },
    },
    {
      label: "reloaded report copy reaches its ready state",
      action: "waitFor",
      params: {
        target: "chat.turn.copy-incident-report",
        state: "textEquals",
        text: "Copied",
        timeoutMs: 15000,
      },
    },
    {
      label: "reload preserves the exact canonical copied report bytes",
      action: "e2e.incident.assertCopiedReportExact",
      params: { forbiddenStrings: canaries },
    },
    {
      label: "reload leaves every drawer closed",
      action: "waitFor",
      params: {
        target: OPEN_CHAT_DRAWERS,
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    {
      label: "reloaded response visible transcript",
      action: "snapshot",
      params: { scope: "chat" },
    },
    {
      label: "workflow adds zero console errors before cleanup",
      action: "e2e.console.assertNoErrors",
    },
  ]);
  return {
    ...scenario,
    steps: [
      {
        label: "baseline existing console errors",
        action: "e2e.console.baseline",
      },
      ...scenario.steps,
    ],
    cleanup: [
      ...scenario.cleanup.map((step) => step.action === "chat.resetDevelopmentState"
        ? {
            ...step,
            action: "e2e.chat.resetOwnedDevelopmentState",
            params: { ...step.params, timeoutMs: RELOAD_TIMEOUT_MS },
          }
        : step),
      {
        label: "workflow adds zero console errors after cleanup",
        action: "e2e.console.assertNoErrors",
      },
    ],
  };
}

export default makeChatLiveResponseFailureRecovery();
