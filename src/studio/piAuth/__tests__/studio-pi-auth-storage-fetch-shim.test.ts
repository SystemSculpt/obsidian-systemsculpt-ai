import { Platform } from "obsidian";

describe("StudioPiAuthStorage fetch shim integration", () => {
  const originalIsDesktopApp = Platform.isDesktopApp;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: originalIsDesktopApp,
    });
  });

  it("wraps provider auth record loading with the desktop fetch shim before refreshing OAuth-backed API keys", async () => {
    const storage = {
      getOAuthProviders: jest.fn(() => [{ id: "anthropic", name: "Anthropic", usesCallbackServer: false }]),
      get: jest.fn(() => ({ type: "oauth", access: "stale-token" })),
      getApiKey: jest.fn(async () => "fresh-token"),
      hasAuth: jest.fn(() => true),
      has: jest.fn(() => true),
      list: jest.fn(() => ["anthropic"]),
      getAll: jest.fn(() => ({ anthropic: { type: "oauth", access: "stale-token" } })),
    };
    const withPiDesktopFetchShim = jest.fn(async (callback: () => Promise<unknown>) => await callback());

    jest.doMock("@mariozechner/pi-coding-agent", () => ({
      AuthStorage: {
        create: jest.fn(() => storage),
      },
    }));
    jest.doMock("../../../services/pi/PiSdkRuntime", () => ({
      withPiDesktopFetchShim,
    }));

    let listStudioPiProviderAuthRecords: typeof import("../StudioPiAuthStorage").listStudioPiProviderAuthRecords;
    jest.isolateModules(() => {
      ({ listStudioPiProviderAuthRecords } = require("../StudioPiAuthStorage"));
    });

    const records = await listStudioPiProviderAuthRecords!({ providerHints: ["anthropic"] });

    expect(withPiDesktopFetchShim).toHaveBeenCalled();
    expect(storage.getApiKey).toHaveBeenCalledWith("anthropic");
    expect(records).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        hasAnyAuth: true,
        credentialType: "oauth",
        source: "oauth",
      }),
    ]);
  });

  it("wraps OAuth login with the desktop fetch shim", async () => {
    const storage = {
      login: jest.fn(async () => {}),
      getOAuthProviders: jest.fn(() => []),
    };
    const withPiDesktopFetchShim = jest.fn(async (callback: () => Promise<unknown>) => await callback());

    jest.doMock("@mariozechner/pi-coding-agent", () => ({
      AuthStorage: {
        create: jest.fn(() => storage),
      },
    }));
    jest.doMock("../../../services/pi/PiSdkRuntime", () => ({
      withPiDesktopFetchShim,
    }));

    let loginStudioPiProviderOAuth: typeof import("../StudioPiAuthStorage").loginStudioPiProviderOAuth;
    jest.isolateModules(() => {
      ({ loginStudioPiProviderOAuth } = require("../StudioPiAuthStorage"));
    });

    await loginStudioPiProviderOAuth!({
      providerId: "anthropic",
      onAuth: jest.fn(),
      onPrompt: jest.fn(async () => "done"),
    });

    expect(withPiDesktopFetchShim).toHaveBeenCalledTimes(1);
    expect(storage.login).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({
        onAuth: expect.any(Function),
        onPrompt: expect.any(Function),
      })
    );
  });
});
