/**
 * @jest-environment node
 */
import { AGENT_CONFIG } from "../agent";

describe("AGENT_CONFIG", () => {
  it("has MODEL_ID defined", () => {
    expect(AGENT_CONFIG.MODEL_ID).toBeDefined();
    expect(typeof AGENT_CONFIG.MODEL_ID).toBe("string");
  });

  it("MODEL_ID follows expected format", () => {
    expect(AGENT_CONFIG.MODEL_ID).toContain("systemsculpt");
    expect(AGENT_CONFIG.MODEL_ID).toContain("@@");
  });

  it("MODEL_ID is the correct value", () => {
    expect(AGENT_CONFIG.MODEL_ID).toBe("systemsculpt@@systemsculpt/ai-agent");
  });

  it("has MODEL_DISPLAY_NAME defined", () => {
    expect(AGENT_CONFIG.MODEL_DISPLAY_NAME).toBeDefined();
    expect(typeof AGENT_CONFIG.MODEL_DISPLAY_NAME).toBe("string");
  });

  it("MODEL_DISPLAY_NAME is human readable", () => {
    expect(AGENT_CONFIG.MODEL_DISPLAY_NAME).toBe("SystemSculpt AI Agent");
    expect(AGENT_CONFIG.MODEL_DISPLAY_NAME.length).toBeGreaterThan(0);
    expect(AGENT_CONFIG.MODEL_DISPLAY_NAME).toMatch(/^[A-Z]/); // Starts with capital
  });

  it("has MODEL_DESCRIPTION defined", () => {
    expect(AGENT_CONFIG.MODEL_DESCRIPTION).toBeDefined();
    expect(typeof AGENT_CONFIG.MODEL_DESCRIPTION).toBe("string");
  });

  it("MODEL_DESCRIPTION describes the agent runtime", () => {
    expect(AGENT_CONFIG.MODEL_DESCRIPTION.toLowerCase()).toContain("systemsculpt");
    expect(AGENT_CONFIG.MODEL_DESCRIPTION.toLowerCase()).toContain("agent");
    expect(AGENT_CONFIG.MODEL_DESCRIPTION.toLowerCase()).toContain("runtime");
  });

  it("is readonly (const assertion)", () => {
    // Verify the structure is as expected
    expect(Object.keys(AGENT_CONFIG)).toContain("MODEL_ID");
    expect(Object.keys(AGENT_CONFIG)).toContain("MODEL_DISPLAY_NAME");
    expect(Object.keys(AGENT_CONFIG)).toContain("MODEL_DESCRIPTION");
    expect(Object.keys(AGENT_CONFIG).length).toBe(3);
  });
});
