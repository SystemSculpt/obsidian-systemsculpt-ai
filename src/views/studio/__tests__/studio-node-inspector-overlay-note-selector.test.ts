/**
 * @jest-environment jsdom
 */
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../studio/types";
import { StudioNodeInspectorOverlay } from "../StudioNodeInspectorOverlay";

function definitionFixture(): StudioNodeDefinition {
  return {
    kind: "studio.note",
    version: "1.0.0",
    capabilityClass: "local_io",
    cachePolicy: "never",
    inputPorts: [],
    outputPorts: [{ id: "text", type: "text" }],
    configDefaults: {
      notes: { items: [] },
    },
    configSchema: {
      fields: [
        {
          key: "notes",
          label: "Notes",
          type: "note_selector",
          required: true,
        },
      ],
      allowUnknownKeys: true,
    },
    async execute() {
      return { outputs: {} };
    },
  };
}

function nodeFixture(config: StudioNodeInstance["config"] = {}): StudioNodeInstance {
  return {
    id: "note_node",
    kind: "studio.note",
    version: "1.0.0",
    title: "Campaign Brief",
    position: { x: 0, y: 0 },
    config,
    continueOnError: false,
    disabled: false,
  };
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function readItems(node: StudioNodeInstance): Array<{ path: string; enabled: boolean }> {
  const notes = node.config.notes as { items?: Array<{ path: string; enabled: boolean }> } | undefined;
  return Array.isArray(notes?.items) ? notes.items : [];
}

describe("StudioNodeInspectorOverlay note selector", () => {
  it("renders empty note-selector state with summary", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const host = {
      isBusy: () => false,
      onConfigMutated: jest.fn(),
      onTransientFieldError: jest.fn(),
    };
    const overlay = new StudioNodeInspectorOverlay(host);
    const node = nodeFixture();

    overlay.mount(viewport);
    overlay.showNode(node, definitionFixture());

    expect(viewport.querySelector(".ss-studio-note-selector-count")?.textContent?.trim()).toBe("0 notes");
    expect(viewport.querySelector(".ss-studio-note-selector-empty")).toBeDefined();

    overlay.destroy();
    viewport.remove();
  });

  it("adds and reorders notes from inspector actions", () => {
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    const host = {
      isBusy: () => false,
      onConfigMutated: jest.fn(),
      onTransientFieldError: jest.fn(),
    };
    const overlay = new StudioNodeInspectorOverlay(host);
    const node = nodeFixture({
      notes: {
        items: [
          { path: "Notes/First.md", enabled: true },
          { path: "Notes/Second.md", enabled: true },
        ],
      },
    });

    overlay.mount(viewport);
    overlay.showNode(node, definitionFixture());
    const firstCardLabel = viewport.querySelector<HTMLElement>(".ss-studio-note-selector-card-index");
    expect(firstCardLabel?.textContent?.trim()).toBe("Note 1 (First)");

    const addButton = viewport.querySelector<HTMLButtonElement>('button[aria-label="Add note entry"]');
    expect(addButton).toBeDefined();
    click(addButton!);
    expect(readItems(node)).toHaveLength(3);

    const moveDownButton = viewport.querySelector<HTMLButtonElement>('button[aria-label="Move note 1 down"]');
    expect(moveDownButton).toBeDefined();
    click(moveDownButton!);
    expect(readItems(node).map((item) => item.path)).toEqual([
      "Notes/Second.md",
      "Notes/First.md",
      "",
    ]);
    const reorderedFirstLabel = viewport.querySelector<HTMLElement>(".ss-studio-note-selector-card-index");
    expect(reorderedFirstLabel?.textContent?.trim()).toBe("Note 1 (Second)");
    expect(host.onConfigMutated).toHaveBeenCalled();

    overlay.destroy();
    viewport.remove();
  });
});
