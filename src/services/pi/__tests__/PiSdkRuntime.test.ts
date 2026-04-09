const sessionFetchMock = jest.fn();

jest.mock("../PiSdkAuthStorage", () => ({
  createBundledPiAuthStorage: jest.fn(() => ({})),
}));

jest.mock(
  "electron",
  () => ({
    remote: {
      getCurrentWebContents: () => ({
        session: {
          fetch: sessionFetchMock,
        },
      }),
    },
  }),
  { virtual: true }
);

import { installPiDesktopFetchShim } from "../PiSdkRuntime";

describe("PiSdkRuntime", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    sessionFetchMock.mockReset();
    global.fetch = jest.fn(async () => new Response("original")) as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("normalizes electron session.fetch response headers into a standard Headers object", async () => {
    const text = jest.fn(async () => '{"ok":true}');
    const json = jest.fn(async () => ({ ok: true }));
    const makeResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://example.com",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_123",
      },
      text,
      json,
      clone() {
        return makeResponse();
      },
    });

    sessionFetchMock.mockResolvedValue(makeResponse());

    const restore = installPiDesktopFetchShim();
    const response = await global.fetch("https://example.com", {
      headers: {
        authorization: "Bearer token",
      },
    });
    const clonedResponse = response.clone();
    restore();

    expect(sessionFetchMock).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        headers: {
          authorization: "Bearer token",
        },
      })
    );

    expect(response.headers).toBeInstanceOf(Headers);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(Array.from(response.headers.entries())).toContainEqual(["x-request-id", "req_123"]);

    expect(clonedResponse.headers).toBeInstanceOf(Headers);
    expect(clonedResponse.headers.get("x-request-id")).toBe("req_123");
  });

  it("stringifies URLSearchParams body for Electron session.fetch compatibility", async () => {
    sessionFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      text: jest.fn(async () => "ok"),
      json: jest.fn(async () => ({})),
    });

    const restore = installPiDesktopFetchShim();
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "test-client",
      code: "abc123",
    });

    await global.fetch("https://auth.example.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    restore();

    expect(sessionFetchMock).toHaveBeenCalledWith(
      "https://auth.example.com/token",
      expect.objectContaining({
        method: "POST",
        body: params.toString(),
      })
    );

    // Verify it's a string, not a URLSearchParams object
    const actualBody = sessionFetchMock.mock.calls[0][1].body;
    expect(typeof actualBody).toBe("string");
    expect(actualBody).toContain("grant_type=authorization_code");
    expect(actualBody).toContain("client_id=test-client");
    expect(actualBody).toContain("code=abc123");
  });
});
