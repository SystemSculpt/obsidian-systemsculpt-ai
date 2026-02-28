import { resolveStudioSearchableSelectPlaceholder } from "../StudioSelectFieldHelpers";

describe("StudioSelectFieldHelpers", () => {
  it("returns default placeholder for optional searchable select fields", () => {
    const placeholder = resolveStudioSearchableSelectPlaceholder({
      key: "modelId",
      label: "Model",
      type: "select",
      required: false,
    } as any);

    expect(placeholder).toBe("Default");
  });

  it("returns a label-specific placeholder for required searchable select fields", () => {
    const placeholder = resolveStudioSearchableSelectPlaceholder({
      key: "reasoningEffort",
      label: "Reasoning Level",
      type: "select",
      required: true,
    } as any);

    expect(placeholder).toBe("Select reasoning level");
  });
});
