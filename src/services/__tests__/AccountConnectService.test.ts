import { createHash } from "crypto";
import { requestUrl } from "obsidian";
import { API_BASE_URL } from "../../constants/api";
import { AccountConnectService, type ConnectOutcome } from "../AccountConnectService";
import { PlatformRequestClient } from "../PlatformRequestClient";

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
    register: jest.fn(),
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

function createService(plugin = createPlugin(), client = requestClient) {
  const openedUrls: string[] = [];
  const opener = jest.fn(async (url: string) => {
    openedUrls.push(url);
    return true;
  });
  const service = new AccountConnectService(plugin, client, opener);
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

  it("a code submitted while a poll is in flight adopts the poll's outcome", async () => {
    const { service, plugin, outcomes } = createPollingService();
    let resolvePoll!: (response: Response) => void;
    request.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolvePoll = resolve; }),
    );

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);

    const manual = service.submitManualCode("manual-code");
    resolvePoll(jsonResponse(200, successPayload));

    await expect(manual).resolves.toMatchObject({ kind: "signed-in" });
    expect(request).toHaveBeenCalledTimes(1); // the poll was the only request
    expect(outcomes).toHaveLength(0); // the awaiting caller owns the outcome
    expect(plugin.updateSettings).toHaveBeenCalledTimes(1);
    expect(plugin.validateLicenseKeyDetailed).toHaveBeenCalledTimes(1);
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("resumes polling after a network-failed exchange so sign-in still completes", async () => {
    const { service, outcomes } = createPollingService();
    request.mockRejectedValueOnce(new Error("offline"));
    request.mockResolvedValueOnce(jsonResponse(200, successPayload));

    await service.begin("sign-in");
    const outcome = await service.submitManualCode("manual-code");
    expect(outcome).toEqual({ kind: "error", reason: "network" });

    await jest.advanceTimersByTimeAsync(3_500);
    expect(outcomes).toEqual([expect.objectContaining({ kind: "signed-in" })]);
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("observes each sign-in request until it settles and aborts it when the sign-in is cancelled", async () => {
    const { service } = createPollingService();
    request.mockImplementation(() => new Promise<Response>(() => undefined));

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);

    // The request may yet deliver the one-time license key, so it gets no
    // client deadline; only the poll's hold on the in-flight slot is bounded.
    const pollInput = request.mock.calls[0][0];
    expect(pollInput.timeoutMs).toBeNull();
    await jest.advanceTimersByTimeAsync(15_000 + 3_500);
    expect(request).toHaveBeenCalledTimes(2);
    expect(pollInput.signal.aborted).toBe(false);
    service.cancelPending();
    expect(pollInput.signal.aborted).toBe(true);
    expect(request.mock.calls[1][0].signal.aborted).toBe(true);
  });

  it("still reports an invalid code when every earlier request of the sign-in was answered", async () => {
    const { service } = createPollingService();
    request.mockResolvedValueOnce(jsonResponse(200, { status: "pending" }));
    request.mockResolvedValueOnce(jsonResponse(401, { error: "invalid_code" }));

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);

    await expect(service.submitManualCode("wrong-code")).resolves.toEqual({ kind: "error", reason: "invalid-code" });
    expect(service.hasPendingRequest()).toBe(false);
  });
});

describe("AccountConnectService sign-in requests that answer late or never", () => {
  // Drives the production request client over native requests the plugin
  // cannot abort, only stop waiting for: they may answer late, or never.
  const nativeRequest = requestUrl as jest.Mock;
  const native = (status: number, payload: unknown) => ({
    status,
    text: JSON.stringify(payload),
    json: payload,
    headers: { "content-type": "application/json" },
  });
  const hang = () => new Promise<never>(() => undefined);
  const nativeCalls = (path: string) =>
    nativeRequest.mock.calls.filter(([input]) => input.url === `${API_BASE_URL}${path}`);

  beforeEach(() => {
    jest.clearAllMocks();
    nativeRequest.mockReset();
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  });

  afterEach(() => {
    jest.useRealTimers();
    nativeRequest.mockReset();
  });

  /** A native answer the test delivers later; until then the request is in flight. */
  function late() {
    let land!: (value: unknown) => void;
    const answer = new Promise((resolve) => { land = resolve; });
    return { respond: () => answer, land };
  }

  /**
   * Serves /auth/poll and /auth/exchange from their own queues. A poll with
   * nothing queued finds no unused code, which is also what the server says
   * once an earlier request burned it.
   */
  function serve(polls: Array<() => Promise<unknown>>, exchanges: Array<() => Promise<unknown>> = []) {
    nativeRequest.mockImplementation(({ url }: { url: string }) => {
      const queue = url === `${API_BASE_URL}/auth/poll` ? polls : exchanges;
      const next = queue.shift();
      return next ? next() : Promise.resolve(native(200, { status: "pending" }));
    });
  }
  const invalidCode = () => Promise.resolve(native(401, { error: "invalid_code" }));

  function createNativeService() {
    const created = createService(createPlugin(), new PlatformRequestClient());
    const outcomes: ConnectOutcome[] = [];
    created.service.setBackgroundOutcomeHandler((outcome) => outcomes.push(outcome));
    return { ...created, outcomes };
  }

  it("resumes polling after a poll hangs past its deadline and completes the sign-in", async () => {
    const { service, outcomes } = createNativeService();
    nativeRequest
      .mockImplementationOnce(hang)
      .mockResolvedValueOnce(native(200, successPayload));

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);
    expect(nativeCalls("/auth/poll")).toHaveLength(1);

    // The hung poll holds the slot: later ticks do not stack requests on it.
    await jest.advanceTimersByTimeAsync(14_999);
    expect(nativeCalls("/auth/poll")).toHaveLength(1);
    expect(outcomes).toHaveLength(0);

    // Its deadline releases the slot, and the next tick completes sign-in.
    await jest.advanceTimersByTimeAsync(1 + 3_500);
    expect(nativeCalls("/auth/poll")).toHaveLength(2);
    expect(outcomes).toEqual([expect.objectContaining({ kind: "signed-in" })]);
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("lets a manual code exchange proceed once the hung poll it waits on times out", async () => {
    const { service } = createNativeService();
    nativeRequest
      .mockImplementationOnce(hang)
      .mockResolvedValueOnce(native(200, successPayload));

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);
    let settled = false;
    const manual = service.submitManualCode("manual-code").finally(() => { settled = true; });

    await jest.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    expect(nativeCalls("/auth/exchange")).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(5_000);
    await expect(manual).resolves.toMatchObject({ kind: "signed-in" });
    expect(nativeCalls("/auth/exchange")).toHaveLength(1);
  });

  it("adopts a timed-out poll that burned the code when a manual exchange then finds it used", async () => {
    const { service, plugin, outcomes } = createNativeService();
    const poll = late();
    serve([poll.respond], [invalidCode]);

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);
    let settled = false;
    const manual = service.submitManualCode("manual-code").finally(() => { settled = true; });

    // The poll outlives its slot; the exchange then runs and is told the code
    // is used, because the server burned it for that poll.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(nativeCalls("/auth/exchange")).toHaveLength(1);
    expect(settled).toBe(false);

    // The poll's answer lands late and completes the sign-in exactly once.
    poll.land(native(200, successPayload));
    await expect(manual).resolves.toMatchObject({ kind: "signed-in", email: "user@example.com" });
    expect(outcomes).toHaveLength(0); // the awaiting exchange owns the outcome
    expect(plugin.updateSettings).toHaveBeenCalledTimes(1);
    expect(plugin.settings.licenseKey).toBe("skss-connected");
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("gives an accurate retry, never invalid-code, when the poll that burned the code never answers", async () => {
    const { service, openedUrls, outcomes } = createNativeService();
    serve([hang], [invalidCode]);

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);
    const manual = service.submitManualCode("manual-code");
    await jest.advanceTimersByTimeAsync(15_000 + 15_000);

    await expect(manual).resolves.toEqual({ kind: "error", reason: "unconfirmed" });
    expect(service.hasPendingRequest()).toBe(true);

    // The retry: the browser page for the same request mints a fresh code,
    // and the resumed polling redeems it.
    expect(await service.reopen()).toBe(true);
    expect(parseConnectUrl(openedUrls[1]).challenge).toBe(parseConnectUrl(openedUrls[0]).challenge);
    serve([() => Promise.resolve(native(200, successPayload))]);
    await jest.advanceTimersByTimeAsync(3_500);
    expect(outcomes).toEqual([expect.objectContaining({ kind: "signed-in" })]);
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("treats a poll that failed after reaching the server as a possible sign-in", async () => {
    const { service } = createNativeService();
    serve([() => Promise.reject(new Error("socket hang up"))], [invalidCode]);

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);

    await expect(service.submitManualCode("manual-code")).resolves.toEqual({ kind: "error", reason: "unconfirmed" });
    expect(service.hasPendingRequest()).toBe(true);
  });

  it("completes the sign-in from a timed-out poll that lands after the next poll found the code used", async () => {
    const { service, plugin, outcomes } = createNativeService();
    const poll = late();
    serve([poll.respond]);

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);
    // The slot is released after 15 s; the next tick polls and finds no
    // unused code, since the first poll burned it.
    await jest.advanceTimersByTimeAsync(15_000 + 3_500);
    expect(nativeCalls("/auth/poll")).toHaveLength(2);
    expect(outcomes).toHaveLength(0);
    expect(service.hasPendingRequest()).toBe(true);

    poll.land(native(200, successPayload));
    await jest.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual([expect.objectContaining({ kind: "signed-in" })]);
    expect(plugin.updateSettings).toHaveBeenCalledTimes(1);
    expect(service.hasPendingRequest()).toBe(false);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(nativeCalls("/auth/poll")).toHaveLength(2);
    expect(outcomes).toHaveLength(1);
  });

  it("completes the sign-in in the background when an exchange lands after it reported a network failure", async () => {
    const { service, outcomes } = createNativeService();
    const exchange = late();
    serve([], [exchange.respond]);

    await service.begin("sign-in");
    const manual = service.submitManualCode("manual-code");
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(manual).resolves.toEqual({ kind: "error", reason: "network" });
    expect(service.hasPendingRequest()).toBe(true);

    exchange.land(native(200, successPayload));
    await jest.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual([expect.objectContaining({ kind: "signed-in" })]);
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("lets a retried code adopt the first exchange that lands late with the sign-in", async () => {
    const { service, plugin, outcomes } = createNativeService();
    const first = late();
    serve([], [first.respond, invalidCode]);

    await service.begin("sign-in");
    const firstAttempt = service.submitManualCode("manual-code");
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(firstAttempt).resolves.toEqual({ kind: "error", reason: "network" });

    // The retry is told the code is used: the first exchange burned it.
    const retry = service.submitManualCode("manual-code");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(nativeCalls("/auth/exchange")).toHaveLength(2);

    first.land(native(200, successPayload));
    await expect(retry).resolves.toMatchObject({ kind: "signed-in" });
    expect(outcomes).toHaveLength(0);
    expect(plugin.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("does not let a hung poll for a cancelled sign-in block a new one", async () => {
    const { service, outcomes } = createNativeService();
    nativeRequest
      .mockImplementationOnce(hang)
      .mockResolvedValueOnce(native(200, successPayload));

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);
    service.cancelPending();

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);
    expect(nativeCalls("/auth/poll")).toHaveLength(2);
    expect(outcomes).toEqual([expect.objectContaining({ kind: "signed-in" })]);
  });
});

/**
 * Leaving the sign-in screen stops the poll timer (#359); a return to the app
 * polls once. The node test window has no events, so these tests install
 * event targets for the window and document.
 */
describe("AccountConnectService abandoned sign-in", () => {
  const windowEvents = new EventTarget();
  const documentEvents = Object.assign(new EventTarget(), { hidden: false });
  let restoreHost: () => void = () => undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    request.mockReset();
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    const host = window as unknown as Record<string, unknown>;
    const saved = {
      addEventListener: host.addEventListener,
      removeEventListener: host.removeEventListener,
      dispatchEvent: host.dispatchEvent,
      document: (globalThis as Record<string, unknown>).document,
    };
    host.addEventListener = windowEvents.addEventListener.bind(windowEvents);
    host.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
    host.dispatchEvent = windowEvents.dispatchEvent.bind(windowEvents);
    (globalThis as Record<string, unknown>).document = documentEvents;
    restoreHost = () => {
      host.addEventListener = saved.addEventListener;
      host.removeEventListener = saved.removeEventListener;
      host.dispatchEvent = saved.dispatchEvent;
      (globalThis as Record<string, unknown>).document = saved.document;
    };
  });

  afterEach(() => {
    // End every sign-in while the host events it listens to still exist.
    createdServices.splice(0).forEach((service) => service.cancelPending());
    restoreHost();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function createPollingService() {
    const created = createService();
    const outcomes: ConnectOutcome[] = [];
    created.service.setBackgroundOutcomeHandler((outcome) => outcomes.push(outcome));
    return { ...created, outcomes };
  }

  it("slows an abandoned sign-in to a 30 s background poll and polls at once when the user returns", async () => {
    const { service, plugin, outcomes } = createPollingService();
    request.mockResolvedValue(jsonResponse(200, { status: "pending" }));

    await service.begin("sign-in");
    service.pollInBackground();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(request).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("focus"));
    await jest.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);

    request.mockResolvedValue(jsonResponse(200, successPayload));
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    await jest.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(4);
    expect(plugin.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ licenseKey: "skss-connected" }),
    );
    expect(outcomes).toHaveLength(1);

    // A finished sign-in leaves no timer or return listeners behind.
    window.dispatchEvent(new Event("focus"));
    await jest.advanceTimersByTimeAsync(10 * 30_000);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("completes a dismissed sign-in whose deep link was lost while Obsidian stays in front", async () => {
    const { service, outcomes } = createPollingService();
    request.mockResolvedValueOnce(jsonResponse(200, { status: "pending" }));
    request.mockResolvedValueOnce(jsonResponse(200, successPayload));

    await service.begin("sign-in");
    service.pollInBackground();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(outcomes).toEqual([
      { kind: "signed-in", name: "User", email: "user@example.com", licenseValid: true },
    ]);
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("stops background polling when the sign-in expires, and a new sign-in polls at full speed", async () => {
    const { service } = createPollingService();
    request.mockResolvedValue(jsonResponse(200, { status: "pending" }));

    await service.begin("sign-in");
    service.pollInBackground();
    await jest.advanceTimersByTimeAsync(10 * 60_000 + 30_000);
    const polledWhilePending = request.mock.calls.length;
    expect(polledWhilePending).toBeLessThanOrEqual(21);
    expect(service.hasPendingRequest()).toBe(false);
    await jest.advanceTimersByTimeAsync(5 * 30_000);
    expect(request).toHaveBeenCalledTimes(polledWhilePending);

    await service.begin("sign-in");
    await jest.advanceTimersByTimeAsync(3_500);
    expect(request).toHaveBeenCalledTimes(polledWhilePending + 1);
  });

  it("never lets a background or return poll race a code exchange", async () => {
    const { service } = createPollingService();
    let finishExchange!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishExchange = resolve; }));

    await service.begin("sign-in");
    service.pollInBackground();
    const exchange = service.submitManualCode("one-time");
    await jest.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("focus"));
    service.pollInBackground();
    // Within the exchange's own wait for its answer.
    await jest.advanceTimersByTimeAsync(25_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].url).toBe(`${API_BASE_URL}/auth/exchange`);

    finishExchange(jsonResponse(200, successPayload));
    await expect(exchange).resolves.toMatchObject({ kind: "signed-in" });
  });

  it("still completes a background sign-in from its deep link", async () => {
    const { service, openedUrls } = createPollingService();
    request.mockResolvedValueOnce(jsonResponse(200, successPayload));

    await service.begin("sign-in");
    service.pollInBackground();
    const { state } = parseConnectUrl(openedUrls[0]);

    await expect(service.handleProtocolCallback({ state, code: "one-time" })).resolves.toMatchObject({
      kind: "signed-in",
    });
    expect(request.mock.calls[0][0].url).toBe(`${API_BASE_URL}/auth/exchange`);
  });

  it("ends a pending sign-in when the plugin unloads", async () => {
    const { service, plugin } = createPollingService();
    await service.begin("sign-in");
    service.pollInBackground();

    const onUnload = plugin.register.mock.calls[0][0] as () => void;
    onUnload();
    window.dispatchEvent(new Event("focus"));
    await jest.advanceTimersByTimeAsync(5 * 30_000);

    expect(service.hasPendingRequest()).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
