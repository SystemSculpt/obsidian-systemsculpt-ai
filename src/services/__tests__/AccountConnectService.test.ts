import { createHash } from "crypto";
import { API_BASE_URL } from "../../constants/api";
import { AccountConnectService, type ConnectOutcome } from "../AccountConnectService";

const BASE64_URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

const request = jest.fn();
const requestClient = { request } as any;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createPlugin(overrides: Record<string, unknown> = {}) {
  const settings = {
    licenseKey: "",
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
  const validateLicenseKeyDetailed = jest.fn(async () => {
    settings.licenseValid = true;
    return { outcome: "valid", isValid: true };
  });
  return {
    settings,
    getSettingsManager: () => ({ updateSettings }),
    getLicenseManager: () => ({ validateLicenseKeyDetailed }),
    registerInterval: jest.fn((timer: number) => timer),
    updateSettings,
    validateLicenseKeyDetailed,
  } as any;
}

// begin() starts a polling interval; cancel every service after each test so
// no interval outlives its suite (the shared setup provides a real window).
const createdServices: AccountConnectService[] = [];

afterEach(() => {
  createdServices.splice(0).forEach((service) => service.cancelPending());
});

function createService(plugin = createPlugin()) {
  const openedUrls: string[] = [];
  const opener = jest.fn(async (url: string) => {
    openedUrls.push(url);
    return true;
  });
  const service = new AccountConnectService(plugin, requestClient, opener);
  createdServices.push(service);
  return { service, plugin, opener, openedUrls };
}

function parseConnectUrl(url: string) {
  const parsed = new URL(url);
  const redirect = parsed.searchParams.get("redirect_url");
  expect(redirect).toBeTruthy();
  const redirectUrl = new URL(redirect as string, parsed.origin);
  return {
    origin: parsed.origin,
    path: parsed.pathname,
    redirectPath: redirectUrl.pathname,
    state: redirectUrl.searchParams.get("state") as string,
    challenge: redirectUrl.searchParams.get("challenge") as string,
  };
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

const successPayload = {
  status: "ok",
  license_key: "skss-connected",
  account: { email: "user@example.com", name: "User" },
  license: { type: "monthly", expires_at: null },
};

describe("AccountConnectService browser sign-in", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    request.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("begins sign-in with fresh base64url state and challenge and opens the website", async () => {
    const { service, openedUrls } = createService();

    await service.begin("sign-in");
    expect(service.hasPendingRequest()).toBe(true);

    const first = parseConnectUrl(openedUrls[0]);
    expect(first.origin).toBe(new URL(API_BASE_URL).origin);
    expect(first.path).toBe("/sign-in");
    expect(first.redirectPath).toBe("/plugin/connect");
    expect(first.state).toMatch(BASE64_URL_32_BYTES);
    expect(first.challenge).toMatch(BASE64_URL_32_BYTES);
    expect(first.state).not.toBe(first.challenge);

    await service.begin("sign-in");
    const second = parseConnectUrl(openedUrls[1]);
    expect(second.state).not.toBe(first.state);
    expect(second.challenge).not.toBe(first.challenge);
  });

  it("begins sign-up through the website sign-up route", async () => {
    const { service, openedUrls } = createService();

    await service.begin("sign-up");

    expect(parseConnectUrl(openedUrls[0]).path).toBe("/sign-up");
  });

  it("rejects a callback whose state does not match without contacting the server", async () => {
    const { service } = createService();
    await service.begin("sign-in");

    const outcome = await service.handleProtocolCallback({ code: "code-1", state: "tampered-state" });

    expect(request).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "error", reason: "state-mismatch" });
    expect(service.hasPendingRequest()).toBe(true);
  });

  it("rejects a callback after the pending request expired", async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const { service, openedUrls } = createService();
    await service.begin("sign-in");
    const { state } = parseConnectUrl(openedUrls[0]);

    now += 10 * 60_000 + 1;
    const outcome = await service.handleProtocolCallback({ code: "code-1", state });

    expect(request).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "error", reason: "expired" });
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("exchanges the code with the challenge-bound verifier and stores the license", async () => {
    const { service, plugin, openedUrls } = createService();
    request.mockResolvedValue(jsonResponse(200, successPayload));
    await service.begin("sign-in");
    const { state, challenge } = parseConnectUrl(openedUrls[0]);

    const outcome = await service.handleProtocolCallback({ code: "code-1", state });

    const requestInput = request.mock.calls[0][0];
    expect(requestInput).toMatchObject({
      url: `${API_BASE_URL}/auth/exchange`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-SystemSculpt-Client": "obsidian-plugin",
      },
    });
    expect(requestInput.headers["x-license-key"]).toBeUndefined();
    expect(requestInput.body.code).toBe("code-1");
    expect(requestInput.body.verifier).toMatch(BASE64_URL_32_BYTES);
    expect(requestInput.body.verifier).not.toBe(state);
    expect(sha256Base64Url(requestInput.body.verifier)).toBe(challenge);

    expect(plugin.updateSettings).toHaveBeenCalledWith({
      licenseKey: "skss-connected",
      userEmail: "user@example.com",
      userName: "User",
      displayName: "User",
    });
    expect(plugin.validateLicenseKeyDetailed).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: "signed-in",
      name: "User",
      email: "user@example.com",
      licenseValid: true,
    });
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("stores the signed-in profile without a license on no_license", async () => {
    const { service, plugin, openedUrls } = createService();
    request.mockResolvedValue(jsonResponse(200, {
      status: "no_license",
      account: { email: "user@example.com", name: null },
    }));
    await service.begin("sign-in");
    const { state } = parseConnectUrl(openedUrls[0]);

    const outcome = await service.handleProtocolCallback({ code: "code-1", state });

    expect(plugin.updateSettings).toHaveBeenCalledWith({
      licenseKey: "",
      licenseValid: false,
      userEmail: "user@example.com",
      userName: "user@example.com",
      displayName: "user@example.com",
      subscriptionStatus: "",
    });
    expect(plugin.validateLicenseKeyDetailed).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "no-license", name: null, email: "user@example.com" });
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("clears the pending request when the code is rejected as invalid", async () => {
    const { service, plugin, openedUrls } = createService();
    request.mockResolvedValue(jsonResponse(401, { error: "invalid_code" }));
    await service.begin("sign-in");
    const { state } = parseConnectUrl(openedUrls[0]);

    const outcome = await service.handleProtocolCallback({ code: "code-1", state });

    expect(plugin.updateSettings).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "error", reason: "invalid-code" });
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("keeps the pending request across a network failure so the manual code can retry", async () => {
    const { service, plugin } = createService();
    request.mockRejectedValueOnce(new Error("offline"));
    await service.begin("sign-in");

    const firstOutcome = await service.submitManualCode("manual-code");
    expect(firstOutcome).toEqual({ kind: "error", reason: "network" });
    expect(service.hasPendingRequest()).toBe(true);
    expect(plugin.updateSettings).not.toHaveBeenCalled();

    request.mockResolvedValueOnce(jsonResponse(200, successPayload));
    const retryOutcome = await service.submitManualCode("manual-code");

    expect(retryOutcome).toMatchObject({ kind: "signed-in" });
    expect(plugin.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ licenseKey: "skss-connected" }),
    );
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("requires an active pending request before accepting a manual code", async () => {
    const { service } = createService();

    const outcome = await service.submitManualCode("manual-code");

    expect(request).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "error", reason: "expired" });
  });

  it("reopens the browser with the same state and challenge for the active request", async () => {
    const { service, openedUrls } = createService();

    expect(await service.reopen()).toBe(false);

    await service.begin("sign-in");
    expect(await service.reopen()).toBe(true);

    const first = parseConnectUrl(openedUrls[0]);
    const second = parseConnectUrl(openedUrls[1]);
    expect(second.state).toBe(first.state);
    expect(second.challenge).toBe(first.challenge);
    expect(service.hasPendingRequest()).toBe(true);
  });
});

describe("AccountConnectService background polling", () => {
  // The shared test setup provides a window whose timers delegate to the
  // global timers, so Jest's fake timers drive the polling interval.
  beforeEach(() => {
    jest.clearAllMocks();
    request.mockReset();
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function createPollingService() {
    const created = createService();
    const outcomes: ConnectOutcome[] = [];
    created.service.setBackgroundOutcomeHandler((outcome) => outcomes.push(outcome));
    return { ...created, outcomes };
  }

  it("completes the sign-in by polling when the deep link never arrives", async () => {
    const { service, plugin, openedUrls, outcomes } = createPollingService();
    request.mockResolvedValueOnce(jsonResponse(200, { status: "pending" }));
    request.mockResolvedValueOnce(jsonResponse(200, successPayload));

    await service.begin("sign-in");
    expect(plugin.registerInterval).toHaveBeenCalledTimes(1);
    const { challenge } = parseConnectUrl(openedUrls[0]);

    await jest.advanceTimersByTimeAsync(3_500);
    expect(outcomes).toHaveLength(0);
    expect(service.hasPendingRequest()).toBe(true);

    await jest.advanceTimersByTimeAsync(3_500);

    const pollInput = request.mock.calls[0][0];
    expect(pollInput).toMatchObject({ url: `${API_BASE_URL}/auth/poll`, method: "POST" });
    expect(pollInput.headers["x-license-key"]).toBeUndefined();
    expect(sha256Base64Url(pollInput.body.verifier)).toBe(challenge);

    expect(plugin.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ licenseKey: "skss-connected" }),
    );
    expect(outcomes).toEqual([
      { kind: "signed-in", name: "User", email: "user@example.com", licenseValid: true },
    ]);
    expect(service.hasPendingRequest()).toBe(false);

    await jest.advanceTimersByTimeAsync(14_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps polling through network failures and error responses", async () => {
    const { service, outcomes } = createPollingService();
    request.mockRejectedValueOnce(new Error("offline"));
    request.mockResolvedValueOnce(jsonResponse(503, { error: "unavailable" }));
    request.mockResolvedValueOnce(jsonResponse(200, { status: "pending" }));

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3 * 3_500);

    expect(request).toHaveBeenCalledTimes(3);
    expect(outcomes).toHaveLength(0);
    expect(service.hasPendingRequest()).toBe(true);
  });

  it("stops polling when the pending request is cancelled", async () => {
    const { service } = createPollingService();

    await service.begin("sign-in");
    service.cancelPending();
    await jest.advanceTimersByTimeAsync(35_000);

    expect(request).not.toHaveBeenCalled();
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("ignores a poll result when an exchange already completed the sign-in", async () => {
    const { service, plugin, outcomes } = createPollingService();
    let resolvePoll!: (response: Response) => void;
    request.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolvePoll = resolve; }),
    );
    request.mockResolvedValueOnce(jsonResponse(200, successPayload));

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);

    const manual = await service.submitManualCode("manual-code");
    expect(manual).toMatchObject({ kind: "signed-in" });

    resolvePoll(jsonResponse(200, successPayload));
    await jest.advanceTimersByTimeAsync(0);

    expect(outcomes).toHaveLength(0);
    expect(plugin.updateSettings).toHaveBeenCalledTimes(1);
    expect(plugin.validateLicenseKeyDetailed).toHaveBeenCalledTimes(1);
  });
});
