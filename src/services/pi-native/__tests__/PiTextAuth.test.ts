describe("PiTextAuth", () => {
  let supportsDesktopOnlyFeaturesMock: jest.Mock<boolean, []>;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    supportsDesktopOnlyFeaturesMock = jest.fn(() => true);

    jest.doMock("../../PlatformContext", () => ({
      PlatformContext: {
        get: jest.fn(() => ({
          supportsDesktopOnlyFeatures: supportsDesktopOnlyFeaturesMock,
        })),
      },
    }));
  });

  it("stays import-safe when desktop auth storage is unavailable", () => {
    jest.doMock("../../../studio/piAuth/StudioPiAuthInventory", () => {
      throw new Error("StudioPiAuthInventory should not load during PiTextAuth import");
    });
    jest.doMock("../../../studio/piAuth/StudioPiAuthStorage", () => {
      throw new Error("StudioPiAuthStorage should not load during PiTextAuth import");
    });

    jest.isolateModules(() => {
      const { piTextProviderRequiresAuth, buildPiTextProviderSetupMessage } = require("../PiTextAuth");

      expect(piTextProviderRequiresAuth("openai")).toBe(true);
      expect(buildPiTextProviderSetupMessage("openai", "gpt-5")).toBe(
        'Connect OpenAI in Pi before running "gpt-5".'
      );
    });
  });

  it("loads auth storage only when desktop auth records are requested", async () => {
    const listStudioPiProviderAuthRecords = jest.fn().mockResolvedValue([
      {
        provider: "openai",
        displayName: "OpenAI",
        supportsOAuth: false,
        hasAnyAuth: true,
        hasStoredCredential: true,
        credentialType: "api_key",
        source: "api_key",
        oauthExpiresAt: null,
      },
    ]);

    jest.doMock("obsidian", () => {
      const actual = jest.requireActual("obsidian");
      return {
        ...actual,
        Platform: {
          ...actual.Platform,
          isDesktopApp: true,
        },
      };
    });

    jest.doMock("../../../studio/piAuth/StudioPiAuthInventory", () => ({
      listStudioPiProviderAuthRecords,
    }));

    jest.doMock("../../../studio/piAuth/StudioPiAuthStorage", () => ({
      resolveStudioPiProviderApiKey: jest.fn(),
    }));

    let loadPiTextProviderAuth: typeof import("../PiTextAuth").loadPiTextProviderAuth;
    jest.isolateModules(() => {
      ({ loadPiTextProviderAuth } = require("../PiTextAuth"));
    });

    const records = await loadPiTextProviderAuth!(["openai"]);

    expect(listStudioPiProviderAuthRecords).toHaveBeenCalledWith({ providerHints: ["openai"] });
    expect(records.get("openai")).toEqual(
      expect.objectContaining({
        provider: "openai",
        hasAnyAuth: true,
      })
    );
  });

  it("reads mobile provider auth records instead of short-circuiting on non-desktop", async () => {
    supportsDesktopOnlyFeaturesMock.mockReturnValue(false);

    const listStudioPiProviderAuthRecords = jest.fn().mockResolvedValue([
      {
        provider: "openrouter",
        hasAnyAuth: true,
      },
    ]);

    jest.doMock("../../../studio/piAuth/StudioPiAuthInventory", () => ({
      listStudioPiProviderAuthRecords,
    }));

    jest.doMock("../../../studio/piAuth/StudioPiAuthStorage", () => ({
      resolveStudioPiProviderApiKey: jest.fn().mockResolvedValue("sk-or-mobile"),
    }));

    let loadPiTextProviderAuth: typeof import("../PiTextAuth").loadPiTextProviderAuth;
    let hasPiTextProviderAuth: typeof import("../PiTextAuth").hasPiTextProviderAuth;
    let resolvePiTextProviderCredential: typeof import("../PiTextAuth").resolvePiTextProviderCredential;
    jest.isolateModules(() => {
      ({
        loadPiTextProviderAuth,
        hasPiTextProviderAuth,
        resolvePiTextProviderCredential,
      } = require("../PiTextAuth"));
    });

    const records = await loadPiTextProviderAuth!(["openrouter"]);

    expect(listStudioPiProviderAuthRecords).toHaveBeenCalledWith({ providerHints: ["openrouter"] });
    expect(records.get("openrouter")).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        hasAnyAuth: true,
      }),
    );
    await expect(hasPiTextProviderAuth!("openrouter")).resolves.toBe(true);
    await expect(resolvePiTextProviderCredential!("openrouter")).resolves.toEqual({
      apiKey: "sk-or-mobile",
    });
  });
});
