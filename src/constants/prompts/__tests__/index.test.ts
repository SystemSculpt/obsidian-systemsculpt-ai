/**
 * @jest-environment node
 */
import {
  GENERAL_USE_PRESET,
  CONCISE_PRESET,
  AGENT_PRESET,
  LOCAL_SYSTEM_PROMPTS,
} from "../index";

describe("prompts/index exports", () => {
  describe("GENERAL_USE_PRESET export", () => {
    it("exports GENERAL_USE_PRESET", () => {
      expect(GENERAL_USE_PRESET).toBeDefined();
    });

    it("has correct id", () => {
      expect(GENERAL_USE_PRESET.id).toBe("general-use");
    });
  });

  describe("CONCISE_PRESET export", () => {
    it("exports CONCISE_PRESET", () => {
      expect(CONCISE_PRESET).toBeDefined();
    });

    it("has correct id", () => {
      expect(CONCISE_PRESET.id).toBe("concise");
    });
  });

  describe("AGENT_PRESET export", () => {
    it("exports AGENT_PRESET", () => {
      expect(AGENT_PRESET).toBeDefined();
    });

    it("has correct id", () => {
      expect(AGENT_PRESET.id).toBe("agent");
    });
  });

  describe("LOCAL_SYSTEM_PROMPTS", () => {
    it("is an array", () => {
      expect(Array.isArray(LOCAL_SYSTEM_PROMPTS)).toBe(true);
    });

    it("contains 3 presets", () => {
      expect(LOCAL_SYSTEM_PROMPTS.length).toBe(3);
    });

    it("includes GENERAL_USE_PRESET", () => {
      expect(LOCAL_SYSTEM_PROMPTS).toContain(GENERAL_USE_PRESET);
    });

    it("includes CONCISE_PRESET", () => {
      expect(LOCAL_SYSTEM_PROMPTS).toContain(CONCISE_PRESET);
    });

    it("includes AGENT_PRESET", () => {
      expect(LOCAL_SYSTEM_PROMPTS).toContain(AGENT_PRESET);
    });

    it("all presets have unique ids", () => {
      const ids = LOCAL_SYSTEM_PROMPTS.map((p) => p.id);
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds.length).toBe(ids.length);
    });

    it("all presets have required properties", () => {
      LOCAL_SYSTEM_PROMPTS.forEach((preset) => {
        expect(preset.id).toBeDefined();
        expect(preset.label).toBeDefined();
        expect(preset.description).toBeDefined();
        expect(preset.systemPrompt).toBeDefined();
        expect(typeof preset.isUserConfigurable).toBe("boolean");
      });
    });
  });
});
