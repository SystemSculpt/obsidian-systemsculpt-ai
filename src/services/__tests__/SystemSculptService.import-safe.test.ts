describe("SystemSculptService import safety", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("does not load LocalPiStreamExecutor during module import", () => {
    jest.doMock("../LocalPiStreamExecutor", () => {
      throw new Error("LocalPiStreamExecutor should not load during SystemSculptService import");
    });

    jest.isolateModules(() => {
      const { SystemSculptService } = require("../SystemSculptService");
      expect(typeof SystemSculptService.getInstance).toBe("function");
    });
  });
});
