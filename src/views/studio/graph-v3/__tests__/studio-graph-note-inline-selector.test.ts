/**
 * @jest-environment jsdom
 */
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import { renderStudioNodeInlineEditor } from "../StudioGraphNodeInlineEditors";

const IDLE_NODE_RUN_STATE: StudioNodeRunDisplayState = {
  status: "idle",
  message: "",
  updatedAt: null,
  outputs: null,
};

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
      return {
        outputs: {},
      };
    },
  };
}

function nodeFixture(config: StudioNodeInstance["config"] = {}): StudioNodeInstance {
  return {
    id: "node_note",
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

function typeValue(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function toggleValue(element: HTMLInputElement, checked: boolean): void {
  element.checked = checked;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function readNoteItems(node: StudioNodeInstance): Array<{ path: string; enabled: boolean }> {
  const notes = node.config.notes as { items?: Array<{ path: string; enabled: boolean }> } | undefined;
  return Array.isArray(notes?.items) ? notes.items : [];
}

describe("StudioGraphNodeInlineEditors note selector", () => {
  it("shows summary and empty state when no notes are configured", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    expect(nodeEl.querySelector(".ss-studio-note-selector-count")?.textContent?.trim()).toBe("0 notes");
    expect(nodeEl.querySelector(".ss-studio-note-selector-empty")).toBeDefined();
  });

  it("adds a note item with sensible defaults", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();
    const onNodeConfigMutated = jest.fn();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated,
    });

    const addButton = Array.from(nodeEl.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Add Note"
    );
    expect(addButton).toBeDefined();
    click(addButton!);

    expect(readNoteItems(node)).toEqual([
      {
        path: "",
        enabled: true,
      },
    ]);
    expect(onNodeConfigMutated).toHaveBeenCalled();
  });

  it("updates path and include toggle for a note entry", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const addButton = Array.from(nodeEl.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Add Note"
    );
    click(addButton!);

    const pathInput = nodeEl.querySelector<HTMLInputElement>('input[aria-label="Markdown path for note 1"]');
    const enabledToggle = nodeEl.querySelector<HTMLInputElement>(".ss-studio-note-selector-toggle-checkbox");
    const cardIndexLabel = nodeEl.querySelector<HTMLElement>(".ss-studio-note-selector-card-index");

    expect(pathInput).toBeDefined();
    expect(enabledToggle).toBeDefined();
    expect(cardIndexLabel?.textContent?.trim()).toBe("Note 1");

    typeValue(pathInput!, "SystemSculpt/Studio/Offers/AgentOps 1K Plan.md");
    toggleValue(enabledToggle!, false);
    expect(cardIndexLabel?.textContent?.trim()).toBe("Note 1 (AgentOps 1K Plan)");

    expect(readNoteItems(node)).toEqual([
      {
        path: "SystemSculpt/Studio/Offers/AgentOps 1K Plan.md",
        enabled: false,
      },
    ]);
  });

  it("reorders notes with Up/Down actions", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture({
      notes: {
        items: [
          { path: "Notes/First.md", enabled: true },
          { path: "Notes/Second.md", enabled: true },
        ],
      },
    });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
    });

    const moveDownButton = nodeEl.querySelector<HTMLButtonElement>('button[aria-label="Move note 1 down"]');
    expect(moveDownButton).toBeDefined();
    click(moveDownButton!);

    expect(readNoteItems(node).map((item) => item.path)).toEqual([
      "Notes/Second.md",
      "Notes/First.md",
    ]);
  });

  it("keeps editable note paths visible when text editor surface is hidden", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture({
      notes: {
        items: [{ path: "Notes/Context.md", enabled: true }],
      },
    });

    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState: IDLE_NODE_RUN_STATE,
      definition: definitionFixture(),
      interactionLocked: false,
      onNodeConfigMutated: jest.fn(),
      showTextEditor: false,
    });

    const pathInput = nodeEl.querySelector<HTMLInputElement>('input[aria-label="Markdown path for note 1"]');
    expect(pathInput).toBeDefined();
    expect(nodeEl.querySelector(".ss-studio-node-text-editor-wrap")).toBeNull();
  });
});
