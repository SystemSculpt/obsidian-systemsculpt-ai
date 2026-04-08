import { AGENT_PRESET, AGENT_TOOL_INSTRUCTIONS } from "../agent";

describe("agent prompt decomposition", () => {
  it("exports AGENT_TOOL_INSTRUCTIONS as a separate string", () => {
    expect(typeof AGENT_TOOL_INSTRUCTIONS).toBe("string");
    expect(AGENT_TOOL_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  it("AGENT_TOOL_INSTRUCTIONS contains tool_calling section", () => {
    expect(AGENT_TOOL_INSTRUCTIONS).toContain("<tool_calling>");
  });

  it("AGENT_TOOL_INSTRUCTIONS contains making_edits section", () => {
    expect(AGENT_TOOL_INSTRUCTIONS).toContain("<making_edits>");
  });

  it("AGENT_PRESET.systemPrompt still contains the full prompt", () => {
    expect(AGENT_PRESET.systemPrompt).toContain("<identity>");
    expect(AGENT_PRESET.systemPrompt).toContain("<tool_calling>");
  });
});
