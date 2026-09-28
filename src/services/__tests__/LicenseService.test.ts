import { API_BASE_URL } from "../../constants/api";
import { LicenseService } from "../LicenseService";
import { PlatformRequestTimeoutError } from "../PlatformRequestClient";
import { ManagedAdmission } from "../managed/ManagedAdmission";
import { HostedTransportAdapter } from "../managed/adapters/HostedTransportAdapter";

const request = jest.fn();
const requestClient = { request } as any;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

/** License validation reads through the plugin's managed admission (#386). */
function createLicenseService(plugin: any) {
  const transport = new HostedTransportAdapter({
    baseUrl: new URL(API_BASE_URL).origin,
    pluginVersion: plugin.manifest.version,
    licenseKey: () => plugin.settings.licenseKey,
    requestClient,
  });
  const admission = new ManagedAdmission({ transport, licenseKey: () => plugin.settings.licenseKey });
  return Object.assign(new LicenseService(plugin, () => admission), { sharedAdmission: admission });
}

describe("LicenseService website-owned validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    request.mockReset();
  });

  it("returns a local rejection without making a request when the key is empty", async () => {
    const plugin = createPlugin({ licenseKey: "", licenseValid: true });
    const service = createLicenseService(plugin);

    await expect(service.validateLicenseDetailed()).resolves.toEqual({
      outcome: "rejected",
      isValid: false,
      reason: "missing",
    });

    expect(request).not.toHaveBeenCalled();
    expect(plugin.updateSettings).toHaveBeenCalledWith({ licenseValid: false });
  });

  it("negotiates admission-v1 through the website API", async () => {
    const plugin = createPlugin();
    request.mockResolvedValue(jsonResponse(200, admission("allowed")));

    await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "valid",
      isValid: true,
    });

    // The request client applies no-store and the license header itself.
    const requestInput = request.mock.calls[0][0];
    expect(requestInput).toMatchObject({
      url: `${API_BASE_URL}/license/validate`,
      method: "GET",
      licenseKey: "license_test",
      headers: {
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
    request.mockResolvedValue(jsonResponse(200, {
      status: "success",
      data: {
        email: "user@example.com",
        user_name: "User",
        subscription_status: "active",
      },
    }));

    await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "valid",
      isValid: true,
    });
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
      request.mockResolvedValue(jsonResponse(
        403,
        admission("license_rejected", { reason }),
      ));

      await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
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
      request.mockResolvedValue(jsonResponse(status, { error: "rejected" }));

      await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
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
      request.mockResolvedValue(jsonResponse(status, { error: "transient" }));

      await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toMatchObject({
        isValid: true,
      });
      expect(plugin.updateSettings).not.toHaveBeenCalledWith({ licenseValid: false });
    },
  );

  it("reports a transport failure as unavailable on first activation", async () => {
    const plugin = createPlugin({ licenseValid: false });
    request.mockRejectedValue(new Error("offline"));

    await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "unavailable",
      isValid: false,
    });
    expect(plugin.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps cached validity when the check times out", async () => {
    const plugin = createPlugin({ licenseValid: true });
    request.mockRejectedValue(new PlatformRequestTimeoutError(30_000));

    await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "unavailable",
      isValid: true,
    });
    expect(plugin.updateSettings).not.toHaveBeenCalled();
  });

  it("cancels the validation request with the caller's signal", async () => {
    const plugin = createPlugin({ licenseValid: true });
    const controller = new AbortController();
    request.mockImplementation((input: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const validation = createLicenseService(plugin).validateLicenseDetailed(controller.signal);
    await Promise.resolve();
    controller.abort();

    await expect(validation).resolves.toEqual({ outcome: "unavailable", isValid: true });
    expect(request.mock.calls[0][0].signal.aborted).toBe(true);
    expect(plugin.updateSettings).not.toHaveBeenCalled();
  });

  it("shares one admission read and cache with managed operations", async () => {
    const plugin = createPlugin();
    request.mockImplementation(async () => jsonResponse(200, admission("allowed")));
    const service = createLicenseService(plugin);

    const [validated, leased] = await Promise.all([
      service.validateLicenseDetailed(),
      service.sharedAdmission.checkLicense(),
    ]);
    expect(validated).toEqual({ outcome: "valid", isValid: true });
    expect(leased.outcome).toBe("allowed");
    expect(request).toHaveBeenCalledTimes(1);

    await service.sharedAdmission.checkLicense();
    expect(request).toHaveBeenCalledTimes(1);

    // Explicit validation always asks the server again.
    await service.validateLicenseDetailed();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    [200, admission("allowed", { token: "forbidden" })],
    [200, { code: "allowed" }],
    [200, null],
    [403, admission("license_rejected")],
    [401, admission("allowed")],
  ])("treats malformed or contradictory admission response %s as unavailable", async (status, json) => {
    const plugin = createPlugin({ licenseValid: true });
    request.mockResolvedValue(jsonResponse(status as number, json));

    await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "unavailable",
      isValid: true,
    });
    expect(plugin.updateSettings).not.toHaveBeenCalledWith({ licenseValid: false });
  });
});
