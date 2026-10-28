import {
type ActionContext,
DriverActionError,
type DriverActionHandlers
} from "./actionCore";
import {
assertExactSequentialToolPlan,
assertExactToolPlanCleanClose,
sameTurnResponseErrorCount,
} from "./exactToolPlan";
import {
flushToolLifecycleCapture,
startToolLifecycleCapture,
toolLifecycleReport,
} from "./toolLifecycleCapture";
import {
assertAllToolResultSendsCompleted,
assertLatestToolSettledAfterContinuation,
assertNoClientToolsBeforeContinuation,
} from "./toolLifecycleContinuation";
import {
exactSequentialToolPlanProofs,
firstCapturedToolCallCount,
toolLifecycleCaptures
} from "./toolLifecycleState";

/** Public driver actions for live chat tool-lifecycle capture and assertions. */

export { startToolLifecycleCapture, toolLifecycleReport } from "./toolLifecycleCapture";
export { canonicalToolCallId, toolLifecycleCaptures, toolRowSnapshot } from "./toolLifecycleState";

function assertToolLifecycle(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const minToolCount = params.minToolCount;
  if (!Number.isSafeInteger(minToolCount) || (minToolCount as number) < 1) {
    throw new DriverActionError("minToolCount must be a positive safe integer.");
  }
  if (params.requireTerminal !== undefined && typeof params.requireTerminal !== "boolean") {
    throw new DriverActionError("requireTerminal must be a boolean.");
  }
  const expectedTurnId = typeof params.turnId === "string" ? params.turnId.trim() : null;
  if (params.turnId !== undefined && !expectedTurnId) {
    throw new DriverActionError("turnId must be a non-empty string when provided.");
  }
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) throw new DriverActionError("No live tool-lifecycle capture is active.");
  flushToolLifecycleCapture(capture);
  const records = [...capture.records.values()];
  const turnId = expectedTurnId
    ?? [...records].reverse().find((record) => record.turnId)?.turnId
    ?? null;
  if (!turnId) {
    throw new DriverActionError("No current-run tool identity was observed during capture.");
  }
  const currentRunRecords = records.filter((record) => record.turnId === turnId);
  const connectedRecords = currentRunRecords.filter((record) =>
    record.element.isConnected && capture.container.contains(record.element));
  const connectedToolCallCount = connectedRecords.reduce(
    (sum, record) => sum + record.callCount,
    0,
  );
  const observedToolIdentityCount = currentRunRecords.length;
  const observedToolCallCount = currentRunRecords.reduce(
    (sum, record) => sum + firstCapturedToolCallCount(record),
    0,
  );
  const surfaces = capture.surfaceTransitions.get(turnId) ?? [];
  const toolCallCount = Math.max(
    connectedToolCallCount,
    observedToolIdentityCount,
    observedToolCallCount,
    ...surfaces.map((surface) => surface.toolCallCount),
  );
  if (toolCallCount < (minToolCount as number)) {
    throw new DriverActionError(
      `Current run ${JSON.stringify(turnId)} observed ${toolCallCount} tool calls; `
        + `at least ${String(minToolCount)} were required.`,
    );
  }
  const retainedTerminalToolCallCount = currentRunRecords
    .filter((record) => record.visualTransitions[record.visualTransitions.length - 1]
      ?.rowSettled === true)
    .reduce((sum, record) => sum + firstCapturedToolCallCount(record), 0);
  const terminalToolCallCount = Math.max(
    0,
    retainedTerminalToolCallCount,
    ...surfaces.map((surface) => surface.terminalToolCallCount),
  );
  const allTerminal = terminalToolCallCount >= toolCallCount;
  if (params.requireTerminal === true && !allTerminal) {
    throw new DriverActionError(
      `Current run has not reached a fully terminal captured tool surface: ${JSON.stringify({
        connectedToolCallCount,
        observedToolIdentityCount,
        observedToolCallCount,
        retainedTerminalToolCallCount,
        terminalToolCallCount,
        toolCallCount,
      })}.`,
    );
  }
  const terminalSurface = [...surfaces]
    .reverse()
    .find((surface) => surface.terminalToolCallCount === terminalToolCallCount) ?? null;
  const toolRowCount = terminalSurface?.toolRowCount
    ?? surfaces[surfaces.length - 1]?.toolRowCount
    ?? connectedRecords.length;
  return {
    asserted: true,
    turnId,
    minToolCount,
    toolCallCount,
    toolRowCount,
    connectedToolRowCount: connectedRecords.length,
    observedToolIdentityCount,
    supersededToolRowCount: Math.max(0, currentRunRecords.length - toolRowCount),
    connectedToolCallCount,
    observedToolCallCount,
    retainedTerminalToolCallCount,
    terminalToolCallCount,
    allTerminal,
  };
}

export function endToolLifecycleCapture(ctx: ActionContext): Record<string, unknown> {
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) return {
    active: false,
    clock: "owner_window_performance",
    source: "live_dom_mutation",
      tools: [],
    };
  const exactProof = exactSequentialToolPlanProofs.get(ctx.app);
  try {
    if (exactProof?.capture === capture) {
      flushToolLifecycleCapture(capture);
      if (!exactProof.cleanCloseProven) {
        throw new DriverActionError(
          "Exact tool-plan capture requires a post-run clean-close assertion before ending.",
        );
      }
      if (sameTurnResponseErrorCount(capture, exactProof.turnId) !== 0) {
        throw new DriverActionError(
          "Exact tool-plan clean close observed a response-wide error part.",
        );
      }
    }
    return { ...toolLifecycleReport(ctx), active: false };
  } finally {
    capture.observer.disconnect();
    toolLifecycleCaptures.delete(ctx.app);
    if (exactProof?.capture === capture) exactSequentialToolPlanProofs.delete(ctx.app);
  }
}

export const CHAT_TOOL_LIFECYCLE_ACTIONS: DriverActionHandlers = {
  "chat.beginToolLifecycleCapture": startToolLifecycleCapture,
  "chat.toolLifecycle": toolLifecycleReport,
  "chat.assertToolLifecycle": assertToolLifecycle,
  "chat.endToolLifecycleCapture": endToolLifecycleCapture,
  "chat.assertLatestToolSettledAfterContinuation": assertLatestToolSettledAfterContinuation,
  "chat.assertAllToolResultSendsCompleted": assertAllToolResultSendsCompleted,
  "chat.assertExactSequentialToolPlan": assertExactSequentialToolPlan,
  "chat.assertExactToolPlanCleanClose": assertExactToolPlanCleanClose,
  "chat.assertNoClientToolsBeforeContinuation": assertNoClientToolsBeforeContinuation,
};
