import { buildSettingsTabConfigs } from "../settings/SettingsTabRegistry";

function createTabStub(): any {
  return {
    app: {},
    plugin: {
      settings: {
        licenseValid: false,
        settingsMode: "standard",
      },
    },
  };
}

describe("SettingsTabRegistry SystemSculpt-only anchors", () => {
  it("defines the simplified settings information architecture around the SystemSculpt contract", () => {
    const configs = buildSettingsTabConfigs(createTabStub());
    expect(configs.map((config) => ({ id: config.id, label: config.label }))).toEqual([
      { id: "account", label: "Account" },
      { id: "chat", label: "Chat" },
      { id: "workflow", label: "Workflow" },
      { id: "knowledge", label: "Knowledge" },
      { id: "readwise", label: "Readwise" },
      { id: "workspace", label: "Workspace" },
      { id: "studio", label: "Studio" },
      { id: "advanced", label: "Advanced" },
    ]);

    const account = configs.find((config) => config.id === "account");
    const chat = configs.find((config) => config.id === "chat");
    const workflow = configs.find((config) => config.id === "workflow");
    const knowledge = configs.find((config) => config.id === "knowledge");
    const readwise = configs.find((config) => config.id === "readwise");
    const workspace = configs.find((config) => config.id === "workspace");
    const studio = configs.find((config) => config.id === "studio");
    const advanced = configs.find((config) => config.id === "advanced");

    expect(account?.anchor?.title).toContain("License");
    expect(account?.anchor?.desc).toContain("credits and billing details");
    expect(account?.anchor?.title).not.toMatch(/providers|api keys/i);
    expect(account?.anchor?.desc).not.toMatch(/fallback|openai|anthropic|ollama/i);

    expect(chat?.anchor?.title).toContain("Chat");
    expect(chat?.anchor?.title).not.toMatch(/favorites|prompts|templates/i);
    expect(chat?.anchor?.desc).toContain("chat preferences");
    expect(chat?.anchor?.desc).toContain("SystemSculpt handles the chat experience itself");
    expect(chat?.anchor?.desc).not.toMatch(/prompt|model picker|templates/i);

    expect(workflow?.anchor?.title).toContain("Audio");
    expect(workflow?.anchor?.title).not.toContain("Automation");
    expect(workflow?.anchor?.desc).toContain("recording");
    expect(workflow?.anchor?.desc).not.toContain("automation");

    expect(knowledge?.anchor?.desc).toContain("semantic search");
    expect(knowledge?.anchor?.desc).toContain("related note discovery");
    expect(knowledge?.anchor?.desc).not.toContain("Readwise");
    expect(knowledge?.anchor?.desc).not.toMatch(/custom provider|your own api/i);

    expect(readwise?.anchor?.title).toContain("Readwise");
    expect(readwise?.anchor?.desc).toContain("sync");

    expect(workspace?.anchor?.title).toContain("Directories");
    expect(workspace?.anchor?.desc).toContain("backup");

    expect(studio?.anchor?.desc).toContain("image generation options");
    expect(studio?.anchor?.desc).not.toMatch(/OpenRouter|model selection/i);
    expect(studio?.anchor?.desc).not.toMatch(/telemetry/i);

    expect(advanced?.anchor?.title).toContain("Update Notifications");
    expect(advanced?.anchor?.desc).toContain("diagnostics");
    expect(advanced?.anchor?.desc).not.toMatch(/debug|changelog/i);
  });
});
