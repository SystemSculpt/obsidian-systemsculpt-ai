import { expect } from "@wdio/globals";
import { ensurePluginEnabled, runCommand } from "../utils/obsidian";
import { configurePluginForLiveChat, getEnv, PLUGIN_ID, ensureE2EVault, requireEnv } from "../utils/systemsculptChat";

const RECORDER_COMMAND = `${PLUGIN_ID}:toggle-audio-recorder`;

describe("Recorder (mobile emulation)", () => {
  before(async () => {
    const licenseKey = requireEnv("SYSTEMSCULPT_E2E_LICENSE_KEY");
    const serverUrl = getEnv("SYSTEMSCULPT_E2E_SERVER_URL");
    const selectedModelId = getEnv("SYSTEMSCULPT_E2E_MODEL_ID") ?? "systemsculpt@@systemsculpt/ai-agent";

    const vaultPath = await ensureE2EVault();
    await browser.executeObsidian(async ({ app }) => {
      // Force Obsidian into mobile emulation so UI variant toggles correctly.
      // @ts-ignore - Obsidian internal method
      if (typeof app.emulateMobile === "function") {
        app.emulateMobile(true);
      }
    });
    await ensurePluginEnabled(PLUGIN_ID, vaultPath);
    await configurePluginForLiveChat({ licenseKey, serverUrl, selectedModelId });
  });

  it("shows the floating recorder and stays non-blocking", async () => {
    await runCommand(RECORDER_COMMAND);

    const widget = await $(".ss-recorder-mini");
    await widget.waitForExist({ timeout: 10000 });
    await expect(widget).toBeDisplayed();

    const host = await $(".ss-recorder-panel-host");
    const classes = await host.getAttribute("class");
    await expect(classes || "").toContain("platform-ui-mobile");

    // Stop to clean up
    await runCommand(RECORDER_COMMAND);
    await browser.waitUntil(
      async () => (await widget.getAttribute("data-state")) === "idle",
      { timeout: 8000, timeoutMsg: "Recorder did not return to idle state" }
    );
  });
});
