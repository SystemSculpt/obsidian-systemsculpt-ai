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

  it("loads provider auth records from static metadata without importing the Pi runtime", async () => {
    jest.doMock("../../../services/pi/PiSdkRuntime", () => {
      throw new Error("PiSdkRuntime should not load during provider inventory reads");
    });

    let listStudioPiProviderAuthRecords: typeof import("../StudioPiAuthInventory").listStudioPiProviderAuthRecords;
    jest.isolateModules(() => {
      ({ listStudioPiProviderAuthRecords } = require("../StudioPiAuthInventory"));
    });

    const records = await listStudioPiProviderAuthRecords!({
      providerHints: ["anthropic"],
      authData: {
        anthropic: {
          type: "oauth",
          expires: 123456789,
        },
      },
    });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "anthropic",
          hasAnyAuth: true,
          credentialType: "oauth",
          source: "oauth",
          oauthExpiresAt: 123456789,
        }),
      ]),
    );
  });

  it("reads provider auth records through the Pi auth storage wrapper when an auth path is provided", async () => {
    const storage = {
      getAll: jest.fn(() => ({
        anthropic: {
          type: "oauth",
          expires: 987654321,
        },
      })),
      has: jest.fn((provider: string) => provider === "anthropic"),
      hasAuth: jest.fn((provider: string) => provider === "anthropic"),
    };

    jest.doMock("../../../services/pi/PiSdkAuthStorage", () => ({
      createBundledPiAuthStorage: jest.fn(() => storage),
    }));

    let listStudioPiProviderAuthRecords: typeof import("../StudioPiAuthInventory").listStudioPiProviderAuthRecords;
    jest.isolateModules(() => {
      ({ listStudioPiProviderAuthRecords } = require("../StudioPiAuthInventory"));
    });

    const records = await listStudioPiProviderAuthRecords!({
      providerHints: ["anthropic"],
      authPath: "/tmp/systemsculpt-pi-auth.json",
    });

    expect(storage.getAll).toHaveBeenCalledTimes(1);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "anthropic",
          hasAnyAuth: true,
          hasStoredCredential: true,
          credentialType: "oauth",
          source: "oauth",
          oauthExpiresAt: 987654321,
        }),
      ]),
    );
  });

  it("wraps OAuth login with the desktop fetch shim", async () => {
    const storage = {
      login: jest.fn(async () => {}),
      getOAuthProviders: jest.fn(() => []),
    };
    const withPiDesktopFetchShim = jest.fn(async (callback: () => Promise<unknown>) => await callback());

    jest.doMock("../../../services/pi/PiSdkDesktopSupport", () => ({
      createPiAuthStorage: jest.fn(() => storage),
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

  it("saves provider API keys without importing the full Pi runtime", async () => {
    const storage = {
      set: jest.fn(),
    };

    jest.doMock("../../../services/pi/PiSdkRuntime", () => {
      throw new Error("PiSdkRuntime should not load during provider auth writes");
    });
    jest.doMock("../../../services/pi/PiSdkDesktopSupport", () => ({
      createPiAuthStorage: jest.fn(() => storage),
      withPiDesktopFetchShim: jest.fn(async (callback: () => Promise<unknown>) => await callback()),
    }));

    let setStudioPiProviderApiKey: typeof import("../StudioPiAuthStorage").setStudioPiProviderApiKey;
    jest.isolateModules(() => {
      ({ setStudioPiProviderApiKey } = require("../StudioPiAuthStorage"));
    });

    await setStudioPiProviderApiKey!("openai", "sk-test");

    expect(storage.set).toHaveBeenCalledWith("openai", {
      type: "api_key",
      key: "sk-test",
    });
  });
});
