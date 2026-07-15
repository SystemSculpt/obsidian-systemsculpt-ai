import { API_BASE_URL } from "../../constants/api";
import { LicenseService } from "../LicenseService";

jest.mock("../../utils/httpClient", () => ({ httpRequest: jest.fn() }));

const httpRequest = require("../../utils/httpClient").httpRequest as jest.Mock;

function admission(
  code: "allowed" | "license_required" | "license_rejected" | "rate_limited" | "temporarily_unavailable",
  extra: Record<string, unknown> = {},
) {
  return {
    contract_version: "admission-v1",
    code,
    message: "Admission response.",
    request_id: "request-1",
    ...extra,
  };
}

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

  it("returns a local rejection without making a request when the key is empty", async () => {
    const plugin = createPlugin({ licenseKey: "", licenseValid: true });
    const service = new LicenseService(plugin);

    await expect(service.validateLicenseDetailed()).resolves.toEqual({
      outcome: "rejected",
      isValid: false,
      reason: "missing",
    });

    expect(httpRequest).not.toHaveBeenCalled();
    expect(plugin.updateSettings).toHaveBeenCalledWith({ licenseValid: false });
  });

  it("negotiates admission-v1 through the website API", async () => {
    const plugin = createPlugin();
    httpRequest.mockResolvedValue({ status: 200, json: admission("allowed") });

    await expect(new LicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "valid",
      isValid: true,
    });

    const request = httpRequest.mock.calls[0][0];
    expect(request.url).toMatch(
      new RegExp(`^${API_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/license/validate\\?_t=\\d+$`),
    );
    expect(request).toMatchObject({
      method: "GET",
      headers: {
        "x-license-key": "license_test",
        "x-plugin-version": "6.0.0",
        "x-systemsculpt-admission-contract": "admission-v1",
      },
    });
    expect(plugin.updateSettings).toHaveBeenCalledWith({
      licenseValid: true,
      subscriptionStatus: "active",
      lastValidated: expect.any(Number),
    });
  });

  it("accepts the established legacy success envelope without trusting arbitrary 200 JSON", async () => {
    const plugin = createPlugin();
    httpRequest.mockResolvedValue({
      status: 200,
      json: {
        status: "success",
        data: {
          email: "user@example.com",
          user_name: "User",
          subscription_status: "active",
        },
      },
    });

    await expect(new LicenseService(plugin).validateLicense()).resolves.toBe(true);
    expect(plugin.updateSettings).toHaveBeenCalledWith({
      licenseValid: true,
      userEmail: "user@example.com",
      userName: "User",
      displayName: "User",
      subscriptionStatus: "active",
      lastValidated: expect.any(Number),
    });
  });

  it.each(["invalid", "expired", "revoked"] as const)(
    "invalidates only an exact negotiated license_rejected/%s response",
    async (reason) => {
      const plugin = createPlugin({ licenseValid: true });
      httpRequest.mockRejectedValue({
        status: 403,
        json: admission("license_rejected", { reason }),
      });

      await expect(new LicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
        outcome: "rejected",
        isValid: false,
        reason,
      });
      expect(plugin.updateSettings).toHaveBeenCalledWith({ licenseValid: false });
    },
  );

  it.each([400, 401, 403, 404])(
    "does not reinterpret raw HTTP %s as an invalid license",
    async (status) => {
      const plugin = createPlugin({ licenseValid: true });
      httpRequest.mockRejectedValue({ status, json: { error: "rejected" } });

      await expect(new LicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
        outcome: "unavailable",
        isValid: true,
      });
      expect(plugin.updateSettings).not.toHaveBeenCalledWith({ licenseValid: false });
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

  it("reports a transport failure as unavailable on first activation", async () => {
    const plugin = createPlugin({ licenseValid: false });
    httpRequest.mockRejectedValue(new Error("offline"));

    await expect(new LicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "unavailable",
      isValid: false,
    });
    expect(plugin.updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    [200, admission("allowed", { token: "forbidden" })],
    [200, { code: "allowed" }],
    [200, null],
    [403, admission("license_rejected")],
    [401, admission("allowed")],
  ])("treats malformed or contradictory admission response %s as unavailable", async (status, json) => {
    const plugin = createPlugin({ licenseValid: true });
    if ((status as number) >= 400) httpRequest.mockRejectedValue({ status, json });
    else httpRequest.mockResolvedValue({ status, json });

    await expect(new LicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "unavailable",
      isValid: true,
    });
    expect(plugin.updateSettings).not.toHaveBeenCalledWith({ licenseValid: false });
  });
});
