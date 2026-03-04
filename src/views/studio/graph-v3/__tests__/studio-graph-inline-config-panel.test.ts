/** @jest-environment jsdom */

import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import { renderInlineConfigPanel } from "../StudioGraphInlineConfigPanel";

function createNode(overrides?: Partial<StudioNodeInstance>): StudioNodeInstance {
  return {
    id: "node-1",
    kind: "studio.test",
    version: "1.0.0",
    title: "Test Node",
    position: { x: 0, y: 0 },
    config: {},
    ...overrides,
  };
}

function createDefinition(
  fields: StudioNodeDefinition["configSchema"]["fields"],
  defaults: Record<string, unknown> = {}
): StudioNodeDefinition {
  return {
    kind: "studio.test",
    version: "1.0.0",
    capabilityClass: "local_cpu",
    inputPorts: [],
    outputPorts: [],
    configDefaults: defaults as any,
    configSchema: {
      fields,
    },
    execute: async () => ({
      outputs: {},
    }),
  };
}

describe("renderInlineConfigPanel", () => {
  it("renders a text field and mutates node config on input", () => {
    const root = document.createElement("div");
    const node = createNode();
    const definition = createDefinition([
      {
        key: "name",
        label: "Name",
        type: "text",
      },
    ]);
    let mutateCalls = 0;

    const rendered = renderInlineConfigPanel({
      nodeEl: root,
      node,
      definition,
      orderedFieldKeys: ["name"],
      interactionLocked: false,
      onNodeConfigMutated: () => {
        mutateCalls += 1;
      },
    });

    expect(rendered).toBe(true);
    const input = root.querySelector<HTMLInputElement>(
      ".ss-studio-node-inline-config-field--name .ss-studio-node-inline-config-input"
    );
    expect(input).not.toBeNull();

    input!.value = "Hello";
    input!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(node.config.name).toBe("Hello");
    expect(mutateCalls).toBe(1);
  });

  it("updates visibleWhen field visibility after config mutation", () => {
    const root = document.createElement("div");
    const node = createNode();
    const definition = createDefinition(
      [
        {
          key: "enabled",
          label: "Enabled",
          type: "boolean",
        },
        {
          key: "token",
          label: "Token",
          type: "text",
          visibleWhen: {
            key: "enabled",
            equals: true,
          },
        },
      ],
      { enabled: false }
    );
    let mutateCalls = 0;

    const rendered = renderInlineConfigPanel({
      nodeEl: root,
      node,
      definition,
      orderedFieldKeys: ["enabled", "token"],
      interactionLocked: false,
      onNodeConfigMutated: () => {
        mutateCalls += 1;
      },
    });

    expect(rendered).toBe(true);
    const tokenField = root.querySelector<HTMLElement>(".ss-studio-node-inline-config-field--token");
    const enabledCheckbox = root.querySelector<HTMLInputElement>(
      ".ss-studio-node-inline-config-field--enabled .ss-studio-node-inline-config-checkbox"
    );
    expect(tokenField).not.toBeNull();
    expect(enabledCheckbox).not.toBeNull();
    expect(tokenField!.classList.contains("is-hidden")).toBe(true);

    enabledCheckbox!.checked = true;
    enabledCheckbox!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(node.config.enabled).toBe(true);
    expect(tokenField!.classList.contains("is-hidden")).toBe(false);
    expect(mutateCalls).toBe(1);
  });
});
