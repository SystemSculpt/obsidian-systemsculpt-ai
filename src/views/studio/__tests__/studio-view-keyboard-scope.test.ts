/** @jest-environment jsdom */

jest.mock("obsidian", () => {
  const actual = jest.requireActual("../../../tests/mocks/obsidian.js");
  return { ...actual, Notice: jest.fn() };
});

import { App, ItemView, Scope, WorkspaceLeaf } from "obsidian";
import { createEmptyStudioProject } from "../../../studio/schema";
import { inputNode } from "../../../studio/nodes/inputNode";
import { textNode } from "../../../studio/nodes/textNode";
import { StudioProjectSession } from "../../../studio/StudioProjectSession";
import type { StudioProjectV1 } from "../../../studio/types";
import { SystemSculptStudioView } from "../SystemSculptStudioView";
import { installObsidianKeymap, type ObsidianKeymapHarness } from "./studio-obsidian-keymap-test-helpers";

/**
 * Studio shortcuts live on the view scope. Obsidian hands keys to the active
 * view's scope only while no modal, menu or suggester has pushed its own, so
 * a key pressed in a modal over the canvas must never edit the canvas.
 */
type ViewInternals = {
  currentProject: StudioProjectV1 | null;
  activeCanvasTool: string;
  graphInteraction: { setSelectedNodeIds(ids: string[]): void; getSelectedNodeIds(): string[] };
};

const hostPrototype = ItemView.prototype as unknown as { setState?: () => Promise<void> };
const originalSetState = hostPrototype.setState;

let app: App;
let view: SystemSculptStudioView;
let session: StudioProjectSession;
let keymap: ObsidianKeymapHarness;

function internals(): ViewInternals {
  return view as unknown as ViewInternals;
}

function nodeIds(): string[] {
  return internals().currentProject?.graph.nodes.map((node) => node.id) ?? [];
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function paste(target: EventTarget, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : ""), items: [], files: [] },
  });
  target.dispatchEvent(event);
  return event;
}

/** Stand-in for an Obsidian Modal: parentless scope plus focusable controls outside the view. */
function openModal(): { button: HTMLButtonElement; close(): void } {
  const scope = new Scope();
  scope.register([], "Escape", () => false);
  const modalEl = document.body.createDiv({ cls: "modal-container" });
  const button = modalEl.createEl("button", { text: "Choose model" });
  keymap.pushScope(scope);
  button.focus();
  return {
    button,
    close: () => {
      keymap.popScope(scope);
      modalEl.remove();
    },
  };
}

beforeEach(async () => {
  app = new App();
  app.scope = new Scope();
  Object.assign(app.workspace, { requestSaveLayout: jest.fn() });
  hostPrototype.setState = async () => {};
  const project = createEmptyStudioProject({
    name: "Keys", policyPath: "p", minPluginVersion: "6", maxRuns: 10, maxArtifactsMb: 10,
  });
  project.graph.layout = { mode: "manual" };
  for (const [index, id] of ["first", "second"].entries()) {
    project.graph.nodes.push({
      id, kind: inputNode.kind, version: inputNode.version, title: id, config: { value: id },
      position: { x: 10 + index * 500, y: 10 }, disabled: false, continueOnError: false,
    });
  }
  session = new StudioProjectSession({
    projectPath: "Studio/Keys.systemsculpt",
    project,
    saveProject: async (_path, desired) => ({ project: desired, conflicts: [] }),
  });
  const service = {
    subscribeRunEvents: () => () => {}, getActiveRun: () => null, getLatestRunEvents: async () => [],
    agentRuns: { subscribe: () => () => {}, list: () => [] }, listNodeDefinitions: () => [inputNode, textNode],
    retainProjectSession: async () => session, releaseProjectSession: async () => {},
    getProjectNodeCache: async () => null, consumeBlockedProjectRecovery: async () => null,
  };
  view = new SystemSculptStudioView(new WorkspaceLeaf(app), { getStudioService: () => service, settings: {} } as any);
  jest.spyOn(app.workspace, "getActiveViewOfType").mockImplementation(() => view as any);
  Object.assign(view.contentEl, { onWindowMigrated: () => () => {} });
  document.body.appendChild(view.containerEl);
  await view.onOpen();
  await view.setState({ file: "Studio/Keys.systemsculpt" }, {} as any);
  keymap = installObsidianKeymap(app, () => view);
  internals().graphInteraction.setSelectedNodeIds(["first"]);
  (document.activeElement as HTMLElement | null)?.blur();
});

afterEach(async () => {
  keymap.dispose();
  await view.onClose();
  view.containerEl.remove();
  await session.close();
  document.body.empty();
  hostPrototype.setState = originalSetState;
  jest.restoreAllMocks();
});

describe("Studio view keyboard scope", () => {
  it.each(["Delete", "Backspace"])("deletes the selection with %s when the canvas has the keys", (key) => {
    const event = press(document.body, key);

    expect(event.defaultPrevented).toBe(true);
    expect(nodeIds()).toEqual(["second"]);
  });

  it.each(["Delete", "Backspace", "b", "c", "a", "s", "Escape"])(
    "leaves the canvas alone when %s is pressed in a modal over it",
    (key) => {
      internals().activeCanvasTool = "rectangle";
      const modal = openModal();

      press(modal.button, key);

      expect(nodeIds()).toEqual(["first", "second"]);
      expect(internals().graphInteraction.getSelectedNodeIds()).toEqual(["first"]);
      expect(internals().activeCanvasTool).toBe("rectangle");
      modal.close();
    }
  );

  it("ignores keys and pastes aimed at a surface outside the view that pushed no scope", () => {
    const panelButton = document.body.createEl("button", { text: "Other plugin panel" });
    panelButton.focus();

    const deleteEvent = press(panelButton, "Delete");
    const toolEvent = press(panelButton, "b");
    const pasteEvent = paste(panelButton, "not for Studio");

    expect(deleteEvent.defaultPrevented).toBe(false);
    expect(toolEvent.defaultPrevented).toBe(false);
    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(nodeIds()).toEqual(["first", "second"]);
    expect(internals().activeCanvasTool).toBe("select");
  });

  it("does not listen for keys on the window outside Obsidian's keymap", () => {
    keymap.dispose();

    press(document.body, "Delete");
    press(window, "Delete");

    expect(nodeIds()).toEqual(["first", "second"]);
  });

  it("keeps tool, select-all, fit, and paste shortcuts working through the view", () => {
    expect(press(document.body, "b").defaultPrevented).toBe(true);
    expect(internals().activeCanvasTool).toBe("rectangle");
    press(document.body, "c");
    expect(internals().activeCanvasTool).toBe("ellipse");
    press(document.body, "a");
    expect(internals().activeCanvasTool).toBe("arrow");
    press(document.body, "Escape");
    expect(internals().activeCanvasTool).toBe("select");
    press(document.body, "b");
    press(document.body, "s");
    expect(internals().activeCanvasTool).toBe("select");

    internals().graphInteraction.setSelectedNodeIds([]);
    expect(press(document.body, "a", { code: "KeyA", metaKey: true, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(internals().graphInteraction.getSelectedNodeIds().sort()).toEqual(["first", "second"]);

    const fit = jest.spyOn(view as any, "fitSelectedGraphNodesInViewport").mockReturnValue(true);
    expect(press(document.body, "f", { code: "KeyF", metaKey: true, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(fit).toHaveBeenCalledTimes(1);

    const pasteEvent = paste(document.body, "Pasted note");
    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(internals().currentProject?.graph.nodes.some((node) => node.config.value === "Pasted note")).toBe(true);
  });

  it("lets unhandled keys and typing fall through to Obsidian", () => {
    const hotkey = jest.fn((event: KeyboardEvent) => (event.key === "p" ? false : undefined));
    app.scope.register(null, null, hotkey);
    const input = view.contentEl.createEl("input");
    input.focus();

    expect(press(input, "Delete").defaultPrevented).toBe(false);
    expect(press(document.body, "p", { code: "KeyP", metaKey: true, ctrlKey: true }).defaultPrevented).toBe(true);

    expect(nodeIds()).toEqual(["first", "second"]);
    expect(hotkey).toHaveBeenCalledTimes(2);
  });
});
