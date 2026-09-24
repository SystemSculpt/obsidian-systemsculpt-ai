import type { App, KeymapContext, Scope } from "obsidian";

type KeyHandlingScope = {
  handleKey(event: KeyboardEvent, info: KeymapContext): unknown;
};

export type ObsidianKeymapHarness = {
  pushScope(scope: Scope): void;
  popScope(scope: Scope): void;
  dispose(): void;
};

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS"]);

/**
 * Test double for Obsidian's Keymap. One capture-phase window listener hands
 * every key to the top scope of the window stack. The base scope is the
 * workspace scope, which delegates to the active leaf's view scope and falls
 * back to app.scope. Modals push a parentless scope on top, so the view never
 * sees their keys. Returning false prevents and stops the event.
 */
export function installObsidianKeymap(
  app: App,
  getActiveView: () => { scope: Scope | null } | null
): ObsidianKeymapHarness {
  const workspaceScope: KeyHandlingScope = {
    handleKey: (event, info) => {
      const scope = (getActiveView()?.scope ?? app.scope) as unknown as KeyHandlingScope;
      return scope.handleKey(event, info);
    },
  };
  const stack: KeyHandlingScope[] = [workspaceScope];
  const onKeyDown = (event: KeyboardEvent): void => {
    if (MODIFIER_KEYS.has(event.key)) return;
    const modifiers = [
      event.ctrlKey ? "Ctrl" : null,
      event.metaKey ? "Meta" : null,
      event.altKey ? "Alt" : null,
      event.shiftKey ? "Shift" : null,
    ].filter((modifier): modifier is string => modifier !== null).sort().join(",");
    const info = { modifiers, key: event.key, vkey: event.code } as KeymapContext;
    if (stack[stack.length - 1].handleKey(event, info) === false) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  return {
    pushScope: (scope) => {
      stack.push(scope as unknown as KeyHandlingScope);
    },
    popScope: (scope) => {
      const index = stack.lastIndexOf(scope as unknown as KeyHandlingScope);
      if (index > 0) stack.splice(index, 1);
    },
    dispose: () => window.removeEventListener("keydown", onKeyDown, true),
  };
}
