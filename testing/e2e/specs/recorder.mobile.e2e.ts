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
      const anyApp = app as any;
      if (typeof anyApp.emulateMobile === "function") {
        anyApp.emulateMobile(true);
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

  it("auto-stops when app visibility becomes hidden (lock/background simulation)", async () => {
    await runCommand(RECORDER_COMMAND);

    const widget = await $(".ss-recorder-mini");
    await widget.waitForExist({ timeout: 10000 });
    await browser.waitUntil(
      async () => (await widget.getAttribute("data-state")) === "recording",
      { timeout: 8000, timeoutMsg: "Recorder did not enter recording state" }
    );

    await browser.executeObsidian(async () => {
      try {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => true,
        });
      } catch (_) {
        // best-effort for environments where hidden is not re-definable
      }
      document.dispatchEvent(new Event("visibilitychange"));
      // pagehide is a deterministic fallback in emulated environments where
      // document.hidden cannot be overridden.
      window.dispatchEvent(new Event("pagehide"));
    });

    await browser.waitUntil(
      async () => (await widget.getAttribute("data-state")) === "idle",
      { timeout: 12000, timeoutMsg: "Recorder did not auto-stop on hidden visibility" }
    );

    const status = await $(".ss-recorder-mini__status");
    const statusText = (await status.getText()).toLowerCase();
    const hasExpectedLifecycleStatus =
      statusText.includes("background") || statusText.includes("transcrib") || statusText.includes("saving");
    await expect(hasExpectedLifecycleStatus).toBe(true);
  });
});
