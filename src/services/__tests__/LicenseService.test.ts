import { API_BASE_URL } from "../../constants/api";
import { LicenseService } from "../LicenseService";

jest.mock("../../utils/httpClient", () => ({ httpRequest: jest.fn() }));

const httpRequest = require("../../utils/httpClient").httpRequest as jest.Mock;

function createPlugin(overrides: Record<string, unknown> = {}) {
  const settings = {
    licenseKey: "license_test",
    licenseValid: false,
    userEmail: "",
    userName: "",
    displayName: "",
    subscriptionStatus: "",
    lastValidated: 0,
    ...overrides,
  };
  const updateSettings = jest.fn(async (patch: Record<string, unknown>) => {
    Object.assign(settings, patch);
  });
  return {
    manifest: { version: "6.0.0" },
    settings,
    getSettingsManager: () => ({ updateSettings }),
    updateSettings,
  } as any;
}

describe("LicenseService website-owned validation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns false without making a request when the key is empty", async () => {
    const plugin = createPlugin({ licenseKey: "", licenseValid: true });
    const service = new LicenseService(plugin);

    await expect(service.validateLicense()).resolves.toBe(false);

    expect(httpRequest).not.toHaveBeenCalled();
    expect(plugin.updateSettings).toHaveBeenCalledWith({ licenseValid: false });
  });

  it("validates through the compiled website API with license and plugin version headers", async () => {
    const plugin = createPlugin();
    httpRequest.mockResolvedValue({
      status: 200,
      json: {
        email: "user@example.com",
        user_name: "User",
        display_name: "Display",
        subscription_status: "active",
      },
    });

    await expect(new LicenseService(plugin).validateLicense()).resolves.toBe(true);

    const request = httpRequest.mock.calls[0][0];
    expect(request.url).toMatch(
      new RegExp(`^${API_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/license/validate\\?_t=\\d+$`),
    );
    expect(request).toMatchObject({
      method: "GET",
      headers: {
        "x-license-key": "license_test",
        "x-plugin-version": "6.0.0",
      },
    });
    expect(request.headers).not.toHaveProperty("x-systemsculpt-contract");
    expect(request.headers).not.toHaveProperty("x-systemsculpt-admission-contract");
  });

  it("stores the legacy account profile returned by the website route", async () => {
    const plugin = createPlugin();
    httpRequest.mockResolvedValue({
      status: 200,
      json: {
        email: "user@example.com",
        user_name: "User",
        display_name: "Display",
        subscription_status: "active",
      },
    });

    await new LicenseService(plugin).validateLicense();

    expect(plugin.updateSettings).toHaveBeenCalledWith({
      licenseValid: true,
      userEmail: "user@example.com",
      userName: "User",
      displayName: "Display",
      subscriptionStatus: "active",
      lastValidated: expect.any(Number),
    });
  });

  it.each([400, 401, 403, 404])(
    "treats HTTP %s as an authoritative rejection",
    async (status) => {
      const plugin = createPlugin({ licenseValid: true });
      httpRequest.mockRejectedValue({ status, json: { error: "rejected" } });

      await expect(new LicenseService(plugin).validateLicense()).resolves.toBe(false);

      expect(plugin.updateSettings).toHaveBeenCalledWith({ licenseValid: false });
    },
  );

  it.each([429, 500, 503])(
    "preserves last-known-good validity for transient HTTP %s",
    async (status) => {
      const plugin = createPlugin({ licenseValid: true });
      httpRequest.mockRejectedValue({ status, json: { error: "transient" } });

      await expect(new LicenseService(plugin).validateLicense()).resolves.toBe(true);

      expect(plugin.updateSettings).not.toHaveBeenCalledWith({ licenseValid: false });
    },
  );

  it("preserves last-known-good validity for transport failures", async () => {
    const plugin = createPlugin({ licenseValid: true });
    httpRequest.mockRejectedValue(new Error("offline"));

    await expect(new LicenseService(plugin).validateLicense()).resolves.toBe(true);
    expect(plugin.updateSettings).not.toHaveBeenCalled();
  });

  it("preserves the prior state for malformed successful responses", async () => {
    const plugin = createPlugin({ licenseValid: true });
    httpRequest.mockResolvedValue({ status: 200, json: null });

    await expect(new LicenseService(plugin).validateLicense()).resolves.toBe(true);
    expect(plugin.updateSettings).not.toHaveBeenCalled();
  });
});
