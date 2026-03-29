describe("ProvidersTabContent import safety", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("does not load Pi auth or model modules during module import", () => {
    jest.doMock("../studio/piAuth/StudioPiAuthInventory", () => {
      throw new Error("StudioPiAuthInventory should not load during ProvidersTabContent import");
    });
    jest.doMock("../studio/piAuth/StudioPiAuthStorage", () => {
      throw new Error("StudioPiAuthStorage should not load during ProvidersTabContent import");
    });
    jest.doMock("../studio/piAuth/StudioPiOAuthLoginFlow", () => {
      throw new Error("StudioPiOAuthLoginFlow should not load during ProvidersTabContent import");
    });
    jest.doMock("../services/pi/PiTextModels", () => {
      throw new Error("PiTextModels should not load during ProvidersTabContent import");
    });

    const { displayProvidersTabContent } = require("../settings/ProvidersTabContent");
    expect(typeof displayProvidersTabContent).toBe("function");
  });
});
