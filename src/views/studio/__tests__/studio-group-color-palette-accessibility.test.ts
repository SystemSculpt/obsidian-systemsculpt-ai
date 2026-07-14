/**
 * @jest-environment jsdom
 */
import type { StudioProjectV1 } from "../../../studio/types";
import { StudioGraphGroupController } from "../StudioGraphGroupController";

function createProject(): StudioProjectV1 {
  return {
    graph: {
      nodes: [
        {
          id: "node-1",
          kind: "studio.input",
          version: "1.0.0",
          title: "Input",
          position: { x: 100, y: 100 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [],
      entryNodeIds: ["node-1"],
      groups: [
        {
          id: "group-1",
          name: "Group",
          nodeIds: ["node-1"],
          color: "#8de8bc",
        },
      ],
    },
  } as unknown as StudioProjectV1;
}

describe("Studio group color palette accessibility", () => {
  it("links its trigger and supports checked roving radio selection", () => {
    const project = createProject();
    const controller = new StudioGraphGroupController({
      isBusy: () => false,
      getCurrentProject: () => project,
      getGraphZoom: () => 1,
      getNodeElement: () => null,
      notifyNodePositionsChanged: () => undefined,
      requestRender: () => undefined,
      scheduleProjectSave: () => undefined,
      commitProjectMutation: (_reason, mutator) => mutator(project) !== false,
    });
    const canvas = document.body.createDiv();
    controller.registerCanvasElement(canvas);
    controller.renderGroupLayer();

    const closedTrigger = canvas.querySelector<HTMLButtonElement>(
      ".ss-studio-group-color-button"
    );
    expect(closedTrigger?.getAttribute("aria-haspopup")).toBe("true");
    expect(closedTrigger?.getAttribute("aria-expanded")).toBe("false");
    expect(closedTrigger?.getAttribute("aria-controls")).toBeTruthy();

    closedTrigger?.click();

    const openTrigger = canvas.querySelector<HTMLButtonElement>(
      ".ss-studio-group-color-button"
    );
    const palette = canvas.querySelector<HTMLElement>(".ss-studio-group-color-palette");
    const radios = Array.from(
      canvas.querySelectorAll<HTMLButtonElement>(".ss-studio-group-color-swatch")
    );
    expect(palette?.getAttribute("data-ss-surface")).toBe("transient");
    expect(openTrigger?.getAttribute("aria-expanded")).toBe("true");
    expect(openTrigger?.getAttribute("aria-controls")).toBe(palette?.id);
    expect(palette?.getAttribute("role")).toBe("radiogroup");
    expect(palette?.getAttribute("aria-label")).toBe("Group color");
    expect(radios.length).toBeGreaterThan(1);
    expect(radios.every((radio) => radio.getAttribute("role") === "radio")).toBe(true);
    expect(radios.filter((radio) => radio.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([
      0,
      ...Array.from({ length: radios.length - 1 }, () => -1),
    ]);

    radios[0]?.focus();
    radios[0]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
    );

    expect(document.activeElement).toBe(radios[1]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("false");
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]?.tabIndex).toBe(-1);
    expect(radios[1]?.tabIndex).toBe(0);
    expect(project.graph.groups?.[0]?.color).toBe("#7be7e6");

    radios[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(radios[radios.length - 1]);
    expect(radios[radios.length - 1]?.getAttribute("aria-checked")).toBe("true");

    radios[radios.length - 1]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true })
    );
    expect(document.activeElement).toBe(radios[0]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");

    controller.clearRenderBindings();
  });
});
