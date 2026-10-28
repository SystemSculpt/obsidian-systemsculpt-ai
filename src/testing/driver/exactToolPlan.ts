import { canonicalAgentToolInput } from "../../chat/managed/MutationJournal";
import { FILESYSTEM_LIMITS } from "../../tools/vault/constants";
import {
  type ActionContext,
  activeChatView,
  DriverActionError,
  sleep,
  throwIfActionCancelled,
} from "./actionCore";
import { chatContainer, isVisible, resolveTarget } from "./locators";
import {
  flushToolLifecycleCapture,
} from "./toolLifecycleCapture";
import {
  capturedContinuationEntries,
  continuationTimeoutError,
  latestVisualTransitionAt,
  matchingContinuationEntries,
  proveContinuationOrdering,
} from "./toolLifecycleContinuation";
import {
  continuationContentMetadata,
  type ExactSequentialTextPartProof,
  type ExactSequentialToolExpectation,
  exactSequentialToolPlanProofs,
  exactTerminalRowCallCount,
  firstCapturedToolCallCount,
  orderedToolLifecycleRecords,
  toolIsVisuallySettled,
  type ToolLifecycleCapture,
  toolLifecycleCaptures,
  type ToolLifecycleRecord,
  toolLifecycleState,
} from "./toolLifecycleState";
import {
  bindToolResultDeliveryScope,
  type BoundToolResultDeliveryScope,
  currentRunSupportEvidence,
  resultDeliveryCommandProof,
} from "./toolResultDelivery";

/** Exact sequential tool-plan and post-run clean-close proofs. */

interface ExactSequentialToolPlanParams {
  expectedTools: readonly ExactSequentialToolExpectation[];
  expectedText: string;
  requireNoOtherText: boolean;
  textMode: "contains" | "equals";
  timeoutMs: number;
}

function exactSequentialToolPlanParams(
  params: Record<string, unknown>,
): ExactSequentialToolPlanParams {
  const rawTools = params.tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    throw new DriverActionError("tools must be a nonempty exact ordered tool plan.");
  }
  const expectedTools = rawTools.map((rawTool, index) => {
    if (typeof rawTool !== "object" || rawTool === null || Array.isArray(rawTool)) {
      throw new DriverActionError(`Tool plan entry ${String(index + 1)} must be an exact object.`);
    }
    const tool = rawTool as Record<string, unknown>;
    const keys = Object.keys(tool).sort();
    if (keys.length !== 2 || keys[0] !== "input" || keys[1] !== "name") {
      throw new DriverActionError(
        `Tool plan entry ${String(index + 1)} must contain only name and input.`,
      );
    }
    if (
      typeof tool.name !== "string"
      || tool.name.length === 0
      || tool.name.trim() !== tool.name
    ) {
      throw new DriverActionError(
        `Tool plan entry ${String(index + 1)} requires one canonical tool name.`,
      );
    }
    return Object.freeze({
      canonicalInput: canonicalAgentToolInput(tool.input),
      toolName: tool.name,
    });
  });
  const expectedText = typeof params.text === "string" ? params.text.trim() : "";
  if (!expectedText) {
    throw new DriverActionError("Exact sequential tool-plan proof requires continuation text.");
  }
  if (
    params.textMode !== undefined
    && params.textMode !== "equals"
    && params.textMode !== "contains"
  ) {
    throw new DriverActionError('textMode must be "equals" or "contains".');
  }
  const textMode = params.textMode === "contains" ? "contains" : "equals";
  if (
    params.requireNoOtherText !== undefined
    && typeof params.requireNoOtherText !== "boolean"
  ) {
    throw new DriverActionError("requireNoOtherText must be a boolean.");
  }
  const requireNoOtherText = params.requireNoOtherText !== false;
  if (requireNoOtherText && textMode !== "equals") {
    throw new DriverActionError(
      "requireNoOtherText requires textMode=equals so the final marker is exact.",
    );
  }
  const timeoutMs = params.timeoutMs === undefined
    ? 10000
    : typeof params.timeoutMs === "number"
      && Number.isFinite(params.timeoutMs)
      && params.timeoutMs >= 0
      ? params.timeoutMs
      : null;
  if (timeoutMs === null) {
    throw new DriverActionError("timeoutMs must be a finite nonnegative number.");
  }
  return {
    expectedTools: Object.freeze(expectedTools),
    expectedText,
    requireNoOtherText,
    textMode,
    timeoutMs,
  };
}

/**
 * Canonicalizes a plan tool input with the vault executor's optional-field
 * defaults resolved, so a model that trimmed a field whose default it relied
 * on still proves the same semantic call. Only fields the executor defines a
 * default for participate; an unknown tool or an unknown field keeps the
 * input byte-exact.
 */
function developmentSemanticCanonicalInput(
  toolName: string,
  canonicalInput: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalInput);
  } catch {
    return canonicalInput;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return canonicalInput;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (toolName === "write") {
    if (!keys.every((key) =>
      ["appendNewline", "content", "createDirs", "ifExists", "path"].includes(key))) {
      return canonicalInput;
    }
    return canonicalAgentToolInput({
      appendNewline: record.appendNewline ?? false,
      content: record.content,
      createDirs: record.createDirs ?? true,
      ifExists: record.ifExists ?? "overwrite",
      path: record.path,
    });
  }
  if (toolName === "read") {
    if (!keys.every((key) => ["length", "offset", "paths"].includes(key))) {
      return canonicalInput;
    }
    // The executor windows an omitted length to MAX_FILE_READ_LENGTH, so an
    // explicit request for that same window is the identical semantic call.
    return canonicalAgentToolInput({
      length: record.length ?? FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH,
      offset: record.offset ?? 0,
      paths: record.paths,
    });
  }
  return canonicalInput;
}

/**
 * Value-free identity-mismatch evidence: canonical inputs may contain private
 * vault paths and note content, so a mismatch report may name top-level input
 * KEYS (tool-schema identifiers) but never their values. Comparison happens on
 * the executor-default-resolved semantic form, the same form the identity
 * check itself uses.
 */
function describeSemanticInputMismatch(
  toolName: string,
  capturedInput: string | null,
  expectedInput: string,
): Record<string, unknown> {
  const parse = (input: string | null): Record<string, unknown> | string => {
    if (input === null) return "absent";
    let parsed: unknown;
    try {
      parsed = JSON.parse(developmentSemanticCanonicalInput(toolName, input));
    } catch {
      return "unparseable";
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return Array.isArray(parsed) ? "array" : typeof parsed;
    }
    return parsed as Record<string, unknown>;
  };
  const captured = parse(capturedInput);
  const expected = parse(expectedInput);
  if (typeof captured === "string" || typeof expected === "string") {
    return {
      capturedShape: typeof captured === "string" ? captured : "object",
      expectedShape: typeof expected === "string" ? expected : "object",
    };
  }
  const keys = [...new Set([...Object.keys(captured), ...Object.keys(expected)])].sort();
  const mismatchedKeys: string[] = [];
  const capturedOnlyKeys: string[] = [];
  const expectedOnlyKeys: string[] = [];
  for (const key of keys) {
    if (!(key in captured)) expectedOnlyKeys.push(key);
    else if (!(key in expected)) capturedOnlyKeys.push(key);
    else if (canonicalAgentToolInput(captured[key]) !== canonicalAgentToolInput(expected[key])) {
      mismatchedKeys.push(key);
    }
  }
  return { mismatchedKeys, capturedOnlyKeys, expectedOnlyKeys };
}

function sameDevelopmentSemanticToolIdentity(
  expected: ExactSequentialToolExpectation,
  toolName: string | null,
  canonicalInput: string | null,
): boolean {
  return toolName === expected.toolName
    && canonicalInput !== null
    && developmentSemanticCanonicalInput(expected.toolName, canonicalInput)
      === developmentSemanticCanonicalInput(expected.toolName, expected.canonicalInput);
}

function sameContinuationMetadata(
  left: Readonly<{ characters: number; sha256: string }>,
  right: Readonly<{ characters: number; sha256: string }>,
): boolean {
  return left.characters === right.characters && left.sha256 === right.sha256;
}

function capturedExactTextParts(
  capture: ToolLifecycleCapture,
  turnId: string,
): readonly ExactSequentialTextPartProof[] {
  return capturedContinuationEntries(capture)
    .filter(([, observation]) => observation.turnId === turnId)
    .map(([part, observation]) => Object.freeze({
      partKey: observation.partKey,
      textMetadata: continuationContentMetadata(part.textContent ?? ""),
    }));
}

function exactTextPartProofMatches(
  expected: readonly ExactSequentialTextPartProof[],
  actual: readonly ExactSequentialTextPartProof[],
): boolean {
  return expected.length === actual.length && expected.every((part, index) => {
    const candidate = actual[index];
    return candidate !== undefined
      && part.partKey === candidate.partKey
      && sameContinuationMetadata(part.textMetadata, candidate.textMetadata);
  });
}

function sameOrdinalPlan(
  expected: readonly number[],
  actual: readonly number[],
): boolean {
  return expected.length === actual.length
    && expected.every((ordinal, index) => ordinal === actual[index]);
}

function exactTerminalGroupedToolSurface(
  turn: HTMLElement,
  container: HTMLElement,
  orderedPartKeys: readonly string[],
): boolean {
  const collapsedOverflows = [...turn.querySelectorAll<HTMLButtonElement>(
    'button[data-agent-activity-overflow][aria-expanded="false"]',
  )];
  for (const overflow of collapsedOverflows) overflow.click();
  try {
    if (collapsedOverflows.some((overflow) =>
      overflow.getAttribute("aria-expanded") !== "true")) return false;
    const rows = [...turn.querySelectorAll<HTMLElement>(
      ".systemsculpt-agent-part.is-tool",
    )];
    if (rows.length === 0) return false;
    let logicalIndex = 0;
    for (const row of rows) {
      const callCount = exactTerminalRowCallCount(row);
      if (
        callCount === null
        || row.dataset.partKey !== orderedPartKeys[logicalIndex]
        || toolLifecycleState(row) !== "succeeded"
        || !toolIsVisuallySettled(row, container)
      ) return false;
      logicalIndex += callCount;
    }
    return logicalIndex === orderedPartKeys.length;
  } finally {
    for (const overflow of collapsedOverflows.reverse()) {
      if (overflow.getAttribute("aria-expanded") === "true") overflow.click();
    }
  }
}

/**
 * With exactGrouping, every tool row must precede every text part. Without it
 * (a plan that allows benign assistant prose), interleaved text is fine, but
 * the turn must still end with a text part painted after the last tool so the
 * continuation remains the terminal surface.
 */
function toolsPrecedeTextOnExactSurface(
  turn: HTMLElement,
  exactGrouping: boolean,
): boolean {
  const relevant = [...turn.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-part.is-tool, .systemsculpt-agent-part.is-text",
  )];
  const toolRowCount = relevant.filter((part) => part.classList.contains("is-tool")).length;
  if (toolRowCount === 0) return false;
  if (exactGrouping) {
    return relevant.slice(0, toolRowCount).every((part) => part.classList.contains("is-tool"))
      && relevant.slice(toolRowCount).every((part) => part.classList.contains("is-text"));
  }
  const lastToolIndex = relevant.reduce(
    (latest, part, index) => (part.classList.contains("is-tool") ? index : latest),
    -1,
  );
  const finalPart = relevant[relevant.length - 1];
  return finalPart !== undefined
    && finalPart.classList.contains("is-text")
    && lastToolIndex < relevant.length - 1;
}

export function sameTurnResponseErrorCount(
  capture: ToolLifecycleCapture,
  turnId: string,
): number {
  return [...capture.responseErrorObservations.values()]
    .filter((observation) => observation.turnId === turnId)
    .length;
}

function exactSequentialRegistrationProof(
  records: readonly ToolLifecycleRecord[],
  finalDeliveryScope: BoundToolResultDeliveryScope,
): void {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    const currentRegistration = current?.registeredAt;
    if (!previous?.registeredAt || !currentRegistration) {
      throw new DriverActionError(
        "Exact sequential tool-plan proof is missing first-introduction provenance.",
      );
    }
    if (
      currentRegistration.observedSequence <= previous.registeredAt.observedSequence
      || currentRegistration.mutationBatch <= previous.registeredAt.mutationBatch
    ) {
      throw new DriverActionError(
        "A later expected tool was introduced in the same or an earlier mutation batch.",
      );
    }
    if (
      latestVisualTransitionAt(previous, currentRegistration.observedSequence)?.rowSettled !== true
    ) {
      throw new DriverActionError(
        "A later expected tool appeared before the prior tool was visibly terminal.",
      );
    }
    const previousFinalEvidence = finalDeliveryScope.startedEvidence[index - 1];
    const currentFinalEvidence = finalDeliveryScope.startedEvidence[index];
    if (!previousFinalEvidence || !currentFinalEvidence) {
      throw new DriverActionError(
        "Exact sequential tool-plan diagnostics do not cover every ordered call.",
      );
    }
    const priorAtIntroduction = currentRegistration.toolResultDeliveryEvidence.find((evidence) =>
      evidence.requestId === finalDeliveryScope.requestId
      && evidence.toolExecutionOrdinal === previousFinalEvidence.toolExecutionOrdinal);
    const priorCommandProof = priorAtIntroduction
      ? resultDeliveryCommandProof(priorAtIntroduction)
      : null;
    const finalPriorCommandProof = resultDeliveryCommandProof(previousFinalEvidence);
    const finalCurrentCommandProof = resultDeliveryCommandProof(currentFinalEvidence);
    if (
      !priorAtIntroduction
      || priorAtIntroduction.acknowledgementSucceededCount !== 1
      || priorAtIntroduction.acknowledgementFailedCount !== 0
      || priorCommandProof?.valid !== true
      || finalPriorCommandProof.valid !== true
      || finalCurrentCommandProof.valid !== true
      || finalPriorCommandProof.acknowledgementSequence === null
      || finalCurrentCommandProof.localStartSequence === null
      || finalPriorCommandProof.acknowledgementSequence
        >= finalCurrentCommandProof.localStartSequence
    ) {
      throw new DriverActionError(
        "A later expected tool appeared or started before one successful prior result ACK.",
      );
    }
  }
}

export async function assertExactSequentialToolPlan(
  ctx: ActionContext,
  rawParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const params = exactSequentialToolPlanParams(rawParams);
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) {
    throw new DriverActionError(
      "A live tool-lifecycle capture must begin before the exact sequential plan.",
    );
  }
  const startedAt = Date.now();
  let quiescedTurnId: string | null = null;
  for (;;) {
    throwIfActionCancelled(ctx);
    const container = chatContainer(ctx.app);
    if (!container) throw new DriverActionError("Chat is not open.");
    flushToolLifecycleCapture(capture);
    const matching = matchingContinuationEntries(
      capture,
      params.expectedText,
      params.textMode,
    );
    const continuationEntry = matching[matching.length - 1] ?? null;
    if (continuationEntry) {
      const [continuationPart, continuationAt] = continuationEntry;
      const turnId = continuationAt.turnId;
      if (!turnId) {
        throw new DriverActionError(
          "The exact final continuation is not bound to an assistant turn.",
        );
      }
      const sameTurnTextEntries = capturedContinuationEntries(capture)
        .filter(([, observation]) => observation.turnId === turnId);
      const sameTurnMatchingCount = sameTurnTextEntries.filter(([textPart]) => {
        const text = (textPart.textContent ?? "").trim();
        return params.textMode === "equals"
          ? text === params.expectedText
          : text.includes(params.expectedText);
      }).length;
      if (sameTurnMatchingCount !== 1) {
        throw new DriverActionError(
          "The allowed final continuation was observed more than once in its assistant turn.",
        );
      }
      if (params.requireNoOtherText && sameTurnTextEntries.length !== 1) {
        throw new DriverActionError(
          "The exact tool-plan turn contains pre-tool, duplicate, or additional assistant text.",
        );
      }
      const records = orderedToolLifecycleRecords(
        [...capture.records.values()].filter((record) => record.turnId === turnId),
      );
      if (records.length > params.expectedTools.length) {
        throw new DriverActionError(
          "The exact tool-plan turn contains an extra client-tool call: "
            + `expected=${String(params.expectedTools.length)}; `
            + `records=${JSON.stringify(records.map((record) => ({
              partKey: record.partKey,
              label: record.label,
              firstCallCount: firstCapturedToolCallCount(record),
              callCount: record.callCount,
              connected: record.element.isConnected
                && capture.container.contains(record.element),
            })))}.`,
        );
      }
      if (records.length === params.expectedTools.length) {
        if (records.some((record) => firstCapturedToolCallCount(record) !== 1)) {
          throw new DriverActionError(
            "Exact sequential tool-plan proof requires distinct singleton introductions.",
          );
        }
        if (records.some((record) => toolLifecycleState(record.element) !== "succeeded")) {
          throw new DriverActionError(
            "Exact sequential tool-plan proof requires every visible result to succeed.",
          );
        }
        records.forEach((record, index) => {
          const expected = params.expectedTools[index];
          if (
            !expected
            || record.identityConflict
            || !sameDevelopmentSemanticToolIdentity(
              expected,
              record.toolName,
              record.canonicalInput,
            )
          ) {
            throw new DriverActionError(
              `Exact canonical tool identity mismatch at plan index ${String(index + 1)}: `
                + `partKey=${record.partKey}; `
                + `conflict=${String(record.identityConflict)}; `
                + `capturedName=${JSON.stringify(record.toolName)}; `
                + `expectedName=${JSON.stringify(expected?.toolName ?? null)}; `
                + `inputKeyDiff=${JSON.stringify(expected
                  ? describeSemanticInputMismatch(
                      expected.toolName,
                      record.canonicalInput,
                      expected.canonicalInput,
                    )
                  : null)}.`,
            );
          }
        });
        const orderingProofs = sameTurnTextEntries.map((entry) =>
          proveContinuationOrdering(
            capture,
            entry,
            records[records.length - 1] ?? null,
            false,
            false,
            null,
          ));
        const finalOrderingProof = orderingProofs[orderingProofs.length - 1];
        if (
          !finalOrderingProof
          || finalOrderingProof.toolCallCount !== params.expectedTools.length
          || finalOrderingProof.priorRecords.length !== records.length
        ) {
          throw new DriverActionError(
            "The final continuation does not bind the exact expected tool cardinality.",
          );
        }
        const finalDeliveryScope = bindToolResultDeliveryScope(
          continuationAt,
          records,
          params.expectedTools.length,
          turnId,
          true,
        );
        if (finalDeliveryScope.startedEvidence.some((evidence) =>
          evidence.acknowledgementSucceededCount !== 1
          || evidence.acknowledgementFailedCount !== 0
          || !resultDeliveryCommandProof(evidence).valid)) {
          throw new DriverActionError(
            "Exact sequential tool-plan proof requires one successful result ACK per call.",
          );
        }
        const commandSegments = finalDeliveryScope.startedEvidence.map((evidence) =>
          resultDeliveryCommandProof(evidence).commandSegmentOrdinal);
        if (
          commandSegments.some((ordinal) => ordinal === null)
          || new Set(commandSegments).size !== params.expectedTools.length
        ) {
          throw new DriverActionError(
            "Exact sequential tool-plan proof requires one unique result-command segment per call.",
          );
        }
        exactSequentialRegistrationProof(records, finalDeliveryScope);
        const assistantTurn = continuationPart.closest<HTMLElement>(
          ".systemsculpt-agent-turn.is-assistant",
        );
        const partKeys = records.map((record) => record.partKey);
        if (
          !assistantTurn
          || !exactTerminalGroupedToolSurface(assistantTurn, container, partKeys)
          || !toolsPrecedeTextOnExactSurface(assistantTurn, params.requireNoOtherText)
        ) {
          throw new DriverActionError(
            "The exact tool-plan turn does not preserve its terminal grouped tool surface.",
          );
        }
        const responseErrorCount = sameTurnResponseErrorCount(capture, turnId)
          + (assistantTurn?.querySelectorAll(".systemsculpt-agent-part.is-error").length ?? 0);
        if (responseErrorCount > 0) {
          throw new DriverActionError(
            "The exact tool-plan turn observed a response-wide error part.",
          );
        }
        const stop = resolveTarget(ctx, "chat.composer.stop");
        const runStillActive = assistantTurn?.classList.contains("is-active") === true
          || (stop !== null && isVisible(stop));
        if (!runStillActive) {
          if (quiescedTurnId !== turnId) {
            quiescedTurnId = turnId;
            await sleep(0);
            flushToolLifecycleCapture(capture);
            await sleep(0);
            continue;
          }
          const view = activeChatView(ctx);
          const textParts = capturedExactTextParts(capture, turnId);
          const toolExecutionOrdinals = finalDeliveryScope.startedEvidence.map(
            (evidence) => evidence.toolExecutionOrdinal,
          );
          exactSequentialToolPlanProofs.set(ctx.app, {
            capture,
            chatId: view?.chatId ?? "",
            cleanCloseProven: false,
            commandSegmentOrdinals: Object.freeze(commandSegments as number[]),
            deliveryRequestId: finalDeliveryScope.requestId,
            expectedTools: params.expectedTools,
            partKeys: Object.freeze(partKeys),
            provenAtObservedSequence: capture.mutationSequence,
            requireNoOtherText: params.requireNoOtherText,
            textParts: Object.freeze(textParts),
            textMetadata: continuationContentMetadata(params.expectedText),
            textMode: params.textMode,
            toolExecutionOrdinals: Object.freeze(toolExecutionOrdinals),
            turnId,
          });
          return {
            asserted: true,
            continuationCount: sameTurnTextEntries.length,
            exactToolCallCount: records.length,
            exactToolCallsProven: true,
            responseErrorFreeAtAssertion: true,
            noTextBeforeToolsCompleteProven: params.requireNoOtherText,
            sequentialToolResultAcksProven: true,
          };
        }
      }
    }
    if (Date.now() - startedAt >= params.timeoutMs) {
      throw continuationTimeoutError(
        capture,
        params.expectedText,
        params.timeoutMs,
        "Exact sequential tool-plan assertion",
      );
    }
    await sleep(20);
  }
}

async function waitForOwnerPaintOpportunity(container: HTMLElement): Promise<void> {
  const ownerWindow = container.ownerDocument.defaultView;
  const requestFrame = ownerWindow?.requestAnimationFrame?.bind(ownerWindow);
  if (requestFrame) {
    await new Promise<void>((resolve) => {
      requestFrame(() => requestFrame(() => resolve()));
    });
  } else {
    await sleep(0);
    await sleep(0);
  }
  await sleep(0);
}

export async function assertExactToolPlanCleanClose(
  ctx: ActionContext,
): Promise<Record<string, unknown>> {
  const proof = exactSequentialToolPlanProofs.get(ctx.app);
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!proof || !capture || proof.capture !== capture) {
    throw new DriverActionError(
      "Exact tool-plan clean close requires the original successful live proof.",
    );
  }
  const container = chatContainer(ctx.app);
  if (!container) throw new DriverActionError("Chat is not open.");
  await waitForOwnerPaintOpportunity(container);
  flushToolLifecycleCapture(capture);
  const view = activeChatView(ctx);
  const matchingTurns = [...container.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-turn.is-assistant",
  )].filter((turn) => turn.dataset.turnId === proof.turnId);
  const turn = matchingTurns[0] ?? null;
  const responseErrorCount = sameTurnResponseErrorCount(capture, proof.turnId)
    + matchingTurns.reduce(
      (count, turn) => count
        + turn.querySelectorAll(".systemsculpt-agent-part.is-error").length,
      0,
    );
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (
    responseErrorCount !== 0
    || turn?.classList.contains("is-active") === true
    || (stop !== null && isVisible(stop))
  ) {
    throw new DriverActionError(
      "Exact tool-plan clean close did not reach an error-free terminal render boundary.",
    );
  }
  if (view?.chatId !== proof.chatId || matchingTurns.length !== 1 || !turn) {
    throw new DriverActionError(
      "Exact tool-plan clean close did not preserve the proven chat and assistant turn.",
    );
  }

  const capturedTextParts = capturedExactTextParts(capture, proof.turnId);
  const visibleTextMetadata = [...turn.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-part.is-text",
  )]
    .filter((part) => (part.textContent ?? "").trim().length > 0)
    .map((part) => continuationContentMetadata(part.textContent ?? ""));
  const expectedVisibleTextMetadata = proof.textParts.map((part) => part.textMetadata);
  const visibleTextMatches = expectedVisibleTextMetadata.length === visibleTextMetadata.length
    && expectedVisibleTextMetadata.every((metadata, index) => {
      const candidate = visibleTextMetadata[index];
      return candidate !== undefined && sameContinuationMetadata(metadata, candidate);
    });

  const records = orderedToolLifecycleRecords(
    [...capture.records.values()].filter((record) => record.turnId === proof.turnId),
  );
  const lateNonterminalObservation = records.some((record) =>
    record.transitions.some((transition) =>
      transition.observedSequence > proof.provenAtObservedSequence
      && transition.state !== "succeeded")
    || record.visualTransitions.some((transition) =>
      transition.observedSequence > proof.provenAtObservedSequence
      && !transition.settled));
  const exactRecordSurface = records.length === proof.expectedTools.length
    && records.every((record, index) => {
      const expected = proof.expectedTools[index];
      return expected !== undefined
        && firstCapturedToolCallCount(record) === 1
        && !record.identityConflict
        && record.partKey === proof.partKeys[index]
        && sameDevelopmentSemanticToolIdentity(
          expected,
          record.toolName,
          record.canonicalInput,
        )
        && toolLifecycleState(record.element) === "succeeded"
        && toolIsVisuallySettled(record.element, container);
    });
  const exactVisibleToolSurface = exactTerminalGroupedToolSurface(
    turn,
    container,
    proof.partKeys,
  );
  const cleanCloseChecks = {
    textProof: exactTextPartProofMatches(proof.textParts, capturedTextParts),
    visibleText: visibleTextMatches,
    recordSurface: exactRecordSurface,
    visibleToolSurface: exactVisibleToolSurface,
    toolOrder: toolsPrecedeTextOnExactSurface(turn, proof.requireNoOtherText),
    noLateNonterminal: !lateNonterminalObservation,
  };
  if (Object.values(cleanCloseChecks).some((passed) => !passed)) {
    const failedChecks = Object.entries(cleanCloseChecks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ");
    throw new DriverActionError(
      "Exact tool-plan clean close did not preserve the proven terminal tool "
        + `and text surface (failed: ${failedChecks}; capturedTextParts=`
        + `${capturedTextParts.length}; visibleTextParts=`
        + `${visibleTextMetadata.length}).`,
    );
  }

  const currentDeliveryScope = bindToolResultDeliveryScope(
    currentRunSupportEvidence(capture),
    records,
    proof.expectedTools.length,
    proof.deliveryRequestId,
    true,
  );
  const currentCommandSegments = currentDeliveryScope.startedEvidence.map((evidence) =>
    resultDeliveryCommandProof(evidence).commandSegmentOrdinal);
  const currentToolExecutionOrdinals = currentDeliveryScope.startedEvidence.map(
    (evidence) => evidence.toolExecutionOrdinal,
  );
  const exactDeliverySurface = currentDeliveryScope.requestId === proof.deliveryRequestId
    && currentDeliveryScope.startedEvidence.every((evidence) =>
      evidence.acknowledgementSucceededCount === 1
      && evidence.acknowledgementFailedCount === 0
      && resultDeliveryCommandProof(evidence).valid)
    && currentCommandSegments.every((ordinal): ordinal is number => ordinal !== null)
    && new Set(currentCommandSegments).size === proof.expectedTools.length
    && sameOrdinalPlan(proof.commandSegmentOrdinals, currentCommandSegments)
    && sameOrdinalPlan(proof.toolExecutionOrdinals, currentToolExecutionOrdinals);
  if (!exactDeliverySurface) {
    throw new DriverActionError(
      "Exact tool-plan clean close did not preserve the proven request delivery boundary.",
    );
  }
  exactSequentialRegistrationProof(records, currentDeliveryScope);
  proof.cleanCloseProven = true;
  return {
    asserted: true,
    exactToolPlanCleanCloseProven: true,
    responseErrorCount: 0,
  };
}
