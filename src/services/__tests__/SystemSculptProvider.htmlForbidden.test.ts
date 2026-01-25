describe("SystemSculptProvider HTML 403 handling", () => {
  let requestUrlMock: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-09-19T00:00:00Z"));

    const obsidian = await import("obsidian");
    requestUrlMock = obsidian.requestUrl as jest.Mock;
    requestUrlMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("preserves html-response details instead of surfacing a generic circuit-open HOST_UNAVAILABLE error", async () => {
    requestUrlMock.mockResolvedValue({
      status: 403,
      text: "<html><body>Forbidden</body></html>",
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const { SystemSculptProvider } = await import("../embeddings/providers/SystemSculptProvider");
    const provider = new SystemSculptProvider("fake-license", "https://api.systemsculpt.com/api/v1");

    let error: any;
    const promise = provider.generateEmbeddings(["hello"]).catch((caught) => {
      error = caught;
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(error).toBeTruthy();
    expect(error).toMatchObject({
      name: "EmbeddingsProviderError",
      code: "HOST_UNAVAILABLE",
      status: 403,
      details: expect.objectContaining({
        kind: "html-response",
      }),
    });
    expect(String(error.message)).toMatch(/received html/i);
  });
});
