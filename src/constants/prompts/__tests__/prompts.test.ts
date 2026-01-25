/**
 * @jest-environment node
 */
import { GENERAL_USE_PRESET } from "../general";
import { CONCISE_PRESET } from "../concise";
import { AGENT_PRESET } from "../agent";
import { LOCAL_SYSTEM_PROMPTS } from "../index";

describe("prompts", () => {
  describe("GENERAL_USE_PRESET", () => {
    it("has correct id", () => {
      expect(GENERAL_USE_PRESET.id).toBe("general-use");
    });

    it("has a label", () => {
      expect(GENERAL_USE_PRESET.label).toBe("General Use Preset");
    });

    it("has a description", () => {
      expect(GENERAL_USE_PRESET.description).toBeDefined();
      expect(GENERAL_USE_PRESET.description.length).toBeGreaterThan(0);
    });

    it("is not user configurable", () => {
      expect(GENERAL_USE_PRESET.isUserConfigurable).toBe(false);
    });

    it("has a system prompt", () => {
      expect(GENERAL_USE_PRESET.systemPrompt).toBeDefined();
      expect(GENERAL_USE_PRESET.systemPrompt.length).toBeGreaterThan(0);
    });

    it("system prompt mentions AI assistant", () => {
      expect(GENERAL_USE_PRESET.systemPrompt.toLowerCase()).toContain("ai assistant");
    });
  });

  describe("CONCISE_PRESET", () => {
    it("has correct id", () => {
      expect(CONCISE_PRESET.id).toBe("concise");
    });

    it("has a label", () => {
      expect(CONCISE_PRESET.label).toBe("Concise Preset");
    });

    it("has a description", () => {
      expect(CONCISE_PRESET.description).toBeDefined();
      expect(CONCISE_PRESET.description.length).toBeGreaterThan(0);
    });

    it("is not user configurable", () => {
      expect(CONCISE_PRESET.isUserConfigurable).toBe(false);
    });

    it("has a system prompt", () => {
      expect(CONCISE_PRESET.systemPrompt).toBeDefined();
      expect(CONCISE_PRESET.systemPrompt.length).toBeGreaterThan(0);
    });

    it("system prompt emphasizes brevity", () => {
      const lowerPrompt = CONCISE_PRESET.systemPrompt.toLowerCase();
      expect(lowerPrompt).toMatch(/concise|brief|point/);
    });
  });

  describe("AGENT_PRESET", () => {
    it("has correct id", () => {
      expect(AGENT_PRESET.id).toBe("agent");
    });

    it("has a label", () => {
      expect(AGENT_PRESET.label).toBe("Vault Agent Preset");
    });

    it("has a description", () => {
      expect(AGENT_PRESET.description).toBeDefined();
      expect(AGENT_PRESET.description.length).toBeGreaterThan(0);
    });

    it("is not user configurable", () => {
      expect(AGENT_PRESET.isUserConfigurable).toBe(false);
    });

    it("has a comprehensive system prompt", () => {
      expect(AGENT_PRESET.systemPrompt).toBeDefined();
      expect(AGENT_PRESET.systemPrompt.length).toBeGreaterThan(100);
    });

    it("system prompt includes identity section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<identity>");
    });

    it("system prompt includes scope section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<scope>");
    });

    it("system prompt includes tool calling section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<tool_calling>");
    });

    it("system prompt includes search strategy section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<search_strategy>");
    });

    it("system prompt includes obsidian bases section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<obsidian_bases>");
    });

    it("system prompt includes safety section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<safety_and_privacy>");
    });
  });

  describe("LOCAL_SYSTEM_PROMPTS", () => {
    it("is an array", () => {
      expect(Array.isArray(LOCAL_SYSTEM_PROMPTS)).toBe(true);
    });

    it("contains exactly 3 presets", () => {
      expect(LOCAL_SYSTEM_PROMPTS.length).toBe(3);
    });

    it("contains GENERAL_USE_PRESET", () => {
      expect(LOCAL_SYSTEM_PROMPTS).toContain(GENERAL_USE_PRESET);
    });

    it("contains CONCISE_PRESET", () => {
      expect(LOCAL_SYSTEM_PROMPTS).toContain(CONCISE_PRESET);
    });

    it("contains AGENT_PRESET", () => {
      expect(LOCAL_SYSTEM_PROMPTS).toContain(AGENT_PRESET);
    });

    it("all presets have unique ids", () => {
      const ids = LOCAL_SYSTEM_PROMPTS.map((p) => p.id);
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds.length).toBe(ids.length);
    });

    it("all presets have required fields", () => {
      for (const preset of LOCAL_SYSTEM_PROMPTS) {
        expect(preset.id).toBeDefined();
        expect(preset.label).toBeDefined();
        expect(preset.description).toBeDefined();
        expect(preset.systemPrompt).toBeDefined();
        expect(typeof preset.isUserConfigurable).toBe("boolean");
      }
    });
  });
});
