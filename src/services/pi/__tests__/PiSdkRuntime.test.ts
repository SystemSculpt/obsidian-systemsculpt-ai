describe("PiSdkRuntime", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("routes Pi SDK fetches through the current Electron session and normalizes headers", async () => {
    const sessionFetch = jest.fn(async () => new Response("ok", { status: 200 }));
    const previousFetch = global.fetch;

    jest.doMock("electron", () => ({
      remote: {
        getCurrentWebContents: () => ({
          session: {
            fetch: sessionFetch,
          },
        }),
      },
    }), { virtual: true });

    let installPiDesktopFetchShim: typeof import("../PiSdkRuntime").installPiDesktopFetchShim;
    jest.isolateModules(() => {
      ({ installPiDesktopFetchShim } = require("../PiSdkRuntime"));
    });

    const restore = installPiDesktopFetchShim!();
    const request = new Request("https://example.com/test", {
      method: "POST",
      headers: new Headers({
        "x-test": "123",
      }),
      body: "payload",
    });

    try {
      await global.fetch(request);
      expect(sessionFetch).toHaveBeenCalledWith(
        "https://example.com/test",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "x-test": "123" }),
          body: "payload",
        })
      );
    } finally {
      restore();
      global.fetch = previousFetch;
    }
  });
});
