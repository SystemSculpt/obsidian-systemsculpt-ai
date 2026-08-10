/**
 * Visible local-fixture acceptance for invalid client-tool arguments.
 *
 * The matching local Worker fixture, never this prompt, deterministically emits
 * invalid `read {}` and `list_items {}` calls and then the exact correction
 * marker. The plugin must not render, execute, send, or acknowledge either
 * rejected call.
 */

import {
  LATEST_DURABLE_ASSISTANT_TEXT,
  makeDevelopmentContext,
  withOwnedDevelopmentState,
} from "./chatview-development-state.mjs";

export const INVALID_CLIENT_TOOLS_MARKER = "INVALID-TOOLS-CORRECTED-V1";
const RUN_TIMEOUT_MS = 180000;

export function makeChatLiveInvalidClientTools(now = Date.now()) {
  const context = makeDevelopmentContext("I", now);
  return withOwnedDevelopmentState(context, [
    {
      label: "tool capture is active before fixture submit",
      action: "chat.toolLifecycle",
    },
    {
      label: "submit one ordinary fixture turn",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: "Reply briefly after handling this request.",
        submit: true,
      },
    },
    {
      label: "invalid-call correction run completes",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: "invalid calls never reach the client tool surface",
      action: "chat.assertNoClientToolsBeforeContinuation",
      params: { text: INVALID_CLIENT_TOOLS_MARKER, timeoutMs: 10000 },
    },
    {
      label: "corrected continuation is exact and durable",
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textEquals",
        text: INVALID_CLIENT_TOOLS_MARKER,
        timeoutMs: 5000,
      },
    },
    {
      label: "invalid correction has no response-failure banner",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    {
      label: "reopen exact invalid-correction chat through visible history",
      action: "chat.reopenOwnedDevelopmentHistory",
      params: { timeoutMs: 10000 },
    },
    {
      label: "reopened invalid-correction response remains exact",
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textEquals",
        text: INVALID_CLIENT_TOOLS_MARKER,
        timeoutMs: 5000,
      },
    },
    {
      label: "reopened invalid-correction transcript has no tool cards",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    {
      label: "reopened invalid correction has no response-failure banner",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    {
      label: "invalid-correction transcript",
      action: "snapshot",
      params: { scope: "chat" },
    },
  ]);
}

export default makeChatLiveInvalidClientTools();
