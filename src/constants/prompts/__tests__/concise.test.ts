/**
 * @jest-environment node
 */
import { CONCISE_PRESET } from "../concise";

describe("CONCISE_PRESET", () => {
  it("has correct id", () => {
    expect(CONCISE_PRESET.id).toBe("concise");
  });

  it("has correct label", () => {
    expect(CONCISE_PRESET.label).toBe("Concise Preset");
  });

  it("has a description", () => {
    expect(CONCISE_PRESET.description).toBeDefined();
    expect(typeof CONCISE_PRESET.description).toBe("string");
    expect(CONCISE_PRESET.description.length).toBeGreaterThan(0);
  });

  it("description mentions brevity or shortness", () => {
    const desc = CONCISE_PRESET.description.toLowerCase();
    expect(desc.includes("short") || desc.includes("brief") || desc.includes("direct")).toBe(true);
  });

  it("is not user configurable", () => {
    expect(CONCISE_PRESET.isUserConfigurable).toBe(false);
  });

  it("has a system prompt", () => {
    expect(CONCISE_PRESET.systemPrompt).toBeDefined();
    expect(typeof CONCISE_PRESET.systemPrompt).toBe("string");
    expect(CONCISE_PRESET.systemPrompt.length).toBeGreaterThan(0);
  });

  it("system prompt emphasizes brevity", () => {
    const prompt = CONCISE_PRESET.systemPrompt.toLowerCase();
    expect(
      prompt.includes("concise") || prompt.includes("brief") || prompt.includes("short")
    ).toBe(true);
  });

  it("conforms to SystemPromptPreset structure", () => {
    expect(CONCISE_PRESET).toHaveProperty("id");
    expect(CONCISE_PRESET).toHaveProperty("label");
    expect(CONCISE_PRESET).toHaveProperty("description");
    expect(CONCISE_PRESET).toHaveProperty("isUserConfigurable");
    expect(CONCISE_PRESET).toHaveProperty("systemPrompt");
  });

  it("has a shorter system prompt than general use", () => {
    // Concise preset should have a short prompt
    expect(CONCISE_PRESET.systemPrompt.length).toBeLessThan(200);
  });
});
