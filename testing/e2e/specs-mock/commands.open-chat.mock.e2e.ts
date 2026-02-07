import { expect } from "@wdio/globals";
import { ensurePluginEnabled } from "../utils/obsidian";
import {
  configurePluginForLiveChat,
  ensureE2EVault,
  getEnv,
  PLUGIN_ID,
  requireEnv,
} from "../utils/systemsculptChat";

describe("Commands (mock) open chat", () => {
  const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
  const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
  const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

  let vaultPath: string;

  before(async () => {
    vaultPath = await ensureE2EVault();
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configurePluginForLiveChat({
      licenseKey,
      serverUrl,
      selectedModelId,
      settingsOverride: {
        mcpEnabled: true,
      },
    });
  });

  it("executes the open chat command and opens a SystemSculpt chat view", async function () {
    this.timeout(120000);

    const commandId = "systemsculpt-ai:open-systemsculpt-chat";
    const hasCommand = await browser.executeObsidian(({ app }, id) => {
      const commands: any = (app as any)?.commands;
      const registry = commands?.commands ?? {};
      return !!registry?.[id];
    }, commandId);
    expect(hasCommand).toBe(true);

    await browser.executeObsidianCommand(commandId);

    await browser.waitUntil(
      async () =>
        await browser.executeObsidian(({ app }) => {
          const leaves = app.workspace.getLeavesOfType("systemsculpt-chat-view");
          return leaves.length > 0;
        }),
      { timeout: 15000, timeoutMsg: "Chat view did not open after command execution." }
    );

    const activeType = await browser.executeObsidian(({ app }) => {
      // @ts-ignore
      return (app.workspace.activeLeaf as any)?.view?.getViewType?.() ?? "";
    });

    expect(activeType).toBe("systemsculpt-chat-view");
  });
});
