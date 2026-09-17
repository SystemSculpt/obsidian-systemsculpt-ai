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

  it("uses config value change callbacks while still refreshing visibleWhen state", () => {
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
    const onNodeConfigMutated = jest.fn();
    const onNodeConfigValueChange = jest.fn((nodeId: string, key: string, value: unknown) => {
      expect(nodeId).toBe(node.id);
      node.config[key] = value as never;
    });

    const rendered = renderInlineConfigPanel({
      nodeEl: root,
      node,
      definition,
      orderedFieldKeys: ["enabled", "token"],
      interactionLocked: false,
      onNodeConfigMutated,
      onNodeConfigValueChange,
    });

    expect(rendered).toBe(true);
    const tokenField = root.querySelector<HTMLElement>(".ss-studio-node-inline-config-field--token");
    const enabledCheckbox = root.querySelector<HTMLInputElement>(
      ".ss-studio-node-inline-config-field--enabled .ss-studio-node-inline-config-checkbox"
    );
    expect(tokenField?.classList.contains("is-hidden")).toBe(true);

    enabledCheckbox!.checked = true;
    enabledCheckbox!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(node.config.enabled).toBe(true);
    expect(tokenField?.classList.contains("is-hidden")).toBe(false);
    expect(onNodeConfigValueChange).toHaveBeenCalledWith(
      node.id,
      "enabled",
      true,
      expect.objectContaining({ mode: "discrete" })
    );
    expect(onNodeConfigMutated).not.toHaveBeenCalled();
  });
});

it("edits typed process port arrays without converting them to JSON objects", () => {
  const root = document.createElement("div");
  const node = createNode({ kind: "studio.process", config: { outputs: [{ id: "snapshot", type: "json", required: true }] } });
  const onMutation = jest.fn();
  renderInlineConfigPanel({ nodeEl: root, node, definition: createDefinition([{ key: "outputs", label: "Output ports", type: "port_list", portDirection: "output" }]), orderedFieldKeys: ["outputs"], interactionLocked: false, onNodeConfigMutated: onMutation });
  const editor = root.querySelector("textarea")!;
  expect(JSON.parse(editor.value)).toEqual(node.config.outputs);
  editor.value = '[{"id":"report","type":"text","required":true}]';
  editor.dispatchEvent(new Event("blur"));
  expect(node.config.outputs).toEqual([{ id: "report", type: "text", required: true }]);
  expect(onMutation).toHaveBeenCalledTimes(1);
  editor.value = "[]";
  editor.dispatchEvent(new Event("blur"));
  expect(node.config.outputs).toEqual([]);
});

it.each([
  { type: "text", raw: "changed", event: "input", expected: "changed", mode: "continuous" },
  { type: "textarea", raw: "two\nlines", event: "input", expected: "two\nlines", mode: "continuous" },
  { type: "number", raw: "99", event: "change", expected: 10, mode: "discrete" },
  { type: "boolean", raw: "", event: "change", expected: true, mode: "discrete" },
  { type: "select", raw: "second", event: "change", expected: "second", mode: "discrete" },
  { type: "json_object", raw: '{"answer":42}', event: "blur", expected: { answer: 42 }, mode: "discrete" },
  { type: "port_list", raw: '[{"id":"answer","type":"text"}]', event: "blur", expected: [{ id: "answer", type: "text" }], mode: "discrete" },
  { type: "string_list", raw: " one\n\ntwo ", event: "input", expected: ["one", "two"], mode: "continuous" },
  { type: "file_path", raw: "notes/source.md", event: "input", expected: "notes/source.md", mode: "continuous" },
  { type: "directory_path", raw: "notes", event: "input", expected: "notes", mode: "continuous" },
  { type: "media_path", raw: "images/source.png", event: "input", expected: "images/source.png", mode: "continuous" },
] as const)("commits $type through the owning node mutation callback", ({ type, raw, event, expected, mode }) => {
  const node = createNode({ config: { unrelated: "preserved" } });
  const root = document.createElement("div");
  const committed = jest.fn();
  const mutated = jest.fn();
  const definition = createDefinition([{ key: "setting", label: "Setting", type, min: 0, max: 10, options: [{ value: "second", label: "Second" }] }]);
  renderInlineConfigPanel({ nodeEl: root, node, definition, orderedFieldKeys: ["setting"], interactionLocked: false,
    onNodeConfigMutated: mutated, onNodeConfigValueChange: committed });
  const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")!;
  field.value = raw;
  if (field instanceof HTMLInputElement && type === "boolean") field.checked = true;
  field.dispatchEvent(new Event(event, { bubbles: true }));
  expect(committed).toHaveBeenCalledTimes(1);
  expect(committed).toHaveBeenCalledWith(node.id, "setting", expected, { mode });
  expect(mutated).not.toHaveBeenCalled();
  expect(node.config).toEqual({ unrelated: "preserved" });
});
