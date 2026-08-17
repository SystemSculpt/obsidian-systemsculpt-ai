import { createHash } from "crypto";
import { API_BASE_URL } from "../../constants/api";
import { AccountConnectService } from "../AccountConnectService";
import { Notice } from "obsidian";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return { ...actual, Notice: jest.fn() };
});

const mockedNotice = Notice as unknown as jest.Mock;

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
  const validateLicenseKeyDetailed = jest.fn(async () => ({ outcome: "valid", isValid: true }));
  return {
    settings,
    getSettingsManager: () => ({ updateSettings }),
    getLicenseManager: () => ({ validateLicenseKeyDetailed }),
    updateSettings,
    validateLicenseKeyDetailed,
  } as any;
}

function createService(plugin = createPlugin()) {
  const openedUrls: string[] = [];
  const opener = jest.fn(async (url: string) => {
    openedUrls.push(url);
    return true;
  });
  const service = new AccountConnectService(plugin, requestClient, opener);
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

    await service.handleProtocolCallback({ code: "code-1", state: "tampered-state" });

    expect(request).not.toHaveBeenCalled();
    expect(mockedNotice).toHaveBeenCalledWith(
      "Sign-in could not be verified. Start again from SystemSculpt settings.",
    );
    expect(service.hasPendingRequest()).toBe(true);
  });

  it("rejects a callback after the pending request expired", async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const { service, openedUrls } = createService();
    await service.begin("sign-in");
    const { state } = parseConnectUrl(openedUrls[0]);

    now += 10 * 60_000 + 1;
    await service.handleProtocolCallback({ code: "code-1", state });

    expect(request).not.toHaveBeenCalled();
    expect(mockedNotice).toHaveBeenCalledWith(
      "Sign-in session expired. Start sign-in again from SystemSculpt settings.",
    );
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("exchanges the code with the challenge-bound verifier and stores the license", async () => {
    const { service, plugin, openedUrls } = createService();
    request.mockResolvedValue(jsonResponse(200, successPayload));
    await service.begin("sign-in");
    const { state, challenge } = parseConnectUrl(openedUrls[0]);

    await service.handleProtocolCallback({ code: "code-1", state });

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
    expect(mockedNotice).toHaveBeenCalledWith("Signed in to SystemSculpt.");
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

    await service.handleProtocolCallback({ code: "code-1", state });

    expect(plugin.updateSettings).toHaveBeenCalledWith({
      licenseKey: "",
      licenseValid: false,
      userEmail: "user@example.com",
      userName: "user@example.com",
      displayName: "user@example.com",
      subscriptionStatus: "",
    });
    expect(plugin.validateLicenseKeyDetailed).not.toHaveBeenCalled();
    expect(mockedNotice).toHaveBeenCalledWith(
      "Signed in. Choose a plan to enable SystemSculpt AI features.",
    );
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("clears the pending request when the code is rejected as invalid", async () => {
    const { service, plugin, openedUrls } = createService();
    request.mockResolvedValue(jsonResponse(401, { error: "invalid_code" }));
    await service.begin("sign-in");
    const { state } = parseConnectUrl(openedUrls[0]);

    await service.handleProtocolCallback({ code: "code-1", state });

    expect(plugin.updateSettings).not.toHaveBeenCalled();
    expect(mockedNotice).toHaveBeenCalledWith(
      "Sign-in code was invalid or expired. Start again from SystemSculpt settings.",
    );
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("keeps the pending request across a network failure so the manual code can retry", async () => {
    const { service, plugin } = createService();
    request.mockRejectedValueOnce(new Error("offline"));
    await service.begin("sign-in");

    await service.submitManualCode("manual-code");
    expect(service.hasPendingRequest()).toBe(true);
    expect(plugin.updateSettings).not.toHaveBeenCalled();

    request.mockResolvedValueOnce(jsonResponse(200, successPayload));
    await service.submitManualCode("manual-code");

    expect(plugin.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ licenseKey: "skss-connected" }),
    );
    expect(service.hasPendingRequest()).toBe(false);
  });

  it("requires an active pending request before accepting a manual code", async () => {
    const { service } = createService();

    await service.submitManualCode("manual-code");

    expect(request).not.toHaveBeenCalled();
    expect(mockedNotice).toHaveBeenCalledWith(
      "Sign-in session expired. Start sign-in again from SystemSculpt settings.",
    );
  });
});
