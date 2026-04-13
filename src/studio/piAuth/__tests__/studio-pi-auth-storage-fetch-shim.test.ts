import { Platform } from "obsidian";

describe("StudioPiAuthStorage fetch shim integration", () => {
  const originalIsDesktopApp = Platform.isDesktopApp;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    // jest.resetModules() clears the cache but not the doMock registry, so
    // un-register module mocks each test or fs/path stubs leak.
    jest.dontMock("fs");
    jest.dontMock("../../../services/pi/PiSdkStoragePaths");
    jest.dontMock("../../../services/pi/PiSdkDesktopSupport");
    jest.dontMock("../../../services/pi/PiSdkAuthStorage");
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

  it("persists provider API keys to plugin settings when Pi auth storage is unavailable", async () => {
    const updateSettings = jest.fn(async (patch: any) => {
      plugin.settings = {
        ...plugin.settings,
        ...patch,
      };
    });
    const plugin = {
      settings: {
        customProviders: [],
      },
      getSettingsManager: () => ({
        updateSettings,
      }),
    } as any;

    jest.doMock("../../../services/pi/PiSdkDesktopSupport", () => ({
      createPiAuthStorage: jest.fn(() => {
        throw new Error("storage unavailable");
      }),
      withPiDesktopFetchShim: jest.fn(async (callback: () => Promise<unknown>) => await callback()),
    }));

    let setStudioPiProviderApiKey: typeof import("../StudioPiAuthStorage").setStudioPiProviderApiKey;
    let resolveStudioPiProviderApiKey: typeof import("../StudioPiAuthStorage").resolveStudioPiProviderApiKey;
    let readStudioPiProviderAuthState: typeof import("../StudioPiAuthStorage").readStudioPiProviderAuthState;
    jest.isolateModules(() => {
      ({
        setStudioPiProviderApiKey,
        resolveStudioPiProviderApiKey,
        readStudioPiProviderAuthState,
      } = require("../StudioPiAuthStorage"));
    });

    await setStudioPiProviderApiKey!("openrouter", "sk-or-mobile", { plugin });

    expect(updateSettings).toHaveBeenCalledWith({
      customProviders: [
        expect.objectContaining({
          id: "openrouter",
          name: "openrouter",
          apiKey: "sk-or-mobile",
          isEnabled: true,
        }),
      ],
    });

    await expect(resolveStudioPiProviderApiKey!("openrouter", { plugin })).resolves.toBe("sk-or-mobile");
    await expect(readStudioPiProviderAuthState!("openrouter", { plugin })).resolves.toEqual({
      provider: "openrouter",
      hasAnyAuth: true,
      source: "api_key",
    });
  });

  it("clears plugin-stored provider API keys even when Pi auth storage is unavailable", async () => {
    const updateSettings = jest.fn(async (patch: any) => {
      plugin.settings = {
        ...plugin.settings,
        ...patch,
      };
    });
    const plugin = {
      settings: {
        customProviders: [
          {
            id: "openrouter",
            name: "OpenRouter",
            endpoint: "https://openrouter.ai/api/v1",
            apiKey: "sk-or-mobile",
            isEnabled: true,
          },
        ],
      },
      getSettingsManager: () => ({
        updateSettings,
      }),
    } as any;

    jest.doMock("../../../services/pi/PiSdkDesktopSupport", () => ({
      createPiAuthStorage: jest.fn(() => {
        throw new Error("storage unavailable");
      }),
      withPiDesktopFetchShim: jest.fn(async (callback: () => Promise<unknown>) => await callback()),
    }));

    let clearStudioPiProviderAuth: typeof import("../StudioPiAuthStorage").clearStudioPiProviderAuth;
    let resolveStudioPiProviderApiKey: typeof import("../StudioPiAuthStorage").resolveStudioPiProviderApiKey;
    jest.isolateModules(() => {
      ({
        clearStudioPiProviderAuth,
        resolveStudioPiProviderApiKey,
      } = require("../StudioPiAuthStorage"));
    });

    await clearStudioPiProviderAuth!("openrouter", { plugin });

    expect(updateSettings).toHaveBeenCalledWith({
      customProviders: [
        expect.objectContaining({
          id: "openrouter",
          apiKey: "",
        }),
      ],
    });

    await expect(resolveStudioPiProviderApiKey!("openrouter", { plugin })).resolves.toBeNull();
  });

  it("rewrites auth.json directly when disconnecting to bypass proper-lockfile silent writes", async () => {
    const initialAuthJson = {
      "openai-codex": {
        type: "oauth",
        tokens: { access: "tok-abc", refresh: "tok-xyz" },
        expires: 1700000000000,
      },
      anthropic: {
        type: "oauth",
        tokens: { access: "claude-tok" },
      },
    };

    const fsState = {
      content: JSON.stringify(initialAuthJson, null, 2),
      writes: [] as Array<{ path: string; content: string }>,
    };

    jest.doMock("fs", () => ({
      existsSync: jest.fn((_path: string) => true),
      readFileSync: jest.fn((_path: string, _encoding: string) => fsState.content),
      writeFileSync: jest.fn((path: string, content: string) => {
        fsState.writes.push({ path, content });
        fsState.content = content;
      }),
      chmodSync: jest.fn(),
    }));

    jest.doMock("../../../services/pi/PiSdkStoragePaths", () => ({
      resolvePiAuthPath: jest.fn(() => "/fake/vault/.systemsculpt/pi-agent/auth.json"),
    }));

    const storageRemove = jest.fn(() => {
      // Simulate the SDK's silent-no-op: remove returns cleanly but nothing is
      // written to disk, mirroring the proper-lockfile failure path in Electron.
    });
    jest.doMock("../../../services/pi/PiSdkDesktopSupport", () => ({
      createPiAuthStorage: jest.fn(() => ({ remove: storageRemove })),
      withPiDesktopFetchShim: jest.fn(async (callback: () => Promise<unknown>) => await callback()),
    }));

    let clearStudioPiProviderAuth: typeof import("../StudioPiAuthStorage").clearStudioPiProviderAuth;
    jest.isolateModules(() => {
      ({ clearStudioPiProviderAuth } = require("../StudioPiAuthStorage"));
    });

    const plugin = {
      settings: { customProviders: [] },
      getSettingsManager: () => ({
        updateSettings: jest.fn(async () => {}),
      }),
    } as any;

    await clearStudioPiProviderAuth!("openai-codex", { plugin });

    expect(storageRemove).toHaveBeenCalledWith("openai-codex");
    expect(fsState.writes).toHaveLength(1);
    const [write] = fsState.writes;
    expect(write.path).toBe("/fake/vault/.systemsculpt/pi-agent/auth.json");
    const parsed = JSON.parse(write.content);
    expect(parsed).not.toHaveProperty("openai-codex");
    expect(parsed).toHaveProperty("anthropic");
  });

  it("skips direct fs rewrite when the provider is already absent from auth.json", async () => {
    const fsState = {
      content: JSON.stringify({ anthropic: { type: "oauth" } }, null, 2),
      writes: [] as Array<{ path: string; content: string }>,
    };

    jest.doMock("fs", () => ({
      existsSync: jest.fn(() => true),
      readFileSync: jest.fn(() => fsState.content),
      writeFileSync: jest.fn((path: string, content: string) => {
        fsState.writes.push({ path, content });
      }),
      chmodSync: jest.fn(),
    }));

    jest.doMock("../../../services/pi/PiSdkStoragePaths", () => ({
      resolvePiAuthPath: jest.fn(() => "/fake/vault/.systemsculpt/pi-agent/auth.json"),
    }));

    jest.doMock("../../../services/pi/PiSdkDesktopSupport", () => ({
      createPiAuthStorage: jest.fn(() => ({ remove: jest.fn() })),
      withPiDesktopFetchShim: jest.fn(async (callback: () => Promise<unknown>) => await callback()),
    }));

    let clearStudioPiProviderAuth: typeof import("../StudioPiAuthStorage").clearStudioPiProviderAuth;
    jest.isolateModules(() => {
      ({ clearStudioPiProviderAuth } = require("../StudioPiAuthStorage"));
    });

    await clearStudioPiProviderAuth!("openai-codex", {
      plugin: {
        settings: { customProviders: [] },
        getSettingsManager: () => ({ updateSettings: jest.fn(async () => {}) }),
      } as any,
    });

    expect(fsState.writes).toHaveLength(0);
  });

  it("uses plugin-stored API keys in inventory records when auth storage is unavailable", async () => {
    jest.doMock("../../../services/pi/PiSdkAuthStorage", () => ({
      createBundledPiAuthStorage: jest.fn(() => {
        throw new Error("storage unavailable");
      }),
    }));

    let listStudioPiProviderAuthRecords: typeof import("../StudioPiAuthInventory").listStudioPiProviderAuthRecords;
    jest.isolateModules(() => {
      ({ listStudioPiProviderAuthRecords } = require("../StudioPiAuthInventory"));
    });

    const plugin = {
      settings: {
        customProviders: [
          {
            id: "openrouter",
            name: "OpenRouter",
            endpoint: "https://openrouter.ai/api/v1",
            apiKey: "sk-or-mobile",
            isEnabled: true,
          },
        ],
      },
    } as any;

    const records = await listStudioPiProviderAuthRecords!({
      providerHints: ["openrouter"],
      plugin,
    });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openrouter",
          hasAnyAuth: true,
          hasStoredCredential: true,
          credentialType: "api_key",
          source: "api_key",
        }),
      ]),
    );
  });
});
