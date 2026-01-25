/**
 * @jest-environment node
 */
import { GENERAL_USE_PRESET } from "../general";

describe("GENERAL_USE_PRESET", () => {
  it("has correct id", () => {
    expect(GENERAL_USE_PRESET.id).toBe("general-use");
  });

  it("has correct label", () => {
    expect(GENERAL_USE_PRESET.label).toBe("General Use Preset");
  });

  it("has a description", () => {
    expect(GENERAL_USE_PRESET.description).toBeDefined();
    expect(typeof GENERAL_USE_PRESET.description).toBe("string");
    expect(GENERAL_USE_PRESET.description.length).toBeGreaterThan(0);
  });

  it("is not user configurable", () => {
    expect(GENERAL_USE_PRESET.isUserConfigurable).toBe(false);
  });

  it("has a system prompt", () => {
    expect(GENERAL_USE_PRESET.systemPrompt).toBeDefined();
    expect(typeof GENERAL_USE_PRESET.systemPrompt).toBe("string");
    expect(GENERAL_USE_PRESET.systemPrompt.length).toBeGreaterThan(0);
  });

  it("system prompt describes a helpful AI assistant", () => {
    expect(GENERAL_USE_PRESET.systemPrompt.toLowerCase()).toContain("helpful");
    expect(GENERAL_USE_PRESET.systemPrompt.toLowerCase()).toContain("assistant");
  });

  it("conforms to SystemPromptPreset structure", () => {
    expect(GENERAL_USE_PRESET).toHaveProperty("id");
    expect(GENERAL_USE_PRESET).toHaveProperty("label");
    expect(GENERAL_USE_PRESET).toHaveProperty("description");
    expect(GENERAL_USE_PRESET).toHaveProperty("isUserConfigurable");
    expect(GENERAL_USE_PRESET).toHaveProperty("systemPrompt");
  });
});
