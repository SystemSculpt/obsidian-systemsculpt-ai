describe("LocalPiStreamExecutor import safety", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("does not load PiLocalAgentExecutor during module import", () => {
    jest.doMock("../pi-native/PiLocalAgentExecutor", () => {
      throw new Error("PiLocalAgentExecutor should not load during LocalPiStreamExecutor import");
    });

    jest.isolateModules(() => {
      const { executeLocalPiStream } = require("../LocalPiStreamExecutor");
      expect(typeof executeLocalPiStream).toBe("function");
    });
  });
});
