import type { App } from "obsidian";

import {
  chatContainer,
  describeElement,
  isVisible,
  queryChatElements,
  queryElements,
  resolveTarget,
} from "./locators";
import {
  type ActionContext,
  asRecord,
  DriverActionError,
  type DriverActionHandlers,
  revealActivityTarget,
  sleep,
  throwIfActionCancelled,
} from "./actionCore";
import { toolLifecycleCaptures, toolLifecycleReport, toolRowSnapshot } from "./chatToolLifecycle";

/**
 * Read-only views of the chat and settings surfaces, and the waits built on
 * them: a target reaching a state, and a submitted run finishing or stopping
 * for approval.
 */

export interface RunSubmissionBaseline {
  bannerFingerprint: string;
  fingerprint: string;
  submittedAtMs: number;
  turnCount: number;
}

export const pendingRunSubmissions = new WeakMap<App, RunSubmissionBaseline>();

export function chatSnapshot(
  ctx: ActionContext,
  includeToolLifecycle = true,
): Record<string, unknown> {
  const container = chatContainer(ctx.app);
  if (!container) return { open: false };
  const text = (selector: string): string => {
    const element = container.querySelector(selector);
    return (element?.textContent ?? "").trim();
  };
  const turns: Array<Record<string, unknown>> = [];
  for (const turn of container.querySelectorAll(".systemsculpt-agent-turn")) {
    const parts: Array<Record<string, unknown>> = [];
    for (const part of turn.querySelectorAll(".systemsculpt-agent-part")) {
      const element = part as HTMLElement;
      const kind = [...element.classList].find((cls) => cls.startsWith("is-")) ?? "part";
      parts.push({
        kind,
        text: (part.textContent ?? "").trim().slice(0, 2000),
        ...(element.classList.contains("is-tool") ? { tool: toolRowSnapshot(element) } : {}),
      });
    }
    const turnText = turn.textContent ?? "";
    turns.push({
      role: turn.classList.contains("is-assistant") ? "assistant"
        : turn.classList.contains("is-user") ? "user"
        : "unknown",
      active: turn.classList.contains("is-active"),
      text: turnText.trim().slice(0, 4000),
      textCharacters: turnText.length,
      parts,
    });
  }
  const input = container.querySelector("textarea.systemsculpt-agent-prompt-input");
  const send = container.querySelector("button.systemsculpt-agent-send");
  const stop = container.querySelector("button.systemsculpt-agent-stop");
  const approval = container.querySelector<HTMLElement>('[data-testid="chat.run.mode"]');
  const tailStatus = container.querySelector(".systemsculpt-agent-tail-status");
  const attachments: string[] = [];
  for (const item of container.querySelectorAll(".systemsculpt-agent-composer-attachments [role='listitem'], .systemsculpt-agent-composer-attachments > *")) {
    const label = (item.textContent ?? "").trim();
    if (label) attachments.push(label.slice(0, 200));
  }
  const banners: string[] = [];
  for (const banner of container.querySelectorAll(".systemsculpt-agent-banner")) {
    const label = (banner.textContent ?? "").trim();
    if (label) banners.push(label.slice(0, 500));
  }
  return {
    open: true,
    title: text(".systemsculpt-agent-header-title"),
    turnCount: turns.length,
    turns,
    banners,
    agentStatus: tailStatus?.getAttribute("data-status")
      ?? tailStatus?.querySelector(".systemsculpt-agent-tail-status-label")?.textContent?.trim()
      ?? null,
    toolLifecycle: includeToolLifecycle && toolLifecycleCaptures.has(ctx.app)
      ? toolLifecycleReport(ctx)
      : null,
    composer: {
      value: input?.instanceOf(HTMLTextAreaElement) ? input.value : "",
      sendDisabled: send?.instanceOf(HTMLButtonElement) ? send.disabled : null,
      stopVisible: stop?.instanceOf(HTMLElement) ? isVisible(stop) : false,
      approvalMode: approval?.dataset.mode ?? null,
      attachments,
    },
  };
}

export function settingsSnapshot(ctx: ActionContext): Record<string, unknown> {
  const surface = resolveTarget(ctx, "settings.surface");
  if (!surface?.instanceOf(HTMLElement) || !isVisible(surface)) return { open: false };
  const tabs: Array<Record<string, unknown>> = [];
  const bar = surface.querySelector(".ss-settings-tab-bar");
  for (const button of bar?.querySelectorAll("button, [role='tab']") ?? []) {
    tabs.push({
      label: (button.textContent ?? "").trim(),
      active: button.classList.contains("is-active") ||
        button.getAttribute("aria-selected") === "true",
    });
  }
  const activePanel = surface.querySelector(".systemsculpt-tab-content.is-active");
  return {
    open: true,
    tabs,
    activePanelText: (activePanel?.textContent ?? "").trim().slice(0, 4000),
  };
}

export async function waitForVisibilitySafely(
  ctx: ActionContext,
  target: string,
  state: "visible" | "hidden",
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const element = resolveTarget(ctx, target);
    const visible = element !== null && isVisible(element);
    if ((state === "visible" && visible) || (state === "hidden" && !visible)) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(`Timed out waiting for ${target} to become ${state}.`);
    }
    await sleep(100);
  }
}

export async function waitForFailedTurnRetryAdmission(
  ctx: ActionContext,
  priorUserTurn: HTMLElement | null,
  priorMessageId: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    const stop = resolveTarget(ctx, "chat.composer.stop");
    if (stop && isVisible(stop)) return;
    const container = chatContainer(ctx.app);
    const currentUserTurns = container?.querySelectorAll<HTMLElement>(
      ".systemsculpt-agent-turn.is-user",
    );
    const currentUserTurn = currentUserTurns?.[currentUserTurns.length - 1] ?? null;
    const currentMessageId = currentUserTurn?.dataset.messageId ?? "";
    if (
      currentUserTurn
      && (
        currentUserTurn !== priorUserTurn
        || (priorMessageId.length > 0 && currentMessageId !== priorMessageId)
      )
    ) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError("Retry did not admit a replacement failed turn.");
    }
    await sleep(20);
  }
}

/**
 * Everything the chat surface can show that indicates the run moved.
 *
 * Deliberately content-derived rather than "is the stop button visible": a
 * wedged run keeps the stop button up forever, which is exactly why a plain
 * waitFor cannot tell a dead run from a slow one.
 */
function runProgressFingerprint(snapshot: Record<string, unknown>): string {
  const composer = asRecord(snapshot.composer);
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  const last = asRecord(turns[turns.length - 1]);
  const parts = Array.isArray(last.parts) ? last.parts : [];
  const toolProgress = parts.map((value) => {
    const part = asRecord(value);
    const tool = asRecord(part.tool);
    return [
      part.kind ?? null,
      tool.partKey ?? null,
      tool.callCount ?? null,
      tool.state ?? null,
    ];
  });
  return [
    turns.length,
    parts.length,
    JSON.stringify(toolProgress),
    typeof last.textCharacters === "number"
      ? last.textCharacters
      : typeof last.text === "string" ? last.text.length : 0,
    String(composer.stopVisible),
    Array.isArray(snapshot.banners) ? snapshot.banners.join("|") : "",
  ].join(":");
}

export function captureRunSubmissionBaseline(ctx: ActionContext): RunSubmissionBaseline {
  const snapshot = chatSnapshot(ctx, false);
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  return {
    bannerFingerprint: Array.isArray(snapshot.banners) ? snapshot.banners.join("|") : "",
    fingerprint: runProgressFingerprint(snapshot),
    submittedAtMs: Date.now(),
    turnCount: turns.length,
  };
}

function visibleRunSignals(snapshot: Record<string, unknown>): {
  feedbackVisible: boolean;
  contentVisible: boolean;
  latestUserIndex: number;
} {
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  const normalized = turns.map((turn) => asRecord(turn));
  let latestUserIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const assistantTurns = latestUserIndex < 0
    ? []
    : normalized.slice(latestUserIndex + 1).filter((turn) => turn.role === "assistant");
  return {
    feedbackVisible: assistantTurns.some((turn) =>
      (typeof turn.text === "string" && turn.text.length > 0)
      || (Array.isArray(turn.parts) && turn.parts.length > 0)),
    contentVisible: assistantTurns.some((turn) =>
      Array.isArray(turn.parts) && turn.parts.length > 0),
    latestUserIndex,
  };
}

export function completedSubmittedRun(
  snapshot: Record<string, unknown>,
  baseline: RunSubmissionBaseline,
): boolean {
  const composer = asRecord(snapshot.composer);
  if (composer.stopVisible !== false) return false;
  const signals = visibleRunSignals(snapshot);
  if (signals.latestUserIndex < baseline.turnCount) return false;
  if (runProgressFingerprint(snapshot) === baseline.fingerprint) return false;
  const bannerFingerprint = Array.isArray(snapshot.banners) ? snapshot.banners.join("|") : "";
  return signals.feedbackVisible || bannerFingerprint !== baseline.bannerFingerprint;
}

/**
 * Waits for a chat run to finish, but fails fast and *specifically* when the
 * run stops producing anything.
 *
 * A flat timeout reports "waitFor timed out" for both a wedged run and a slow
 * model, which is how a hung run stayed invisible for nineteen minutes. This
 * reports which one happened, and returns the transcript either way.
 */
async function waitForRun(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 180000;
  const stallMs = typeof params.stallMs === "number" ? params.stallMs : 45000;
  const startMs = typeof params.startMs === "number" ? params.startMs : 20000;
  const approve = params.approve !== false;
  const returnOnApproval = params.returnOnApproval === true;
  const startedAt = Date.now();
  const submissionBaseline = pendingRunSubmissions.get(ctx.app) ?? null;
  pendingRunSubmissions.delete(ctx.app);

  // Submitting is asynchronous, so the run has not necessarily begun when this
  // action starts. Without waiting for it to appear, the very first poll sees
  // an idle composer and reports success for a turn that never ran. A fast
  // response can also finish before this separate driver action begins, so a
  // baseline captured by the submit action proves that terminal DOM belongs to
  // this submission without accepting arbitrary historical replies.
  let running = false;
  let completedBeforeRunningWasObserved: Record<string, unknown> | null = null;
  for (;;) {
    throwIfActionCancelled(ctx);
    const snapshot = chatSnapshot(ctx, false);
    if (asRecord(snapshot.composer).stopVisible === true) {
      running = true;
      break;
    }
    if (submissionBaseline && completedSubmittedRun(snapshot, submissionBaseline)) {
      completedBeforeRunningWasObserved = snapshot;
      break;
    }
    if (Date.now() - startedAt >= startMs) break;
    await sleep(50);
  }
  if (completedBeforeRunningWasObserved && submissionBaseline) {
    const completedSnapshot = chatSnapshot(ctx);
    const elapsedMs = Date.now() - startedAt;
    const visibleSignals = visibleRunSignals(completedSnapshot);
    const submitToFirstObservationUpperBoundMs = Math.max(
      0,
      Date.now() - submissionBaseline.submittedAtMs,
    );
    return {
      finished: true,
      waitedMs: elapsedMs,
      approvals: 0,
      timing: {
        runStartObserved: false,
        runStartedMs: null,
        firstVisibleFeedbackMs: null,
        firstVisibleContentMs: null,
        completedMs: null,
        feedbackPresentAtFirstObservation: visibleSignals.feedbackVisible,
        contentPresentAtFirstObservation: visibleSignals.contentVisible,
        submitToFirstObservationUpperBoundMs,
        submitToCompletionUpperBoundMs: submitToFirstObservationUpperBoundMs,
      },
      snapshot: completedSnapshot,
    };
  }
  if (!running) {
    throw new DriverActionError(
      `No run started within ${startMs}ms of submitting.`,
    );
  }

  const runStartedMs = Date.now() - startedAt;
  let firstVisibleFeedbackMs: number | null = null;
  let firstVisibleContentMs: number | null = null;
  let fingerprint = "";
  let lastProgressAt = Date.now();
  let approvals = 0;
  for (;;) {
    throwIfActionCancelled(ctx);
    const snapshot = chatSnapshot(ctx, false);
    const composer = asRecord(snapshot.composer);
    const elapsedMs = Date.now() - startedAt;
    const visibleSignals = visibleRunSignals(snapshot);
    if (firstVisibleFeedbackMs === null && visibleSignals.feedbackVisible) {
      firstVisibleFeedbackMs = elapsedMs;
    }
    if (firstVisibleContentMs === null && visibleSignals.contentVisible) {
      firstVisibleContentMs = elapsedMs;
    }
    const current = runProgressFingerprint(snapshot);
    if (current !== fingerprint) {
      fingerprint = current;
      lastProgressAt = Date.now();
    }
    if (composer.stopVisible === false) {
      const completedSnapshot = chatSnapshot(ctx);
      return {
        finished: true,
        waitedMs: elapsedMs,
        approvals,
        timing: {
          runStartedMs,
          firstVisibleFeedbackMs,
          firstVisibleContentMs,
          completedMs: elapsedMs,
        },
        snapshot: completedSnapshot,
      };
    }

    // Approve exactly as a user would, rather than relying on the composer's
    // approval mode. A run that parks on approval is otherwise indisputably
    // "not progressing", so a driven run would stall by design.
    const approvalButton = revealActivityTarget(ctx, "chat.approval.allow-for-chat")
      ?? revealActivityTarget(ctx, "chat.approval.allow-once");
    if (approvalButton && isVisible(approvalButton)) {
      if (returnOnApproval) {
        const approvalSnapshot = chatSnapshot(ctx);
        return {
          finished: false,
          approvalRequired: true,
          waitedMs: elapsedMs,
          approvals,
          timing: {
            runStartedMs,
            firstVisibleFeedbackMs,
            firstVisibleContentMs,
            completedMs: null,
          },
          snapshot: approvalSnapshot,
        };
      }
      if (approve) {
        throwIfActionCancelled(ctx);
        approvalButton.click();
        approvals += 1;
        lastProgressAt = Date.now();
        await sleep(120);
        continue;
      }
    }
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs >= stallMs) {
      throw new DriverActionError(
        `The run stalled: no chat activity for ${idleMs}ms `
          + `(waited ${Date.now() - startedAt}ms total). The run is still `
          + "presented as active. Check server logs for the matching run id.",
      );
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(
        `The run did not finish within ${timeoutMs}ms, but it was still `
          + `producing output ${idleMs}ms ago. Raise timeoutMs if this is `
          + "simply a long job.",
      );
    }
    await sleep(100);
  }
}

export async function waitForCondition(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const target = typeof params.target === "string" ? params.target : "";
  const state = typeof params.state === "string" ? params.state : "exists";
  const text = typeof params.text === "string" ? params.text : "";
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
  if (!target) throw new DriverActionError("waitFor requires a target.");
  const startedAt = Date.now();
  const evaluate = (): boolean => {
    const element = resolveTarget(ctx, target);
    switch (state) {
      case "exists": return element !== null;
      case "gone": return element === null;
      case "visible": return element !== null && isVisible(element);
      case "hidden": return element === null || !isVisible(element);
      case "enabled":
        if (!element) return false;
        return element.instanceOf(HTMLButtonElement) ? !element.disabled
          : element.instanceOf(HTMLInputElement) || element.instanceOf(HTMLTextAreaElement)
            ? !element.disabled
            : false;
      case "disabled":
        if (!element) return false;
        return element.instanceOf(HTMLButtonElement) ? element.disabled
          : element.instanceOf(HTMLInputElement) || element.instanceOf(HTMLTextAreaElement)
            ? element.disabled
            : false;
      case "textContains":
        return element !== null && (element.textContent ?? "").includes(text);
      case "textEquals": {
        const trimmedTarget = target.trim();
        if (trimmedTarget.startsWith("css:") || trimmedTarget.startsWith("chat:")) {
          const matches = trimmedTarget.startsWith("chat:")
            ? queryChatElements(ctx.app, trimmedTarget.slice(5))
            : queryElements(ctx, trimmedTarget.slice(4));
          return matches.length === 1
            && (matches[0]?.textContent ?? "").trim() === text.trim();
        }
        return element !== null
          && (element.textContent ?? "").trim() === text.trim();
      }
      default:
        throw new DriverActionError(
          `waitFor state must be exists, gone, visible, hidden, enabled, disabled, textContains, or textEquals; got "${state}".`,
        );
    }
  };
  for (;;) {
    throwIfActionCancelled(ctx);
    if (evaluate()) {
      return { satisfied: true, waitedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const element = resolveTarget(ctx, target);
      throw new DriverActionError(
        `waitFor timed out after ${timeoutMs}ms: ${target} did not reach "${state}". ` +
          `Current: ${JSON.stringify(describeElement(element))}`,
      );
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
}

function scopedSnapshot(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const scope = typeof params.scope === "string" ? params.scope : "chat";
  if (scope === "chat") return chatSnapshot(ctx);
  if (scope === "settings") return settingsSnapshot(ctx);
  throw new DriverActionError(`snapshot scope must be chat or settings; got "${scope}".`);
}

export const SNAPSHOT_AND_WAIT_ACTIONS: DriverActionHandlers = {
  snapshot: scopedSnapshot,
  waitFor: waitForCondition,
  waitForRun,
};
