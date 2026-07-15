import * as Obsidian from "obsidian";
import { LicenseService } from "../LicenseService";

function createPlugin(licenseValid = true) {
  const settings = { licenseKey: "license_test", licenseValid };
  const updateSettings = jest.fn(async (patch: Partial<typeof settings>) => Object.assign(settings, patch));
  return {
    manifest: { version: "6.0.0" },
    settings,
    getSettingsManager: () => ({ updateSettings }),
    updateSettings,
  } as any;
}

const rejectionBody = {
  contract_version: "admission-v1",
  code: "license_rejected",
  message: "License key was rejected.",
  request_id: "request-1",
  reason: "revoked",
};

describe("LicenseService HTTP composition", () => {
  beforeEach(() => jest.clearAllMocks());

  it("invalidates cached validity for the exact negotiated rejection through the real HTTP client", async () => {
    const requestUrl = Obsidian.requestUrl as jest.Mock;
    requestUrl.mockResolvedValue({
      status: 403,
      text: JSON.stringify(rejectionBody),
      headers: { "content-type": "application/json" },
    });
    const plugin = createPlugin();

    await expect(new LicenseService(plugin).validateLicense()).resolves.toBe(false);
    expect(plugin.updateSettings).toHaveBeenCalledWith({ licenseValid: false });
  });

  it.each([
    [401, JSON.stringify({ error: "Unauthorized" }), "application/json"],
    [403, "<html>Access denied</html>", "text/html"],
    [404, "<html>Not found</html>", "text/html"],
  ])("preserves cached validity for non-contract HTTP %s responses", async (status, text, contentType) => {
    const requestUrl = Obsidian.requestUrl as jest.Mock;
    requestUrl.mockResolvedValue({ status, text, headers: { "content-type": contentType } });
    const plugin = createPlugin();

    await expect(new LicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "unavailable",
      isValid: true,
    });
    expect(plugin.updateSettings).not.toHaveBeenCalledWith({ licenseValid: false });
  });
});
