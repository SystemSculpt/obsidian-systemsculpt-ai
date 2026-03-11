describe("PiTextCatalog import safety", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("does not load PiTextModels during module import", () => {
    jest.doMock("../../pi/PiTextModels", () => {
      throw new Error("PiTextModels should not load during PiTextCatalog import");
    });

    jest.isolateModules(() => {
      const { listPiTextCatalogModels } = require("../PiTextCatalog");
      expect(typeof listPiTextCatalogModels).toBe("function");
    });
  });
});
