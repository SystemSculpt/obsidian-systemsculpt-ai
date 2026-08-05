import type { App } from "obsidian";

import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import type { DriverDiagnostics } from "./diagnostics";
import {
  chatContainer,
  describeElement,
  isVisible,
  knownSemanticTargets,
  liveTestIdCatalog,
  queryElements,
  resolveTarget,
} from "./locators";

/**
 * DOM-level action engine for the E2E test driver.
 *
 * Every action operates on the real rendered UI through synthesized user
 * events (pointer, keyboard, input, change, drop), never through service
 * shortcuts, so a scripted run exercises the same code paths as a human.
 */

export interface ActionContext {
  app: App;
  pluginId: string;
  pluginVersion: string;
  buildStamp: string;
  diagnostics: DriverDiagnostics;
  settingsRoot?: () => HTMLElement | null;
}

interface AppWithCommands extends App {
  commands: { executeCommandById(id: string): boolean };
}

interface AppWithSettings extends App {
  setting: {
    open(): void;
    close(): void;
    openTabById(id: string): unknown;
  };
}

class DriverActionError extends Error {}

function requireTarget(ctx: ActionContext, target: unknown, fallback?: string): HTMLElement {
  const name = typeof target === "string" && target.trim().length > 0
    ? target
    : fallback;
  if (!name) throw new DriverActionError("A target is required for this action.");
  const element = resolveTarget(ctx, name);
  if (!element) {
    throw new DriverActionError(
      `Target "${name}" did not resolve. Targets are data-testid values (run the catalog ` +
        `action or npm run e2e -- targets), plus ${knownSemanticTargets().join(", ")} and ` +
        "css:, chat:, label:, testid: prefixes.",
    );
  }
  return element;
}

function pointerSequence(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const clientX = Math.round(rect.x + rect.width / 2);
  const clientY = Math.round(rect.y + rect.height / 2);
  const base = { bubbles: true, cancelable: true, composed: true, clientX, clientY };
  if (typeof PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent("pointerdown", { ...base, isPrimary: true }));
  }
  element.dispatchEvent(new MouseEvent("mousedown", base));
  if (typeof PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent("pointerup", { ...base, isPrimary: true }));
  }
  element.dispatchEvent(new MouseEvent("mouseup", base));
  element.dispatchEvent(new MouseEvent("click", base));
}

function keyboardEventInit(params: Record<string, unknown>): KeyboardEventInit {
  const key = typeof params.key === "string" ? params.key : "";
  if (!key) throw new DriverActionError("press requires a key, e.g. Enter or Escape.");
  return {
    key,
    code: typeof params.code === "string" ? params.code : key === "Enter" ? "Enter" : undefined,
    shiftKey: params.shift === true,
    ctrlKey: params.ctrl === true,
    altKey: params.alt === true,
    metaKey: params.meta === true,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

function setNativeValue(element: HTMLElement, text: string, mode: "replace" | "append"): void {
  if (element.instanceOf(HTMLTextAreaElement) || element.instanceOf(HTMLInputElement)) {
    element.focus();
    element.value = mode === "append" ? element.value + text : text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text }));
    return;
  }
  if (element.isContentEditable) {
    element.focus();
    element.textContent = mode === "append" ? (element.textContent ?? "") + text : text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text }));
    return;
  }
  throw new DriverActionError("type targets must be a text input, textarea, or contenteditable element.");
}

function decodeBase64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function buildFile(params: Record<string, unknown>): File {
  const name = typeof params.name === "string" ? params.name : "";
  const mimeType = typeof params.mimeType === "string" ? params.mimeType : "application/octet-stream";
  const dataBase64 = typeof params.dataBase64 === "string" ? params.dataBase64 : "";
  if (!name) throw new DriverActionError("attach requires a file name.");
  if (!dataBase64) throw new DriverActionError("attach requires base64 file data.");
  const bytes = decodeBase64ToBytes(dataBase64);
  return new File([bytes.buffer as ArrayBuffer], name, { type: mimeType });
}

function validatedVaultPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new DriverActionError("A vault-relative file path is required.");
  }
  if (
    value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new DriverActionError("The vault file path is unsafe.");
  }
  return value;
}

function chatSnapshot(ctx: ActionContext): Record<string, unknown> {
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
      parts.push({
        kind: [...part.classList].find((cls) => cls.startsWith("is-")) ?? "part",
        text: (part.textContent ?? "").trim().slice(0, 2000),
      });
    }
    turns.push({
      role: turn.classList.contains("is-assistant") ? "assistant"
        : turn.classList.contains("is-user") ? "user"
        : "unknown",
      active: turn.classList.contains("is-active"),
      text: (turn.textContent ?? "").trim().slice(0, 4000),
      parts,
    });
  }
  const input = container.querySelector("textarea.systemsculpt-agent-prompt-input");
  const send = container.querySelector("button.systemsculpt-agent-send");
  const stop = container.querySelector("button.systemsculpt-agent-stop");
  const approval = container.querySelector("select.systemsculpt-agent-approval-mode");
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
    composer: {
      value: input?.instanceOf(HTMLTextAreaElement) ? input.value : "",
      sendDisabled: send?.instanceOf(HTMLButtonElement) ? send.disabled : null,
      stopVisible: stop?.instanceOf(HTMLElement) ? isVisible(stop) : false,
      approvalMode: approval?.instanceOf(HTMLSelectElement) ? approval.value : null,
      attachments,
    },
  };
}

function settingsSnapshot(ctx: ActionContext): Record<string, unknown> {
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
  return [
    turns.length,
    parts.length,
    typeof last.text === "string" ? last.text.length : 0,
    String(composer.stopVisible),
    Array.isArray(snapshot.banners) ? snapshot.banners.join("|") : "",
  ].join(":");
}

function visibleRunSignals(snapshot: Record<string, unknown>): {
  feedbackVisible: boolean;
  contentVisible: boolean;
} {
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  const assistantTurns = turns
    .map((turn) => asRecord(turn))
    .filter((turn) => turn.role === "assistant");
  return {
    feedbackVisible: assistantTurns.some((turn) =>
      (typeof turn.text === "string" && turn.text.length > 0)
      || (Array.isArray(turn.parts) && turn.parts.length > 0)),
    contentVisible: assistantTurns.some((turn) =>
      Array.isArray(turn.parts) && turn.parts.length > 0),
  };
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

  // Submitting is asynchronous, so the run has not necessarily begun when this
  // action starts. Without waiting for it to appear, the very first poll sees
  // an idle composer and reports success for a turn that never ran.
  let running = false;
  while (Date.now() - startedAt < startMs) {
    if (asRecord(chatSnapshot(ctx).composer).stopVisible === true) {
      running = true;
      break;
    }
    await sleep(50);
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
    const snapshot = chatSnapshot(ctx);
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
        snapshot,
      };
    }

    // Approve exactly as a user would, rather than relying on the composer's
    // approval mode. A run that parks on approval is otherwise indisputably
    // "not progressing", so a driven run would stall by design.
    const approvalButton = resolveTarget(ctx, "chat.approval.allow-for-chat")
      ?? resolveTarget(ctx, "chat.approval.allow-once");
    if (approvalButton && isVisible(approvalButton)) {
      if (returnOnApproval) {
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
          snapshot,
        };
      }
      if (approve) {
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

async function waitForCondition(
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
        if (target.trim().startsWith("css:")) {
          const matches = queryElements(ctx, target.trim().slice(4));
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

export async function runDriverAction(
  ctx: ActionContext,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "status": {
      return {
        marker: "test-driver",
        pluginVersion: ctx.pluginVersion,
        buildStamp: ctx.buildStamp,
        vault: ctx.app.vault.getName(),
        chatOpen: chatContainer(ctx.app) !== null,
        settingsOpen: settingsSnapshot(ctx).open === true,
        consoleErrorCount: ctx.diagnostics.recentErrorCount(),
      };
    }
    case "chat.open": {
      const existing = ctx.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
      if (existing) {
        ctx.app.workspace.revealLeaf(existing);
      } else {
        const leaf = ctx.app.workspace.getLeaf(true);
        await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
        ctx.app.workspace.revealLeaf(leaf);
      }
      await waitForCondition(ctx, { target: "chat.composer.input", state: "visible", timeoutMs: 10000 });
      return chatSnapshot(ctx);
    }
    case "click": {
      const element = requireTarget(ctx, params.target);
      element.scrollIntoView({ block: "nearest" });
      pointerSequence(element);
      return describeElement(element);
    }
    case "type": {
      const element = requireTarget(ctx, params.target, "chat.composer.input");
      const text = typeof params.text === "string" ? params.text : "";
      const mode = params.mode === "append" ? "append" : "replace";
      setNativeValue(element, text, mode);
      if (params.submit === true) {
        element.dispatchEvent(new KeyboardEvent("keydown", keyboardEventInit({ key: "Enter" })));
        element.dispatchEvent(new KeyboardEvent("keyup", keyboardEventInit({ key: "Enter" })));
      }
      return describeElement(element);
    }
    case "press": {
      const element = requireTarget(ctx, params.target, "chat.composer.input");
      const init = keyboardEventInit(params);
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", init));
      element.dispatchEvent(new KeyboardEvent("keyup", init));
      return describeElement(element);
    }
    case "attach": {
      const file = buildFile(params);
      const via = params.via === "drop" ? "drop" : "picker";
      const transfer = new DataTransfer();
      transfer.items.add(file);
      if (via === "picker") {
        const picker = requireTarget(ctx, "chat.composer.file-picker");
        if (!(picker.instanceOf(HTMLInputElement))) {
          throw new DriverActionError("The chat file picker input was not found.");
        }
        picker.files = transfer.files;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const composer = requireTarget(ctx, "chat.composer");
        composer.dispatchEvent(new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: transfer,
        }));
      }
      return { attached: file.name, bytes: file.size, via };
    }
    case "scroll": {
      const element = requireTarget(ctx, params.target, "chat.scroller");
      if (params.to === "top") element.scrollTop = 0;
      else if (params.to === "bottom") element.scrollTop = element.scrollHeight;
      else if (typeof params.deltaY === "number") element.scrollTop += params.deltaY;
      else throw new DriverActionError("scroll requires to=top|bottom or a numeric deltaY.");
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
    }
    case "read": {
      const element = requireTarget(ctx, params.target);
      return describeElement(element);
    }
    case "vault.assertText": {
      const path = validatedVaultPath(params.path);
      if (typeof params.text !== "string") {
        throw new DriverActionError("vault.assertText requires exact text.");
      }
      const actual = await ctx.app.vault.adapter.read(path);
      if (actual !== params.text) {
        throw new DriverActionError(
          `Vault file "${path}" did not contain the expected exact text.`,
        );
      }
      return { path, exact: true, characters: actual.length };
    }
    case "select": {
      const element = requireTarget(ctx, params.target);
      if (!element.instanceOf(HTMLSelectElement)) {
        throw new DriverActionError("select targets must be a <select> element.");
      }
      const value = typeof params.value === "string" ? params.value : "";
      const options = [...element.options].map((option) => option.value);
      if (!options.includes(value)) {
        throw new DriverActionError(
          `select value "${value}" is not an option. Available: ${options.join(", ")}.`,
        );
      }
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return describeElement(element);
    }
    case "logs": {
      return ctx.diagnostics.readLogs({
        level: typeof params.level === "string" ? params.level : undefined,
        pattern: typeof params.pattern === "string" ? params.pattern : undefined,
        sinceSeq: typeof params.sinceSeq === "number" ? params.sinceSeq : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      });
    }
    case "notices": {
      return ctx.diagnostics.readNotices({
        sinceSeq: typeof params.sinceSeq === "number" ? params.sinceSeq : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      });
    }
    case "catalog": {
      return { testIds: liveTestIdCatalog(ctx) };
    }
    case "query": {
      const css = typeof params.css === "string" ? params.css : "";
      if (!css) throw new DriverActionError("query requires a css selector.");
      const limit = typeof params.limit === "number" ? Math.min(params.limit, 50) : 10;
      const matches: Array<Record<string, unknown>> = [];
      for (const element of queryElements(ctx, css)) {
        if (matches.length >= limit) break;
        matches.push(describeElement(element));
      }
      return { count: matches.length, matches };
    }
    case "snapshot": {
      const scope = typeof params.scope === "string" ? params.scope : "chat";
      if (scope === "chat") return chatSnapshot(ctx);
      if (scope === "settings") return settingsSnapshot(ctx);
      throw new DriverActionError(`snapshot scope must be chat or settings; got "${scope}".`);
    }
    case "waitFor": {
      return waitForCondition(ctx, params);
    }
    case "waitForRun": {
      return waitForRun(ctx, params);
    }
    case "command": {
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) throw new DriverActionError("command requires an Obsidian command id.");
      const executed = (ctx.app as AppWithCommands).commands.executeCommandById(id);
      if (!executed) throw new DriverActionError(`Obsidian command "${id}" did not execute.`);
      return { executed: true, id };
    }
    case "settings.open": {
      const host = ctx.app as AppWithSettings;
      host.setting.open();
      host.setting.openTabById(ctx.pluginId);
      await waitForCondition(ctx, { target: "settings.surface", state: "visible", timeoutMs: 10000 });
      const tab = typeof params.tab === "string" ? params.tab : "";
      if (tab) {
        const button = requireTarget(ctx, `settings.tab:${tab}`);
        pointerSequence(button);
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      return settingsSnapshot(ctx);
    }
    case "settings.close": {
      (ctx.app as AppWithSettings).setting.close();
      return { closed: true };
    }
    default:
      throw new DriverActionError(
        `Unknown driver action "${action}". Available: status, chat.open, click, type, press, ` +
          "attach, scroll, select, read, vault.assertText, query, catalog, logs, notices, snapshot, waitFor, " +
          "command, settings.open, settings.close.",
      );
  }
}

export { DriverActionError };
