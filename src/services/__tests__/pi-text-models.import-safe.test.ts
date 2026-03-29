describe("PiTextModels lightweight import safety", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("does not load PiSdkRuntime for lightweight provider inventory helpers", async () => {
    jest.doMock("../pi/PiSdkRuntime", () => {
      throw new Error("PiSdkRuntime should not load during lightweight provider inventory reads");
    });
    jest.doMock("../PlatformContext", () => ({
      PlatformContext: {
        get: jest.fn(() => ({
          supportsDesktopOnlyFeatures: jest.fn(() => true),
        })),
      },
    }));

    let collectSharedPiProviderHints: typeof import("../pi/PiTextModels").collectSharedPiProviderHints;
    let listLocalPiProviderIds: typeof import("../pi/PiTextModels").listLocalPiProviderIds;

    jest.isolateModules(() => {
      ({ collectSharedPiProviderHints, listLocalPiProviderIds } = require("../pi/PiTextModels"));
    });

    expect(
      collectSharedPiProviderHints!([
        {
          id: "openai-fallback",
          name: "OpenAI fallback",
          endpoint: "https://api.openai.com/v1",
          apiKey: "",
          isEnabled: true,
        },
      ]),
    ).toContain("openai");

    await expect(
      listLocalPiProviderIds!({
        app: {
          vault: {
            adapter: {
              getFullPath: (vaultPath: string) =>
                `/tmp/systemsculpt-pi-text-models-import-safe/${vaultPath}`,
            },
          },
        },
      } as any),
    ).resolves.toEqual([]);
  });
});
