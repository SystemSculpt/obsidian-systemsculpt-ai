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
  const persistedUpdates = jest.fn();
  const updateSettings = jest.fn(async (update: Record<string, unknown> | ((current: typeof settings) => Record<string, unknown>)) => {
    const patch = typeof update === "function" ? update(settings) : update;
    persistedUpdates(patch);
    Object.assign(settings, patch);
  });
  return {
    manifest: { version: "6.0.0" },
    settings,
    getSettingsManager: () => ({ updateSettings }),
    updateSettings,
    persistedUpdates,
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
    expect(plugin.persistedUpdates).toHaveBeenCalledWith({ licenseValid: false });
  });

  it.each([undefined, "", " \t "])("does not persist or request an already-inactive empty key (%j)", async (licenseKey) => {
    const plugin = createPlugin({ licenseKey, licenseValid: false });

    await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({
      outcome: "rejected", isValid: false, reason: "missing",
    });
    expect(request).not.toHaveBeenCalled();
    expect(plugin.updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    [200, admission("allowed"), false],
    [403, admission("license_rejected", { reason: "revoked" }), true],
    [200, { status: "success", data: { email: "old@example.com", user_name: "Old account", subscription_status: "active" } }, false],
  ])("does not apply an old account's validation after the key changes (%s, %j)", async (status, payload, currentValidity) => {
    const plugin = createPlugin({ licenseValid: !currentValidity });
    let finish!: (response: Response) => void;
    request.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const validation = createLicenseService(plugin).validateLicenseDetailed();

    plugin.settings.licenseKey = "replacement_account";
    plugin.settings.licenseValid = currentValidity;
    finish(jsonResponse(status as number, payload));

    await expect(validation).resolves.toEqual({ outcome: "unavailable", isValid: currentValidity });
    expect(plugin.updateSettings).not.toHaveBeenCalled();
    expect(plugin.settings.userEmail).toBe("");
  });

  it.each([
    [200, admission("allowed")],
    [403, admission("license_rejected", { reason: "revoked" })],
    [200, { status: "success", data: { email: "old@example.com", user_name: "Old account", subscription_status: "active" } }],
  ])("checks the account inside a queued settings update for HTTP %s", async (status, payload) => {
    const plugin = createPlugin();
    request.mockResolvedValue(jsonResponse(status as number, payload));
    let finishUpdate!: () => void;
    let notifyQueued!: () => void;
    const queued = new Promise<void>((resolve) => { notifyQueued = resolve; });
    plugin.updateSettings.mockImplementation((update: Record<string, unknown> | ((current: unknown) => Record<string, unknown>)) => new Promise<void>((resolve) => {
      finishUpdate = () => {
        const patch = typeof update === "function" ? update(plugin.settings) : update;
        Object.assign(plugin.settings, patch);
        resolve();
      };
      notifyQueued();
    }));
    const validation = createLicenseService(plugin).validateLicenseDetailed();
    await queued;
    plugin.settings.licenseKey = "replacement_account";
    finishUpdate();

    await expect(validation).resolves.toEqual({ outcome: "unavailable", isValid: false });
    expect(plugin.settings.licenseValid).toBe(false);
    expect(plugin.settings.lastValidated).toBe(0);
  });

  it("uses the plugin's shared admission graph by default", async () => {
    const plugin = createPlugin();
    const checkLicense = jest.fn().mockResolvedValue({ outcome: "allowed" });
    plugin.getManagedCapabilityGraph = () => ({ admission: { checkLicense } });
    await expect(new LicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({ outcome: "valid", isValid: true });
    expect(checkLicense).toHaveBeenCalledWith(undefined, { fresh: true });
    expect(plugin.settings.licenseValid).toBe(true);
  });

  it("does not invalidate a new key queued ahead of an empty-key update", async () => {
    const plugin = createPlugin({ licenseKey: "", licenseValid: true });
    plugin.updateSettings.mockImplementation(async (update: (current: unknown) => Record<string, unknown>) => {
      plugin.settings.licenseKey = "replacement-key";
      Object.assign(plugin.settings, update(plugin.settings));
    });
    await expect(createLicenseService(plugin).validateLicenseDetailed()).resolves.toEqual({ outcome: "unavailable", isValid: true });
    expect(plugin.settings.licenseValid).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not let an older allowed check overwrite a newer rejection of the same key", async () => {
    const plugin = createPlugin();
    let finishOld!: (value: unknown) => void;
    const checkLicense = jest.fn()
      .mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ outcome: "license_rejected", reason: "revoked" });
    const service = new LicenseService(plugin, () => ({ checkLicense }));
    const older = service.validateLicenseDetailed();
    await expect(service.validateLicenseDetailed()).resolves.toEqual({ outcome: "rejected", isValid: false, reason: "revoked" });
    finishOld({ outcome: "allowed" });
    await expect(older).resolves.toEqual({ outcome: "unavailable", isValid: false });
    expect(plugin.settings.licenseValid).toBe(false);
    expect(plugin.settings.lastValidated).toBe(0);
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

    expect(plugin.persistedUpdates).toHaveBeenCalledWith({
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
    expect(plugin.persistedUpdates).toHaveBeenCalledWith({
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
      expect(plugin.persistedUpdates).toHaveBeenCalledWith({ licenseValid: false });
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
