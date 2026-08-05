/**
 * One-command ChatView live acceptance.
 *
 * This uses provider credits and creates one uniquely named file under
 * QA/E2E. The separate stress scenario remains opt-in.
 */

const RUN_TIMEOUT_MS = 180000;
const STALL_MS = 60000;

export function makeChatLiveTextRoundTrip(now = Date.now()) {
  const marker = `CHATVIEW-TEXT-${now.toString(36).toUpperCase()}`;
  return [
    { label: "open chat", action: "chat.open", resumeAfterFailure: true },
    { label: "new chat", action: "click", params: { target: "chat.header.new" } },
    {
      label: "composer ready",
      action: "waitFor",
      params: { target: "chat.composer.input", state: "visible", timeoutMs: 10000 },
    },
    {
      label: "submit exact-output turn",
      action: "type",
      params: { text: `Reply with exactly ${marker} and nothing else. Do not use tools.`, submit: true },
    },
    {
      label: "run completes with timing",
      action: "waitForRun",
      params: { timeoutMs: RUN_TIMEOUT_MS, stallMs: STALL_MS, approve: false },
    },
    {
      label: "expected response is visible",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-turn.is-assistant .systemsculpt-agent-part.is-text",
        state: "textEquals",
        text: marker,
        timeoutMs: 5000,
      },
    },
    {
      label: "copy the assistant response",
      action: "click",
      params: { target: "chat:.systemsculpt-agent-turn.is-assistant [data-testid='chat.turn.copy']" },
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
    {
      label: "no error banner",
      action: "waitFor",
      params: { target: "chat:.systemsculpt-agent-banner", state: "hidden", timeoutMs: 2000 },
    },
    { label: "text transcript", action: "snapshot", params: { scope: "chat" } },
  ];
}

export function makeChatLiveAttachmentRoundTrip(now = Date.now()) {
  const marker = `CHATVIEW-ATTACHMENT-${now.toString(36).toUpperCase()}`;
  const fileName = `chatview-${now.toString(36)}.txt`;
  return [
    { label: "open chat", action: "chat.open", resumeAfterFailure: true },
    { label: "new chat", action: "click", params: { target: "chat.header.new" } },
    {
      label: "attach text through the real picker",
      action: "attach",
      params: {
        name: fileName,
        mimeType: "text/plain",
        dataBase64: Buffer.from(marker, "utf8").toString("base64"),
        via: "picker",
      },
    },
    {
      label: "attachment chip is visible",
      action: "waitFor",
      params: { target: "chat.composer.attachment.remove", state: "visible", timeoutMs: 10000 },
    },
    {
      label: "submit attachment turn",
      action: "type",
      params: {
        text: "Read the attached text file. Reply with its complete contents and nothing else.",
        submit: true,
      },
    },
    {
      label: "attachment run completes with timing",
      action: "waitForRun",
      params: { timeoutMs: RUN_TIMEOUT_MS, stallMs: STALL_MS, approve: false },
    },
    {
      label: "attachment content reached the response",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-turn.is-assistant .systemsculpt-agent-part.is-text",
        state: "textEquals",
        text: marker,
        timeoutMs: 5000,
      },
    },
    {
      label: "attachment remains visible in history",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-message-attachment.is-file",
        state: "visible",
        timeoutMs: 5000,
      },
    },
    { label: "attachment transcript", action: "snapshot", params: { scope: "chat" } },
  ];
}

export function makeAgentVaultToolApprovalRoundTrip(now = Date.now()) {
  const runId = now.toString(36).toUpperCase();
  const filePath = `QA/E2E/approval-${runId}.md`;
  const fileContent = `APPROVAL-CONTENT-${runId}`;
  const completionMarker = `APPROVED-${runId}`;
  return [
    { label: "open chat", action: "chat.open", resumeAfterFailure: true },
    { label: "new chat", action: "click", params: { target: "chat.header.new" } },
    {
      label: "ask before vault changes",
      action: "select",
      params: { target: "chat.composer.approval-mode", value: "ask" },
    },
    {
      label: "submit one vault change",
      action: "type",
      params: {
        text: `Create exactly one file at ${filePath} containing exactly ${fileContent}. `
          + `Then reply with exactly ${completionMarker}.`,
        submit: true,
      },
    },
    {
      label: "wait for approval or terminal",
      action: "waitForRun",
      params: {
        timeoutMs: 90000,
        stallMs: STALL_MS,
        approve: false,
        returnOnApproval: true,
      },
    },
    {
      label: "approval is required",
      action: "waitFor",
      params: { target: "chat.approval.allow-once", state: "visible", timeoutMs: 1000 },
    },
    { label: "approval preview", action: "snapshot", params: { scope: "chat" } },
    {
      label: "approval preview has the exact path",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-approval-preview .systemsculpt-diff-filename",
        state: "textEquals",
        text: filePath,
        timeoutMs: 5000,
      },
    },
    {
      label: "approval preview has the exact content",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-approval-preview .systemsculpt-diff-line-added .systemsculpt-diff-line-content",
        state: "textEquals",
        text: fileContent,
        timeoutMs: 5000,
      },
    },
    {
      label: "allow once",
      action: "click",
      params: { target: "chat.approval.allow-once" },
    },
    {
      label: "approved run completes with timing",
      action: "waitForRun",
      params: { timeoutMs: RUN_TIMEOUT_MS, stallMs: STALL_MS, approve: false },
    },
    {
      label: "expected completion marker",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-turn.is-assistant .systemsculpt-agent-part.is-text",
        state: "textEquals",
        text: completionMarker,
        timeoutMs: 5000,
      },
    },
    {
      label: "approved file has exact content",
      action: "vault.assertText",
      params: { path: filePath, text: fileContent },
    },
    {
      label: "no final error banner",
      action: "waitFor",
      params: { target: "chat:.systemsculpt-agent-banner", state: "hidden", timeoutMs: 2000 },
    },
    { label: "approval transcript", action: "snapshot", params: { scope: "chat" } },
  ];
}

export default function makeChatLiveAcceptance(now = Date.now()) {
  return [
    ...makeChatLiveTextRoundTrip(now),
    ...makeChatLiveAttachmentRoundTrip(now + 1),
    ...makeAgentVaultToolApprovalRoundTrip(now + 2),
    {
      label: "runtime errors",
      action: "logs",
      resumeAfterFailure: true,
      params: { level: "error", limit: 50 },
    },
  ];
}
