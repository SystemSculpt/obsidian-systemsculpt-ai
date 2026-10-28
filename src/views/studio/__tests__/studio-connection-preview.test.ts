import {
  buildSeededPreviewOutputs,
  describeConnectionAutoCreate,
  resolveConnectionAutoCreateTemplate,
  seedAutoCreatedNodeConfig,
} from "../systemsculpt-studio-view/StudioConnectionPreview";
import { cloneJsonValue } from "../StudioViewHelpers";
import type { StudioNodeInstance } from "../../../studio/types";

function node(kind: string): StudioNodeInstance {
  return {
    id: "preview",
    kind,
    version: "1.0.0",
    title: "Preview",
    position: { x: 0, y: 0 },
    config: {},
    continueOnError: false,
    disabled: false,
  };
}

describe("Studio connection previews", () => {
  it.each([
    ["text", "studio.text_output", "text"],
    ["json", "studio.json", "json"],
    ["any", "studio.value", "value"],
    ["number", "studio.value", "value"],
    ["boolean", "studio.value", "value"],
  ])("uses the existing preview template for %s", (type, kind, port) => {
    const template = resolveConnectionAutoCreateTemplate(` ${type} `);
    expect(template).toMatchObject({ nodeKind: kind, targetPortId: port });
    expect(describeConnectionAutoCreate(type)).toEqual({ label: template!.label });
  });

  it("does not offer previews for media outputs", () => {
    expect(resolveConnectionAutoCreateTemplate("image")).toBeNull();
    expect(describeConnectionAutoCreate("image")).toBeNull();
  });

  it("seeds text, structured JSON, and generic values without sharing mutable output data", () => {
    const value = { items: [1, 2] };
    const text = node("studio.text_output");
    const json = node("studio.json");
    const generic = node("studio.value");
    seedAutoCreatedNodeConfig(text, text.kind, value);
    seedAutoCreatedNodeConfig(json, json.kind, value);
    seedAutoCreatedNodeConfig(generic, generic.kind, value);

    expect(text.config.value).toBe(JSON.stringify(value, null, 2));
    expect(json.config.value).toEqual(value);
    expect(json.config.value).not.toBe(value);
    expect(generic.config.__studio_seed_value).toEqual(value);
    expect(generic.config.__studio_seed_value).not.toBe(value);
    expect(buildSeededPreviewOutputs(text.kind, false)).toEqual({ text: "false" });
    expect(buildSeededPreviewOutputs(json.kind, value)).toEqual({ json: value });
    expect(buildSeededPreviewOutputs(generic.kind, null)).toEqual({ value: null });
    expect(cloneJsonValue(value)).not.toBe(value);
  });
});
