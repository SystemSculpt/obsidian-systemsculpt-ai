import type { App } from "obsidian";

import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import {
  chatContainer,
  describeElement,
  liveTestIdCatalog,
  queryElements,
  resolveTarget,
} from "./locators";
import {
  type ActionContext,
  DriverActionError,
  type DriverActionHandlers,
  pointerSequence,
  requireTarget,
  setNativeValue,
  validatedVaultPath,
} from "./actionCore";
import {
  captureRunSubmissionBaseline,
  chatSnapshot,
  pendingRunSubmissions,
  settingsSnapshot,
  waitForCondition,
  waitForFailedTurnRetryAdmission,
} from "./snapshotsAndWaits";
import { developmentChatOwners } from "./chatDevelopmentState";

/**
 * The driver's generic actions: its status, and what a person does on the
 * live UI (open chat, click, type, press, attach, scroll, select, read or
 * query targets, run a command, open or close settings), plus the driver's
 * captured logs and notices and exact vault assertions.
 */

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

function driverStatus(ctx: ActionContext): Record<string, unknown> {
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

async function openChat(ctx: ActionContext): Promise<Record<string, unknown>> {
  const leaves = ctx.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
  const activeLeaf = ctx.app.workspace.getMostRecentLeaf();
  const existing = activeLeaf && leaves.includes(activeLeaf)
    ? activeLeaf
    : leaves[0];
  if (existing) {
    await ctx.app.workspace.revealLeaf(existing);
  } else {
    const leaf = ctx.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    await ctx.app.workspace.revealLeaf(leaf);
  }
  await waitForCondition(ctx, { target: "chat.composer.input", state: "visible", timeoutMs: 10000 });
  return chatSnapshot(ctx);
}

async function clickTarget(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const element = requireTarget(ctx, params.target);
  const isFailedTurnRetry = element === resolveTarget(ctx, "chat.turn.retry-failed");
  const retryContainer = isFailedTurnRetry ? chatContainer(ctx.app) : null;
  const retryUserTurns = retryContainer?.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-turn.is-user",
  );
  const priorRetryUserTurn = retryUserTurns?.[retryUserTurns.length - 1] ?? null;
  const priorRetryMessageId = priorRetryUserTurn?.dataset.messageId ?? "";
  const submissionBaseline = (
    element === resolveTarget(ctx, "chat.composer.send")
    || isFailedTurnRetry
  )
    ? captureRunSubmissionBaseline(ctx)
    : null;
  element.scrollIntoView({ block: "nearest" });
  pointerSequence(element);
  if (
    typeof params.immediateTextEquals === "string"
    && (element.textContent ?? "").trim() !== params.immediateTextEquals
  ) {
    throw new DriverActionError("The clicked control did not enter its expected immediate state.");
  }
  if (submissionBaseline) {
    pendingRunSubmissions.set(ctx.app, submissionBaseline);
    if (isFailedTurnRetry) {
      const ownership = developmentChatOwners.get(ctx.app);
      if (ownership) {
        ownership.approvalClearedAfterGrant = false;
        ownership.approvalGranted = false;
        ownership.runObserved = false;
        ownership.submissionAttempted = true;
        ownership.submissionBaseline = submissionBaseline;
      }
    }
  }
  if (isFailedTurnRetry) {
    const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(0, Math.min(params.timeoutMs, 60000))
      : 20000;
    await waitForFailedTurnRetryAdmission(
      ctx,
      priorRetryUserTurn,
      priorRetryMessageId,
      timeoutMs,
    );
    const ownership = developmentChatOwners.get(ctx.app);
    if (ownership) ownership.runObserved = true;
  }
  return describeElement(element);
}

function typeIntoTarget(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const element = requireTarget(ctx, params.target, "chat.composer.input");
  const text = typeof params.text === "string" ? params.text : "";
  const mode = params.mode === "append" ? "append" : "replace";
  setNativeValue(element, text, mode);
  if (params.submit === true) {
    const submissionBaseline = captureRunSubmissionBaseline(ctx);
    element.dispatchEvent(new KeyboardEvent("keydown", keyboardEventInit({ key: "Enter" })));
    element.dispatchEvent(new KeyboardEvent("keyup", keyboardEventInit({ key: "Enter" })));
    pendingRunSubmissions.set(ctx.app, submissionBaseline);
  }
  return describeElement(element);
}

function pressKey(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const element = requireTarget(ctx, params.target, "chat.composer.input");
  const init = keyboardEventInit(params);
  const submissionBaseline = init.key === "Enter"
    && !init.shiftKey
    && element === resolveTarget(ctx, "chat.composer.input")
    ? captureRunSubmissionBaseline(ctx)
    : null;
  element.focus();
  element.dispatchEvent(new KeyboardEvent("keydown", init));
  element.dispatchEvent(new KeyboardEvent("keyup", init));
  if (submissionBaseline) pendingRunSubmissions.set(ctx.app, submissionBaseline);
  return describeElement(element);
}

function attachFile(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
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

function scrollTarget(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const element = requireTarget(ctx, params.target, "chat.scroller");
  if (params.to === "top") element.scrollTop = 0;
  else if (params.to === "bottom") element.scrollTop = element.scrollHeight;
  else if (typeof params.deltaY === "number") element.scrollTop += params.deltaY;
  else throw new DriverActionError("scroll requires to=top|bottom or a numeric deltaY.");
  element.dispatchEvent(new Event("scroll", { bubbles: true }));
  return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
}

async function assertVaultText(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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

function assertVaultFolder(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const path = validatedVaultPath(params.path);
  const value = ctx.app.vault.getAbstractFileByPath(path) as unknown;
  if (
    typeof value !== "object"
    || value === null
    || (value as { path?: unknown }).path !== path
    || !Array.isArray((value as { children?: unknown }).children)
  ) {
    throw new DriverActionError(`Vault path "${path}" is not an exact folder.`);
  }
  return {
    path,
    folder: true,
    childCount: (value as { children: unknown[] }).children.length,
  };
}

function selectOption(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
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

function queryTargets(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
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

function runCommand(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const id = typeof params.id === "string" ? params.id : "";
  if (!id) throw new DriverActionError("command requires an Obsidian command id.");
  const executed = (ctx.app as AppWithCommands).commands.executeCommandById(id);
  if (!executed) throw new DriverActionError(`Obsidian command "${id}" did not execute.`);
  return { executed: true, id };
}

async function openSettings(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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

export const DOM_ACTIONS: DriverActionHandlers = {
  status: driverStatus,
  "chat.open": openChat,
  click: clickTarget,
  type: typeIntoTarget,
  press: pressKey,
  attach: attachFile,
  scroll: scrollTarget,
  select: selectOption,
  read: (ctx, params) => describeElement(requireTarget(ctx, params.target)),
  "vault.assertText": assertVaultText,
  "vault.assertFolder": assertVaultFolder,
  query: queryTargets,
  catalog: (ctx) => ({ testIds: liveTestIdCatalog(ctx) }),
  logs: (ctx, params) => ctx.diagnostics.readLogs({
    level: typeof params.level === "string" ? params.level : undefined,
    pattern: typeof params.pattern === "string" ? params.pattern : undefined,
    sinceSeq: typeof params.sinceSeq === "number" ? params.sinceSeq : undefined,
    limit: typeof params.limit === "number" ? params.limit : undefined,
  }),
  notices: (ctx, params) => ctx.diagnostics.readNotices({
    sinceSeq: typeof params.sinceSeq === "number" ? params.sinceSeq : undefined,
    limit: typeof params.limit === "number" ? params.limit : undefined,
  }),
  command: runCommand,
  "settings.open": openSettings,
  "settings.close": (ctx) => {
    (ctx.app as AppWithSettings).setting.close();
    return { closed: true };
  },
};
