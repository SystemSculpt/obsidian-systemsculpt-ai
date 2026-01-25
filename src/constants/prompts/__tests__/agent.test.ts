/**
 * @jest-environment node
 */
import { AGENT_PRESET } from "../agent";

describe("AGENT_PRESET", () => {
  it("has correct id", () => {
    expect(AGENT_PRESET.id).toBe("agent");
  });

  it("has correct label", () => {
    expect(AGENT_PRESET.label).toBe("Vault Agent Preset");
  });

  it("has description", () => {
    expect(AGENT_PRESET.description).toBeDefined();
    expect(typeof AGENT_PRESET.description).toBe("string");
    expect(AGENT_PRESET.description.length).toBeGreaterThan(0);
  });

  it("is not user configurable", () => {
    expect(AGENT_PRESET.isUserConfigurable).toBe(false);
  });

  it("has a system prompt", () => {
    expect(AGENT_PRESET.systemPrompt).toBeDefined();
    expect(typeof AGENT_PRESET.systemPrompt).toBe("string");
    expect(AGENT_PRESET.systemPrompt.length).toBeGreaterThan(100);
  });

  describe("system prompt content", () => {
    it("contains identity section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<identity>");
      expect(AGENT_PRESET.systemPrompt).toContain("</identity>");
    });

    it("contains scope section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<scope>");
      expect(AGENT_PRESET.systemPrompt).toContain("</scope>");
    });

    it("contains communication section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<communication>");
      expect(AGENT_PRESET.systemPrompt).toContain("</communication>");
    });

    it("contains search_strategy section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<search_strategy>");
      expect(AGENT_PRESET.systemPrompt).toContain("</search_strategy>");
    });

    it("contains tool_calling section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<tool_calling>");
      expect(AGENT_PRESET.systemPrompt).toContain("</tool_calling>");
    });

    it("contains efficiency section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<efficiency>");
      expect(AGENT_PRESET.systemPrompt).toContain("</efficiency>");
    });

    it("contains making_edits section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<making_edits>");
      expect(AGENT_PRESET.systemPrompt).toContain("</making_edits>");
    });

    it("contains obsidian_bases section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<obsidian_bases>");
      expect(AGENT_PRESET.systemPrompt).toContain("</obsidian_bases>");
    });

    it("contains safety_and_privacy section", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("<safety_and_privacy>");
      expect(AGENT_PRESET.systemPrompt).toContain("</safety_and_privacy>");
    });

    it("mentions SystemSculpt", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("SystemSculpt");
    });

    it("mentions Obsidian", () => {
      expect(AGENT_PRESET.systemPrompt).toContain("Obsidian");
    });

    it("mentions vault operations", () => {
      expect(AGENT_PRESET.systemPrompt.toLowerCase()).toContain("vault");
    });
  });
});
