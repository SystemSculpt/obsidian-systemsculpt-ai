import type { App, WorkspaceLeaf } from "obsidian";

import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";

/**
 * Target resolution for the E2E test driver.
 *
 * The canonical addressing scheme is `data-testid`: every interactive element
 * the product renders carries a dot-namespaced identity stamped by the UI
 * factories (see UiActionOptions.testId). A bare target like
 * `chat.composer.send` resolves to `[data-testid="chat.composer.send"]`.
 *
 * Escape hatches and sugar:
 *
 * - `css:<selector>` resolves document-wide.
 * - `chat:<selector>` resolves inside the open chat view.
 * - `label:<aria-label>` resolves the first visible element with that label.
 * - `setting:<name>` resolves an Obsidian settings row by its visible name
 *   and returns its interactive control.
 * - `settings.tab:<label>` resolves a SystemSculpt settings tab by label.
 * - `chat.view` resolves the chat view container via the workspace.
 */

export interface LocatorContext {
  app: App;
  settingsRoot?: () => HTMLElement | null;
}

function chatContainer(app: App): HTMLElement | null {
  const leaves: WorkspaceLeaf[] = app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
  const activeLeaf = app.workspace.activeLeaf;
  const leaf = activeLeaf && leaves.includes(activeLeaf)
    ? activeLeaf
    : leaves.length === 1
      ? leaves[0]
      : null;
  if (!leaf) return null;
  const view = leaf.view as { containerEl?: HTMLElement } | undefined;
  return view?.containerEl ?? null;
}

function isVisible(element: Element): boolean {
  if (!element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function firstVisible(elements: Iterable<Element>): HTMLElement | null {
  for (const element of elements) {
    if (element.instanceOf(HTMLElement) && isVisible(element)) return element;
  }
  for (const element of elements) {
    if (element.instanceOf(HTMLElement)) return element;
  }
  return null;
}

function inChat(app: App, selector: string): HTMLElement | null {
  const container = chatContainer(app);
  if (!container) return null;
  return firstVisible(container.querySelectorAll(selector));
}

function searchRoots(ctx: LocatorContext): ParentNode[] {
  const chatDocument = chatContainer(ctx.app)?.ownerDocument;
  const roots = [
    chatDocument,
    document,
    ctx.settingsRoot?.()?.ownerDocument,
  ].filter((root): root is Document => root !== undefined);
  return [...new Set(roots)];
}

function inDocuments(ctx: LocatorContext, selector: string): HTMLElement | null {
  return firstVisible(queryElements(ctx, selector));
}

function byAriaLabelInDocuments(ctx: LocatorContext, label: string): HTMLElement | null {
  const matches: Element[] = [];
  for (const root of searchRoots(ctx)) {
    for (const element of root.querySelectorAll("[aria-label]")) {
      if (element.getAttribute("aria-label") === label) matches.push(element);
    }
  }
  return firstVisible(matches);
}

function byTestId(ctx: LocatorContext, id: string): HTMLElement | null {
  const attributeValue = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const selector = `[data-testid="${attributeValue}"]`;
  if (id.startsWith("chat.")) {
    const match = inChat(ctx.app, selector);
    if (match) return match;
    if (ctx.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).length > 0) return null;
  }
  return inDocuments(ctx, selector);
}

const SETTING_CONTROL_SELECTOR =
  "button, input, select, textarea, .checkbox-container, [role='button']";

/**
 * Resolves an Obsidian settings row by its visible name and returns its
 * interactive control (toggle, dropdown, text field, or button). This makes
 * every settings row drivable without per-row markers.
 */
function settingRowControl(ctx: LocatorContext, name: string): HTMLElement | null {
  const wanted = name.trim().toLowerCase();
  const rows: Element[] = [];
  for (const root of searchRoots(ctx)) {
    for (const item of root.querySelectorAll(".setting-item")) {
      const itemName = (item.querySelector(".setting-item-name")?.textContent ?? "")
        .trim()
        .toLowerCase();
      if (itemName === wanted) rows.push(item);
    }
  }
  if (rows.length === 0) {
    for (const root of searchRoots(ctx)) {
      for (const item of root.querySelectorAll(".setting-item")) {
        const itemName = (item.querySelector(".setting-item-name")?.textContent ?? "")
          .trim()
          .toLowerCase();
        if (itemName.includes(wanted)) rows.push(item);
      }
    }
  }
  const row = firstVisible(rows);
  if (!row) return null;
  const control = row.querySelector(".setting-item-control");
  if (control) {
    const interactive = firstVisible(control.querySelectorAll(SETTING_CONTROL_SELECTOR));
    if (interactive) return interactive;
    if (control.instanceOf(HTMLElement)) return control;
  }
  return row;
}

function settingsTabButton(ctx: LocatorContext, label: string): HTMLElement | null {
  const bar = inDocuments(ctx, ".ss-settings-tab-bar");
  if (!bar) return null;
  const wanted = label.trim().toLowerCase();
  const exact: Element[] = [];
  const partial: Element[] = [];
  for (const button of bar.querySelectorAll("button, [role='tab']")) {
    const text = (button.textContent ?? "").trim().toLowerCase();
    if (text === wanted) exact.push(button);
    else if (text.includes(wanted)) partial.push(button);
  }
  return firstVisible(exact.length > 0 ? exact : partial);
}

const SEMANTIC_TARGETS: Record<string, (ctx: LocatorContext) => HTMLElement | null> = {
  "chat.view": ({ app }) => chatContainer(app),
  "settings.surface": (ctx) => inDocuments(ctx, ".ss-settings-surface"),
  "settings.tab-bar": (ctx) => inDocuments(ctx, ".ss-settings-tab-bar"),
};

export function resolveTarget(ctx: LocatorContext, target: string): HTMLElement | null {
  const trimmed = target.trim();
  if (trimmed.startsWith("css:")) return inDocuments(ctx, trimmed.slice(4));
  if (trimmed.startsWith("chat:")) return inChat(ctx.app, trimmed.slice(5));
  if (trimmed.startsWith("label:")) return byAriaLabelInDocuments(ctx, trimmed.slice(6));
  if (trimmed.startsWith("setting:")) return settingRowControl(ctx, trimmed.slice(8));
  if (trimmed.startsWith("testid:")) return byTestId(ctx, trimmed.slice(7));
  if (trimmed.startsWith("settings.tab:")) {
    return settingsTabButton(ctx, trimmed.slice("settings.tab:".length));
  }
  const marked = byTestId(ctx, trimmed);
  if (marked) return marked;
  const semantic = SEMANTIC_TARGETS[trimmed];
  if (semantic) return semantic(ctx);
  return null;
}

export function knownSemanticTargets(): string[] {
  return [
    ...Object.keys(SEMANTIC_TARGETS),
    "settings.tab:<label>",
    "setting:<row name>",
  ];
}

export function queryElements(ctx: LocatorContext, selector: string): HTMLElement[] {
  const matches: HTMLElement[] = [];
  for (const root of searchRoots(ctx)) {
    for (const element of root.querySelectorAll(selector)) {
      if (element.instanceOf(HTMLElement)) matches.push(element);
    }
  }
  return matches;
}

export function queryChatElements(app: App, selector: string): HTMLElement[] {
  const container = chatContainer(app);
  if (!container) return [];
  return [...container.querySelectorAll(selector)]
    .filter((element): element is HTMLElement => element.instanceOf(HTMLElement));
}

/** Lists every `data-testid` currently in the DOM with its visibility. */
export function liveTestIdCatalog(
  ctx: LocatorContext,
): Array<{ id: string; visible: boolean; count: number }> {
  const byId = new Map<string, { visible: boolean; count: number }>();
  for (const root of searchRoots(ctx)) {
    for (const element of root.querySelectorAll("[data-testid]")) {
      const id = element.getAttribute("data-testid");
      if (!id) continue;
      const entry = byId.get(id) ?? { visible: false, count: 0 };
      entry.count += 1;
      entry.visible = entry.visible || isVisible(element);
      byId.set(id, entry);
    }
  }
  return [...byId.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function describeElement(element: HTMLElement | null): Record<string, unknown> {
  if (!element) return { exists: false };
  const rect = element.getBoundingClientRect();
  const summary: Record<string, unknown> = {
    exists: true,
    tag: element.tagName.toLowerCase(),
    classes: [...element.classList],
    visible: isVisible(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    text: (element.textContent ?? "").trim().slice(0, 400),
  };
  const testId = element.getAttribute("data-testid");
  if (testId) summary.testId = testId;
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) summary.ariaLabel = ariaLabel;
  if (
    element.instanceOf(HTMLInputElement) ||
    element.instanceOf(HTMLTextAreaElement) ||
    element.instanceOf(HTMLSelectElement)
  ) {
    summary.value = element.value;
    summary.disabled = element.disabled;
  }
  if (element.instanceOf(HTMLButtonElement)) summary.disabled = element.disabled;
  return summary;
}

export { chatContainer, isVisible };
