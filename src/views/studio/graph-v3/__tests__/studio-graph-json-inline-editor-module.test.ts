/**
 * @jest-environment jsdom
 */
import type { StudioNodeInstance } from "../../../../studio/types";
import { renderJsonNodeEditor } from "../StudioGraphJsonInlineEditor";

function nodeFixture(config: StudioNodeInstance["config"] = {}): StudioNodeInstance {
  return {
    id: "node_json",
    kind: "studio.json",
    version: "1.0.0",
    title: "JSON",
    position: { x: 0, y: 0 },
    config,
    continueOnError: false,
    disabled: false,
  };
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function typeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("renderJsonNodeEditor module seam", () => {
  it("renders composer surface and mutates config value", () => {
    const nodeEl = document.createElement("div");
    const node = nodeFixture();
    const onNodeConfigMutated = jest.fn();

    const rendered = renderJsonNodeEditor({
      nodeEl,
      node,
      nodeRunState: {
        status: "idle",
        message: "",
        updatedAt: null,
        outputs: null,
      },
      interactionLocked: false,
      onNodeConfigMutated,
    });

    expect(rendered).toBe(true);
    const addButton = Array.from(nodeEl.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Add Field"
    );
    expect(addButton).toBeDefined();
    click(addButton!);

    const keyInput = nodeEl.querySelector<HTMLInputElement>(".ss-studio-node-json-row-key");
    const valueInput = nodeEl.querySelector<HTMLInputElement>(".ss-studio-node-json-row-value");
    expect(keyInput).toBeDefined();
    expect(valueInput).toBeDefined();

    typeValue(keyInput!, "subject");
    typeValue(valueInput!, "Refactor complete");

    expect(node.config.value).toEqual({
      subject: "Refactor complete",
    });
    expect(onNodeConfigMutated).toHaveBeenCalled();
  });
});
