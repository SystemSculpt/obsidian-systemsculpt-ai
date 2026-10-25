import type { App } from "obsidian";

import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { sha256HexFromBytesPortable } from "../../utils/sha256";
import type { ChatMessage } from "../../types";
import type { SupportDiagnosticEvent } from "../../utils/PluginLogger";
import type { DriverDiagnostics } from "./diagnostics";
import { knownSemanticTargets, resolveTarget } from "./locators";

/**
 * What every driver action shares: its context, its error type, cancellation,
 * and the DOM primitives (target lookup, synthesized pointer input, native
 * value setting) that each area's handlers build on.
 */

export interface ActionContext {
  app: App;
  pluginId: string;
  pluginVersion: string;
  buildStamp: string;
  diagnostics: DriverDiagnostics;
  readSupportDiagnostics?: () => readonly SupportDiagnosticEvent[];
  signal?: AbortSignal;
  settingsRoot?: () => HTMLElement | null;
}

export type DriverActionHandler = (
  ctx: ActionContext,
  params: Record<string, unknown>,
) => unknown;

/** One area's actions, keyed by the action name a scenario sends. */
export type DriverActionHandlers = Readonly<Record<string, DriverActionHandler>>;

export class DriverActionError extends Error {}

export function throwIfActionCancelled(ctx: ActionContext): void {
  if (ctx.signal?.aborted) throw new DriverActionError("Driver action cancelled.");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asDriverActionError(error: unknown): Error {
  return error instanceof Error ? error : new DriverActionError(errorMessage(error));
}

export interface DevelopmentChatView {
  agent?: Readonly<{
    active?: Readonly<{
      approvalDecisions?: ReadonlyMap<string, unknown>;
      executingToolIds?: ReadonlySet<string>;
      toolIdentities?: ReadonlyMap<string, Readonly<{
        canonicalInput: string;
        toolName: string;
      }>>;
      toolTasks?: ReadonlyMap<string, unknown>;
    }> | null;
    pendingApprovalDeliveries?: ReadonlyMap<string, unknown>;
    pendingDeliveries?: ReadonlyMap<string, unknown>;
  }>;
  chatId: string;
  /** The hosted chat's vault-change mode, shown and changed in the run line. */
  approvalMode: string;
  containerEl: HTMLElement;
  messages: readonly Readonly<ChatMessage>[];
  getChatHistoryFilePath(): string | null;
  getExpectedChatHistoryFilePath(): string | null;
  loadChatById(chatId: string): Promise<void>;
}

export function activeChatView(ctx: ActionContext): DevelopmentChatView | null {
  const leaves = ctx.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
  const active = ctx.app.workspace.getMostRecentLeaf();
  const leaf = active && leaves.includes(active) ? active : leaves.length === 1 ? leaves[0] : null;
  if (!leaf) return null;
  const view = leaf.view as Partial<DevelopmentChatView>;
  return typeof view.getChatHistoryFilePath === "function"
    && typeof view.getExpectedChatHistoryFilePath === "function"
    && typeof view.loadChatById === "function"
    && view.containerEl?.instanceOf(HTMLElement)
    ? view as DevelopmentChatView
    : null;
}

export function requireTarget(ctx: ActionContext, target: unknown, fallback?: string): HTMLElement {
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

export function pointerSequence(element: HTMLElement): void {
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

export function setNativeValue(element: HTMLElement, text: string, mode: "replace" | "append"): void {
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

export function validatedVaultPath(value: unknown): string {
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

export function revealActivityTarget(ctx: ActionContext, target: string): HTMLElement | null {
  const element = resolveTarget(ctx, target);
  const body = element?.closest<HTMLElement>(".systemsculpt-agent-activity-overflow-body");
  const disclosure = body?.previousElementSibling;
  if (
    disclosure?.instanceOf(HTMLButtonElement)
    && disclosure.matches("button[data-agent-activity-overflow]")
    && disclosure.getAttribute("aria-expanded") === "false"
  ) {
    disclosure.click();
  }
  return resolveTarget(ctx, target);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function composerDraft(input: HTMLElement | null): string {
  if (input?.instanceOf(HTMLTextAreaElement) || input?.instanceOf(HTMLInputElement)) {
    return input.value;
  }
  return input?.isContentEditable ? input.textContent ?? "" : "";
}

export function sha256OfText(text: string): string {
  return sha256HexFromBytesPortable(new TextEncoder().encode(text));
}
