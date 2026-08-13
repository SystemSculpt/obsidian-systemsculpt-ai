/**
 * Guarded, visible ChatView acceptance journeys.
 *
 * Every factory owns a fresh development-test chat, keeps Ask Approval active,
 * and cleans only its exact marker root and saved chat. The default journey
 * keeps text, attachment, approval, and partial-read checks in one conversation
 * so follow-up behavior is exercised against real accumulated history.
 */

import {
  LATEST_DURABLE_ASSISTANT_TEXT,
  makeDevelopmentContext,
  withOwnedDevelopmentState,
} from "./chatview-development-state.mjs";

export { LATEST_DURABLE_ASSISTANT_TEXT } from "./chatview-development-state.mjs";

const RUN_TIMEOUT_MS = 180000;
const TOOL_SETTLEMENT_TIMEOUT_MS = 60000;

/**
 * The unique run-scoped marker must be present in the latest durable assistant
 * text. Containment, not byte equality: the live model may legally wrap its
 * reply in benign prose, and every hard guarantee (file bytes, tool states,
 * settlement ordering, banners) is asserted separately and exactly.
 */
function exactLatestAssistantStep(label, text) {
  return {
    label,
    action: "waitFor",
    params: {
      target: LATEST_DURABLE_ASSISTANT_TEXT,
      state: "textContains",
      text,
      timeoutMs: 5000,
    },
  };
}

function noResponseFailureSteps() {
  return [
    {
      label: "no response-failure banner",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
  ];
}

function attachmentFileName(context) {
  return `systemsculpt-${context.runId.toLowerCase()}.txt`;
}

function textRoundTripSteps(context) {
  const firstMarker = `TEXT-FIRST-${context.runId}`;
  const secondMarker = `TEXT-SECOND-${context.runId}`;
  return [
    {
      label: "submit first same-conversation text turn",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: `Reply with exactly ${firstMarker} and nothing else. Do not use tools.`,
        submit: true,
      },
    },
    {
      label: "first text run completes",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    exactLatestAssistantStep("first exact response is visible", firstMarker),
    {
      label: "submit second same-conversation text turn",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: `This is a follow-up in the same conversation. Reply with exactly ${secondMarker} `
          + "and nothing else. Do not use tools.",
        submit: true,
      },
    },
    {
      label: "second text run completes",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    exactLatestAssistantStep("second exact response is visible", secondMarker),
    {
      label: "copy the latest assistant response",
      action: "click",
      params: {
        target: "chat:.systemsculpt-agent-turn.is-assistant:last-child "
          + "[data-testid='chat.turn.copy']",
      },
    },
    {
      label: "copy feedback",
      action: "waitFor",
      params: { target: "label:Response copied", state: "visible", timeoutMs: 3000 },
    },
    { label: "open saved history", action: "click", params: { target: "chat.header.history" } },
    {
      label: "history is usable",
      action: "waitFor",
      params: { target: "history.search", state: "visible", timeoutMs: 10000 },
    },
    { label: "close history", action: "click", params: { target: "history.close" } },
  ];
}

function attachmentRoundTripSteps(context) {
  const attachmentMarker = `ATTACHMENT-${context.runId}`;
  const fileName = attachmentFileName(context);
  return [
    {
      label: "attach marker text through the real picker",
      action: "attach",
      params: {
        name: fileName,
        mimeType: "text/plain",
        dataBase64: Buffer.from(attachmentMarker, "utf8").toString("base64"),
        via: "picker",
      },
    },
    {
      label: "attachment chip is visible",
      action: "waitFor",
      params: {
        target: "chat.composer.attachment.remove",
        state: "visible",
        timeoutMs: 10000,
      },
    },
    {
      label: "submit marker attachment turn",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: "Read the attached text file. Reply with its complete contents and nothing else.",
        submit: true,
      },
    },
    {
      label: "attachment run completes",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    exactLatestAssistantStep("attachment content reached the response", attachmentMarker),
    {
      label: "attachment remains visible in the transcript",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-message-attachment.is-file",
        state: "textContains",
        text: fileName,
        timeoutMs: 5000,
      },
    },
  ];
}

function existingChatAttachmentRoundTripSteps(context) {
  const baselineMarker = `ATTACHMENT-BASE-${context.runId}`;
  const attachmentMarker = `ATTACHMENT-${context.runId}`;
  const fileName = attachmentFileName(context);
  return [
    {
      label: "submit read-only baseline turn before attaching",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: [
          "Call the list_items vault tool exactly once.",
          "In that one call, pass paths exactly [\".\"] and recursive false.",
          "Do not call any other tool.",
          `After that tool finishes, reply with exactly ${baselineMarker}.`,
        ].join(" "),
        submit: true,
      },
    },
    {
      label: "baseline run completes",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: "baseline tool settles before continuation",
      action: "chat.assertLatestToolSettledAfterContinuation",
      params: {
        toolLabel: "List 1 folder",
        text: baselineMarker,
        textMode: "contains",
        expectedState: "succeeded",
        requireCommandAck: true,
        timeoutMs: TOOL_SETTLEMENT_TIMEOUT_MS,
      },
    },
    exactLatestAssistantStep("baseline response is durable", baselineMarker),
    ...noResponseFailureSteps().map((step) => ({
      ...step,
      label: "baseline has no response-failure banner",
    })),
    ...attachmentRoundTripSteps(context),
    ...noResponseFailureSteps().map((step) => ({
      ...step,
      label: "attachment has no response-failure banner",
    })),
    {
      label: "attachment journey DOM ordering evidence",
      action: "chat.toolLifecycle",
    },
    {
      label: "reopen exact attachment chat through visible history",
      action: "chat.reopenOwnedDevelopmentHistory",
      params: { timeoutMs: 10000 },
    },
    exactLatestAssistantStep(
      "reopened attachment response remains exact",
      attachmentMarker,
    ),
    {
      label: "reopened transcript preserves the exact attachment",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-message-attachment.is-file",
        state: "textContains",
        text: fileName,
        timeoutMs: 5000,
      },
    },
    ...noResponseFailureSteps().map((step) => ({
      ...step,
      label: "reopened attachment has no response-failure banner",
    })),
    { label: "reopened attachment transcript", action: "snapshot", params: { scope: "chat" } },
  ];
}

function exactWriteSteps({ prefix, filePath, fileContent, completionMarker }) {
  return [
    {
      label: `${prefix} submit exact write`,
      action: "chat.typeDevelopmentDraft",
      params: {
        text: `Create exactly one file at ${filePath} containing exactly ${fileContent}. `
          + `Use your vault tools. Then reply with exactly ${completionMarker}.`,
        submit: true,
      },
    },
    {
      label: `${prefix} approval is required`,
      action: "chat.waitForDevelopmentRun",
      params: { until: "approval", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: `${prefix} allow exact write once`,
      action: "chat.approveDevelopmentWriteOnce",
      params: { path: filePath, text: fileContent },
    },
    {
      label: `${prefix} run completes`,
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: `${prefix} tool settles before continuation`,
      action: "chat.assertLatestToolSettledAfterContinuation",
      params: {
        toolLabel: "Write file",
        text: completionMarker,
        textMode: "contains",
        expectedState: "succeeded",
        requireCommandAck: true,
        timeoutMs: TOOL_SETTLEMENT_TIMEOUT_MS,
      },
    },
    exactLatestAssistantStep(`${prefix} completion marker is durable`, completionMarker),
    {
      label: `${prefix} file has exact content`,
      action: "vault.assertText",
      params: { path: filePath, text: fileContent },
    },
  ];
}

function mixedPartialReadSteps({ existingPaths, missingPaths, completionMarker }) {
  const requestedPaths = [...existingPaths, ...missingPaths];
  return [
    {
      label: "submit one deterministic mixed partial read",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: [
          "Call the read vault tool exactly once.",
          `In that one call, pass one paths array containing exactly: ${JSON.stringify(requestedPaths)}.`,
          "Do not split the paths into separate calls and do not retry the missing paths.",
          "Keep the successful results even though the deliberately absent paths will fail.",
          `After the tool result, reply with exactly ${completionMarker}.`,
        ].join(" "),
        submit: true,
      },
    },
    {
      label: "mixed partial read completes normally",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: "partial tool is terminal before continuation",
      action: "chat.assertLatestToolSettledAfterContinuation",
      params: {
        toolLabel: "Read 4 files",
        text: completionMarker,
        textMode: "contains",
        expectedState: "partial",
        requireCommandAck: true,
        timeoutMs: TOOL_SETTLEMENT_TIMEOUT_MS,
      },
    },
    {
      label: "partial read is amber and not fatal",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-partial:not(.is-failed):not(.is-error)",
        state: "visible",
        timeoutMs: 5000,
      },
    },
    {
      label: "partial read counts are exact",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-partial "
          + ".systemsculpt-agent-tool-summary",
        state: "textEquals",
        text: "2 completed, 2 failed",
        timeoutMs: 5000,
      },
    },
    {
      label: "partial read uses tool-scoped recovery copy",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-partial "
          + ".systemsculpt-agent-tool-error",
        state: "textEquals",
        text: "Some requested items failed; successful items were kept.",
        timeoutMs: 5000,
      },
    },
    exactLatestAssistantStep("mixed partial final response is durable", completionMarker),
    ...noResponseFailureSteps(),
    { label: "mixed partial transcript", action: "snapshot", params: { scope: "chat" } },
  ];
}

function reopenedMixedPartialReadSteps(completionMarker) {
  return [
    {
      label: "reopen the exact saved chat through visible history",
      action: "chat.reopenOwnedDevelopmentHistory",
      params: { timeoutMs: 10000 },
    },
    {
      label: "reopened partial read remains amber and not fatal",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-partial:not(.is-failed):not(.is-error)",
        state: "visible",
        timeoutMs: 5000,
      },
    },
    {
      label: "reopened partial counts are exact",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-partial "
          + ".systemsculpt-agent-tool-summary",
        state: "textEquals",
        text: "2 completed, 2 failed",
        timeoutMs: 5000,
      },
    },
    {
      label: "reopened partial recovery copy stays tool-scoped",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-partial "
          + ".systemsculpt-agent-tool-error",
        state: "textEquals",
        text: "Some requested items failed; successful items were kept.",
        timeoutMs: 5000,
      },
    },
    exactLatestAssistantStep(
      "reopened mixed partial final response remains exact",
      completionMarker,
    ),
    ...noResponseFailureSteps().map((step) => ({
      ...step,
      label: "reopened chat has no response-failure banner",
    })),
    { label: "reopened mixed partial transcript", action: "snapshot", params: { scope: "chat" } },
  ];
}

function failedReadRecoverySteps({ missingPaths, completionMarker }) {
  return [
    {
      label: "submit one deterministic failed read",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: [
          "Call the read vault tool exactly once.",
          `In that one call, pass one paths array containing exactly: ${JSON.stringify(missingPaths)}.`,
          "Both files are deliberately absent. Do not retry them and do not use another tool.",
          `After the failed tool result, reply with exactly ${completionMarker}.`,
        ].join(" "),
        submit: true,
      },
    },
    {
      label: "failed read response still completes",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: "failed tool is terminal before continuation",
      action: "chat.assertLatestToolSettledAfterContinuation",
      params: {
        toolLabel: "Read 2 files",
        text: completionMarker,
        textMode: "contains",
        expectedState: "failed",
        requireCommandAck: true,
        timeoutMs: TOOL_SETTLEMENT_TIMEOUT_MS,
      },
    },
    {
      label: "failed read row is visible and terminal",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-failed",
        state: "visible",
        timeoutMs: 5000,
      },
    },
    {
      label: "failed read counts are exact",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-failed "
          + ".systemsculpt-agent-tool-summary",
        state: "textEquals",
        text: "0 completed, 2 failed",
        timeoutMs: 5000,
      },
    },
    {
      label: "failed read uses private recovery copy",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-failed "
          + ".systemsculpt-agent-tool-error",
        state: "textEquals",
        text: "This vault action could not be completed.",
        timeoutMs: 5000,
      },
    },
    exactLatestAssistantStep("failed read final response is durable", completionMarker),
    ...noResponseFailureSteps(),
    { label: "failed read transcript", action: "snapshot", params: { scope: "chat" } },
  ];
}

function reopenedFailedReadRecoverySteps(completionMarker) {
  return [
    {
      label: "reopen the exact failed-read chat through visible history",
      action: "chat.reopenOwnedDevelopmentHistory",
      params: { timeoutMs: 10000 },
    },
    {
      label: "reopened failed read row remains terminal",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-failed",
        state: "visible",
        timeoutMs: 5000,
      },
    },
    {
      label: "reopened failed read counts remain exact",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-failed "
          + ".systemsculpt-agent-tool-summary",
        state: "textEquals",
        text: "0 completed, 2 failed",
        timeoutMs: 5000,
      },
    },
    {
      label: "reopened failed read keeps private recovery copy",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool.is-failed "
          + ".systemsculpt-agent-tool-error",
        state: "textEquals",
        text: "This vault action could not be completed.",
        timeoutMs: 5000,
      },
    },
    exactLatestAssistantStep(
      "reopened failed read final response remains exact",
      completionMarker,
    ),
    ...noResponseFailureSteps().map((step) => ({
      ...step,
      label: "reopened failed-read chat has no response-failure banner",
    })),
    { label: "reopened failed read transcript", action: "snapshot", params: { scope: "chat" } },
  ];
}

export function makeChatLiveTextRoundTrip(now = Date.now()) {
  const context = makeDevelopmentContext("T", now);
  return withOwnedDevelopmentState(context, [
    ...textRoundTripSteps(context),
    ...noResponseFailureSteps(),
    { label: "text transcript", action: "snapshot", params: { scope: "chat" } },
  ]);
}

export function makeChatLiveAttachmentRoundTrip(now = Date.now()) {
  const context = makeDevelopmentContext("A", now);
  return withOwnedDevelopmentState(context, [
    ...existingChatAttachmentRoundTripSteps(context),
  ]);
}

export function makeChatLiveBlankAttachmentRoundTrip(now = Date.now()) {
  const context = makeDevelopmentContext("B", now);
  return withOwnedDevelopmentState(context, [
    ...attachmentRoundTripSteps(context),
    ...noResponseFailureSteps().map((step) => ({
      ...step,
      label: "first-turn attachment has no response-failure banner",
    })),
    {
      label: "reopen exact first-turn attachment chat through visible history",
      action: "chat.reopenOwnedDevelopmentHistory",
      params: { timeoutMs: 10000 },
    },
    exactLatestAssistantStep(
      "reopened first-turn attachment response remains exact",
      `ATTACHMENT-${context.runId}`,
    ),
    {
      label: "reopened first-turn transcript preserves the exact attachment",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-message-attachment.is-file",
        state: "textContains",
        text: attachmentFileName(context),
        timeoutMs: 5000,
      },
    },
    ...noResponseFailureSteps().map((step) => ({
      ...step,
      label: "reopened first-turn attachment has no response-failure banner",
    })),
    { label: "reopened first-turn attachment transcript", action: "snapshot", params: { scope: "chat" } },
  ]);
}

export function makeAgentVaultToolApprovalRoundTrip(now = Date.now()) {
  const context = makeDevelopmentContext("W", now);
  const filePath = `${context.markerRoot}/approved.md`;
  const fileContent = `APPROVAL-CONTENT-${context.runId}`;
  const completionMarker = `APPROVED-${context.runId}`;
  return withOwnedDevelopmentState(context, [
    ...exactWriteSteps({
      prefix: "approval",
      filePath,
      fileContent,
      completionMarker,
    }),
    ...noResponseFailureSteps(),
    { label: "approval transcript", action: "snapshot", params: { scope: "chat" } },
  ]);
}

export function makeAgentVaultToolMixedPartialRead(now = Date.now()) {
  const context = makeDevelopmentContext("P", now);
  const existingPaths = [
    `${context.markerRoot}/existing-a.md`,
    `${context.markerRoot}/existing-b.md`,
  ];
  const missingPaths = [
    `${context.markerRoot}/deliberately-absent-a.md`,
    `${context.markerRoot}/deliberately-absent-b.md`,
  ];
  const firstContent = `PARTIAL-A-${context.runId}`;
  const secondContent = `PARTIAL-B-${context.runId}`;
  const completionMarker = `PARTIAL-COMPLETE-${context.runId}`;
  return withOwnedDevelopmentState(context, [
    ...exactWriteSteps({
      prefix: "first seed",
      filePath: existingPaths[0],
      fileContent: firstContent,
      completionMarker: `SEEDED-A-${context.runId}`,
    }),
    ...exactWriteSteps({
      prefix: "second seed",
      filePath: existingPaths[1],
      fileContent: secondContent,
      completionMarker: `SEEDED-B-${context.runId}`,
    }),
    ...mixedPartialReadSteps({
      existingPaths,
      missingPaths,
      completionMarker,
    }),
    ...reopenedMixedPartialReadSteps(completionMarker),
  ]);
}

export function makeAgentVaultToolFailedReadRecovery(now = Date.now()) {
  const context = makeDevelopmentContext("F", now);
  const completionMarker = `FAILED-READ-RECOVERED-${context.runId}`;
  return withOwnedDevelopmentState(context, [
    ...failedReadRecoverySteps({
      missingPaths: [
        `${context.markerRoot}/deliberately-absent-a.md`,
        `${context.markerRoot}/deliberately-absent-b.md`,
      ],
      completionMarker,
    }),
    ...reopenedFailedReadRecoverySteps(completionMarker),
  ]);
}

export default function makeChatLiveAcceptance(now = Date.now()) {
  const context = makeDevelopmentContext("L", now);
  const existingPaths = [
    `${context.markerRoot}/existing-a.md`,
    `${context.markerRoot}/existing-b.md`,
  ];
  const missingPaths = [
    `${context.markerRoot}/deliberately-absent-a.md`,
    `${context.markerRoot}/deliberately-absent-b.md`,
  ];
  return withOwnedDevelopmentState(context, [
    ...textRoundTripSteps(context),
    ...attachmentRoundTripSteps(context),
    ...exactWriteSteps({
      prefix: "first seed approval",
      filePath: existingPaths[0],
      fileContent: `PARTIAL-A-${context.runId}`,
      completionMarker: `SEEDED-A-${context.runId}`,
    }),
    ...exactWriteSteps({
      prefix: "second seed approval",
      filePath: existingPaths[1],
      fileContent: `PARTIAL-B-${context.runId}`,
      completionMarker: `SEEDED-B-${context.runId}`,
    }),
    ...mixedPartialReadSteps({
      existingPaths,
      missingPaths,
      completionMarker: `PARTIAL-COMPLETE-${context.runId}`,
    }),
    {
      label: "runtime errors",
      action: "logs",
      resumeAfterFailure: true,
      params: { level: "error", limit: 50 },
    },
  ]);
}
