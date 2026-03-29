describe("PiTextAuth", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
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
});
