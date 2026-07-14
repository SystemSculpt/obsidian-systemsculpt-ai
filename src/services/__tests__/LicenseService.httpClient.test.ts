import * as Obsidian from "obsidian";
import { LicenseService } from "../LicenseService";

function createPlugin() {
  const settings = {
    licenseKey: "license_test",
    licenseValid: true,
  };
  const updateSettings = jest.fn(async (patch: Partial<typeof settings>) => {
    Object.assign(settings, patch);
  });

  return {
    manifest: { version: "6.0.0" },
    settings,
    getSettingsManager: () => ({ updateSettings }),
    updateSettings,
  } as any;
}

describe("LicenseService HTTP composition", () => {
  it("invalidates cached validity when the real HTTP client rejects a 401", async () => {
    const requestUrl = Obsidian.requestUrl as jest.Mock;
    requestUrl.mockResolvedValue({
      status: 401,
      text: JSON.stringify({ error: "Invalid license" }),
      headers: { "content-type": "application/json" },
    });
    const plugin = createPlugin();

    await expect(new LicenseService(plugin).validateLicense()).resolves.toBe(false);

    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(plugin.updateSettings).toHaveBeenCalledWith({ licenseValid: false });
    expect(plugin.settings.licenseValid).toBe(false);
  });
});
