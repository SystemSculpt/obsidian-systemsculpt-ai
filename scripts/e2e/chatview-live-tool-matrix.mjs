/**
 * Visible, CLI-driven first-party tool matrix for the real Obsidian ChatView.
 *
 * The journey stays in Ask Approval, owns one fresh marker subtree, and uses
 * exact-effect approval for every mutation: the pending mutation must plan to
 * the identical marker-contained vault outcome as the scenario's expected
 * input. Each submitted turn must finish all
 * of its current-turn tool cards before its continuation marker, and the
 * driver's content-free diagnostics must prove one local start, result-send
 * attempt, and command acknowledgement before continuation, followed by one
 * clean send completion after the command stream closes.
 *
 * `find` is intentionally constrained to one unique marker-owned basename and
 * one requested result; content search is additionally scoped to the marker
 * root. Server-owned `web_search` is not part of this client matrix because an
 * external search result is not deterministic enough for a local release gate.
 */

import {
  LATEST_DURABLE_ASSISTANT_TEXT,
  makeDevelopmentContext,
  withOwnedDevelopmentState,
} from "./chatview-development-state.mjs";

const RUN_TIMEOUT_MS = 180000;
const TOOL_SETTLEMENT_TIMEOUT_MS = 60000;

/**
 * The unique run-scoped marker must be present in the latest durable assistant
 * text. Containment, not byte equality: the live model may legally wrap its
 * reply in benign prose, and every hard guarantee (file bytes, tool states,
 * settlement ordering, banners) is asserted separately and exactly.
 */
function exactMarkerStep(label, marker) {
  return {
    label,
    action: "waitFor",
    params: {
      target: LATEST_DURABLE_ASSISTANT_TEXT,
      state: "textContains",
      text: marker,
      timeoutMs: 5000,
    },
  };
}

function terminalToolSteps({ prefix, marker, toolLabel, toolCount }) {
  return [
    {
      label: `${prefix} tools settle before continuation`,
      action: "chat.assertLatestToolSettledAfterContinuation",
      params: {
        toolLabel,
        text: marker,
        textMode: "contains",
        expectedState: "succeeded",
        requireCommandAck: true,
        requireAllToolResultAcks: true,
        expectedAllToolResultState: "succeeded",
        timeoutMs: TOOL_SETTLEMENT_TIMEOUT_MS,
      },
    },
    {
      label: `${prefix} result sends complete after continuation`,
      action: "chat.assertAllToolResultSendsCompleted",
      params: {
        toolLabel,
        text: marker,
        textMode: "contains",
        timeoutMs: TOOL_SETTLEMENT_TIMEOUT_MS,
      },
    },
    {
      label: `${prefix} current-turn tool surface is terminal`,
      action: "chat.assertToolLifecycle",
      params: { minToolCount: toolCount, requireTerminal: true },
    },
    exactMarkerStep(`${prefix} exact marker is durable`, marker),
  ];
}

function readOnlyTurnSteps({ prefix, prompt, marker, toolLabel, toolCount = 1 }) {
  return [
    {
      label: `${prefix} submit exact read-only tools`,
      action: "chat.typeDevelopmentDraft",
      params: { text: prompt, submit: true },
    },
    {
      label: `${prefix} run completes`,
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    ...terminalToolSteps({ prefix, marker, toolLabel, toolCount }),
  ];
}

function exactWriteTurnSteps({ prefix, prompt, marker, path, text }) {
  return [
    {
      label: `${prefix} submit exact write`,
      action: "chat.typeDevelopmentDraft",
      params: { text: prompt, submit: true },
    },
    {
      label: `${prefix} approval is required`,
      action: "chat.waitForDevelopmentRun",
      params: { until: "approval", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: `${prefix} approve exact write once`,
      action: "chat.approveDevelopmentWriteOnce",
      params: { path, text },
    },
    {
      label: `${prefix} run completes`,
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    ...terminalToolSteps({ prefix, marker, toolLabel: "Write file", toolCount: 1 }),
    {
      label: `${prefix} file has exact content`,
      action: "vault.assertText",
      params: { path, text },
    },
  ];
}

function exactMutationTurnSteps({
  prefix,
  prompt,
  marker,
  toolLabel,
  toolName,
  input,
  assertions = [],
}) {
  return [
    {
      label: `${prefix} submit exact mutation`,
      action: "chat.typeDevelopmentDraft",
      params: { text: prompt, submit: true },
    },
    {
      label: `${prefix} approval is required`,
      action: "chat.waitForDevelopmentRun",
      params: { until: "approval", timeoutMs: RUN_TIMEOUT_MS },
    },
    {
      label: `${prefix} approve exact owned mutation once`,
      action: "chat.approveDevelopmentMutationOnce",
      params: { toolName, input },
    },
    {
      label: `${prefix} run completes`,
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: RUN_TIMEOUT_MS },
    },
    ...terminalToolSteps({ prefix, marker, toolLabel, toolCount: 1 }),
    ...assertions,
  ];
}

function exactSingleToolPrompt(toolName, input, marker) {
  return [
    `Call the ${toolName} vault tool exactly once with this exact JSON input:`,
    JSON.stringify(input),
    "Do not call any other tool and do not emit response text before the tool finishes.",
    `After its result, reply with exactly ${marker}.`,
  ].join(" ");
}

export function makeChatLiveToolMatrix(now = Date.now()) {
  const context = makeDevelopmentContext("M", now);
  const workRoot = `${context.markerRoot}/work`;
  const createdFolderPath = `${workRoot}/created-${context.runId.toLowerCase()}`;
  const fileName = `matrix-${context.runId.toLowerCase()}.md`;
  const primaryPath = `${workRoot}/${fileName}`;
  const movedPath = `${workRoot}/moved-${context.runId.toLowerCase()}.md`;
  const original = `MATRIX-ORIGINAL-${context.runId}`;
  const edited = `MATRIX-EDITED-${context.runId}`;
  const multiEdited = `MATRIX-MULTI-${context.runId}`;
  const finalContent = `MATRIX-FINAL-${context.runId}`;

  const seedMarker = `MATRIX-SEED-DONE-${context.runId}`;
  const foldersMarker = `MATRIX-FOLDERS-DONE-${context.runId}`;
  const inspectMarker = `MATRIX-INSPECT-DONE-${context.runId}`;
  const findMarker = `MATRIX-FIND-DONE-${context.runId}`;
  const searchMarker = `MATRIX-SEARCH-DONE-${context.runId}`;
  const openMarker = `MATRIX-OPEN-DONE-${context.runId}`;
  const editMarker = `MATRIX-EDIT-DONE-${context.runId}`;
  const multiEditMarker = `MATRIX-MULTI-EDIT-DONE-${context.runId}`;
  const moveMarker = `MATRIX-MOVE-DONE-${context.runId}`;
  const trashMarker = `MATRIX-TRASH-DONE-${context.runId}`;
  const completionMarker = `TOOL-MATRIX-COMPLETE-${context.runId}`;

  const createFoldersInput = { paths: [createdFolderPath] };
  const findInput = {
    patterns: [fileName],
    maxResults: 1,
  };
  const searchInput = {
    patterns: [original],
    paths: [context.markerRoot],
    patternMode: "literal",
    searchIn: "content",
    pageTokens: 512,
  };
  const openInput = {
    files: [{ path: primaryPath }],
  };
  const editInput = {
    path: primaryPath,
    edits: [{
      oldText: original,
      newText: edited,
      occurrence: "first",
      mode: "exact",
    }],
    strict: true,
  };
  const multiEditInput = {
    files: [{
      path: primaryPath,
      edits: [{
        oldText: edited,
        newText: multiEdited,
        occurrence: "first",
        mode: "exact",
      }],
      strict: true,
    }],
  };
  const moveInput = { items: [{ source: primaryPath, destination: movedPath }] };
  const trashInput = { paths: [movedPath] };

  return withOwnedDevelopmentState(context, [
    ...exactWriteTurnSteps({
      prefix: "matrix seed",
      marker: seedMarker,
      path: primaryPath,
      text: original,
      prompt: [
        `Call the write vault tool exactly once with path ${primaryPath}`,
        `and content exactly ${original}.`,
        "Do not call another tool and do not emit response text before the tool finishes.",
        `After its result, reply with exactly ${seedMarker}.`,
      ].join(" "),
    }),
    ...exactMutationTurnSteps({
      prefix: "matrix create folders",
      prompt: exactSingleToolPrompt("create_folders", createFoldersInput, foldersMarker),
      marker: foldersMarker,
      toolLabel: "Create folders",
      toolName: "create_folders",
      input: createFoldersInput,
      assertions: [{
        label: "matrix created folder exists",
        action: "vault.assertFolder",
        params: { path: createdFolderPath },
      }],
    }),
    ...readOnlyTurnSteps({
      prefix: "matrix list and read",
      marker: inspectMarker,
      toolLabel: "Read 1 file",
      toolCount: 2,
      prompt: [
        "Call exactly these two vault tools in the listed order and no others.",
        `First call list_items exactly once with ${JSON.stringify({
          paths: [workRoot],
          recursive: false,
          sort: "name",
          filter: "all",
        })}.`,
        `After that result, call read exactly once with ${JSON.stringify({ paths: [primaryPath] })}.`,
        "Do not emit response text before both tools finish.",
        `Then reply with exactly ${inspectMarker}.`,
      ].join(" "),
    }),
    ...readOnlyTurnSteps({
      prefix: "matrix find",
      prompt: exactSingleToolPrompt("find", findInput, findMarker),
      marker: findMarker,
      toolLabel: "Search 1 file pattern",
    }),
    ...readOnlyTurnSteps({
      prefix: "matrix search",
      prompt: exactSingleToolPrompt("search", searchInput, searchMarker),
      marker: searchMarker,
      toolLabel: "Search 1 text pattern",
    }),
    ...readOnlyTurnSteps({
      prefix: "matrix open",
      prompt: exactSingleToolPrompt("open", openInput, openMarker),
      marker: openMarker,
      toolLabel: "Open 1 file",
    }),
    {
      label: "matrix open leaves composer available",
      action: "waitFor",
      params: { target: "chat.composer.input", state: "enabled", timeoutMs: 5000 },
    },
    ...exactMutationTurnSteps({
      prefix: "matrix edit",
      prompt: exactSingleToolPrompt("edit", editInput, editMarker),
      marker: editMarker,
      toolLabel: "Edit file",
      toolName: "edit",
      input: editInput,
      assertions: [{
        label: "matrix edit file has exact content",
        action: "vault.assertText",
        params: { path: primaryPath, text: edited },
      }],
    }),
    ...exactMutationTurnSteps({
      prefix: "matrix multi edit",
      prompt: exactSingleToolPrompt("multi_edit", multiEditInput, multiEditMarker),
      marker: multiEditMarker,
      toolLabel: "Edit files",
      toolName: "multi_edit",
      input: multiEditInput,
      assertions: [{
        label: "matrix multi edit file has exact content",
        action: "vault.assertText",
        params: { path: primaryPath, text: multiEdited },
      }],
    }),
    ...exactMutationTurnSteps({
      prefix: "matrix move",
      prompt: exactSingleToolPrompt("move", moveInput, moveMarker),
      marker: moveMarker,
      toolLabel: "Move items",
      toolName: "move",
      input: moveInput,
      assertions: [{
        label: "matrix moved file has exact content",
        action: "vault.assertText",
        params: { path: movedPath, text: multiEdited },
      }],
    }),
    ...exactMutationTurnSteps({
      prefix: "matrix trash",
      prompt: exactSingleToolPrompt("trash", trashInput, trashMarker),
      marker: trashMarker,
      toolLabel: "Move to trash",
      toolName: "trash",
      input: trashInput,
    }),
    ...exactWriteTurnSteps({
      prefix: "matrix final restore",
      marker: completionMarker,
      path: primaryPath,
      text: finalContent,
      prompt: [
        `Call the write vault tool exactly once with path ${primaryPath}`,
        `and content exactly ${finalContent}.`,
        "Do not call another tool and do not emit response text before the tool finishes.",
        `After its result, reply with exactly ${completionMarker}.`,
      ].join(" "),
    }),
    {
      label: "matrix has no response-failure banner",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    { label: "matrix lifecycle evidence", action: "chat.toolLifecycle" },
    { label: "matrix visible transcript", action: "snapshot", params: { scope: "chat" } },
    {
      label: "reopen exact matrix chat through visible history",
      action: "chat.reopenOwnedDevelopmentHistory",
      params: { timeoutMs: 10000 },
    },
    exactMarkerStep("reopened matrix final marker remains exact", completionMarker),
    {
      label: "reopened matrix has no non-terminal tool cards",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-part.is-tool:is("
          + ".is-input-streaming, .is-input-ready, .is-approval-required, "
          + ".is-approved, .is-running)",
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "reopened matrix has no response-failure banner",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    { label: "reopened matrix visible transcript", action: "snapshot", params: { scope: "chat" } },
  ]);
}

export default makeChatLiveToolMatrix;
