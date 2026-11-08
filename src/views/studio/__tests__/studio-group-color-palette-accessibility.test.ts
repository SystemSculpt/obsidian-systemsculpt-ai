/**
 * @jest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StudioProjectV1 } from "../../../studio/types";
import { StudioCanvasGeometry } from "../canvas/StudioCanvasGeometry";
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

it("does not animate group bounds separately from their members", () => {
  const style = document.createElement("style");
  const frame = document.createElement("div");
  style.textContent = readFileSync(resolve(__dirname, "../../../css/views/studio/groups.css"), "utf8");
  frame.className = "ss-studio-group-frame";
  document.head.appendChild(style);
  document.body.appendChild(frame);
  try {
    const transition = getComputedStyle(frame).transition;
    expect(transition).toContain("border-color");
    expect(transition).not.toMatch(/\b(?:left|top|width|height|all)\s/);
  } finally {
    style.remove();
    frame.remove();
  }
});

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
      commitProjectMutation: (_reason, mutator) => mutator(project) !== false,
    }, new StudioCanvasGeometry(() => project));
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
