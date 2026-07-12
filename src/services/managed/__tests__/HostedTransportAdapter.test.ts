import { requestUrl } from "obsidian";
import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { PlatformContext } from "../../PlatformContext";
import { PlatformRequestClient } from "../../PlatformRequestClient";
import { HostedTransportAdapter } from "../adapters/HostedTransportAdapter";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), requestUrl: jest.fn() }));
jest.mock("../../PlatformContext", () => ({ PlatformContext: { get: jest.fn() } }));
jest.mock("../../PlatformRequestClient");

const response = (status = 200, body: unknown = { ok: true }) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json",
    "x-request-id": "request-1",
    "x-ratelimit-limit": "10",
    "x-ratelimit-remaining": "9",
    "x-ratelimit-reset": "123",
    "retry-after": "5",
  },
});

describe("HostedTransportAdapter", () => {
  const request = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    (PlatformRequestClient as jest.Mock).mockImplementation(() => ({ request }));
    request.mockResolvedValue(response());
  });

  it("pins GET discovery routes and exact negotiation/plugin headers while omitting a missing license", async () => {
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test/", pluginVersion: "6.0.0", licenseKey: () => "" });
    request.mockResolvedValueOnce(response(200, fixture)).mockResolvedValueOnce(response(401, { code: "license_required" }));
    await adapter.getCatalog();
    await adapter.getAdmission();
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({
      url: "https://api.test/api/plugin/config", method: "GET",
      headers: { "x-plugin-version": "6.0.0", "x-systemsculpt-contract": "managed-capabilities-v2" },
    }));
    expect(request.mock.calls[1][0]).toEqual(expect.objectContaining({
      url: "https://api.test/api/plugin/license/validate", method: "GET",
      headers: { "x-plugin-version": "6.0.0", "x-systemsculpt-admission-contract": "admission-v1" },
    }));
    expect(request.mock.calls[1][0].licenseKey).toBeUndefined();
  });

  it.each([
    [200, "allowed", "allowed"], [401, "license_required", "license_required"],
    [403, "license_rejected", "license_rejected"], [429, "rate_limited", "rate_limited"],
    [503, "temporarily_unavailable", "temporarily_unavailable"],
  ] as const)("accepts only exact admission-v1 status/code mapping %s/%s", async (status, code, expected) => {
    request.mockResolvedValue(response(status, { code }));
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6", licenseKey: () => "key" });
    expect((await adapter.getAdmission()).outcome).toBe(expected);
  });

  it.each([
    [500, "allowed"], [401, "allowed"], [200, "license_required"], [403, "license_required"],
    [401, "license_rejected"], [429, "temporarily_unavailable"], [503, "rate_limited"],
    [200, "unknown"], [200, undefined], [418, "license_rejected"],
  ])("normalizes contradictory or unknown admission %s/%s to temporarily_unavailable", async (status, code) => {
    request.mockResolvedValue(response(status as number, typeof code === "undefined" ? {} : { code }));
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6", licenseKey: () => "key" });
    expect((await adapter.getAdmission()).outcome).toBe("temporarily_unavailable");
  });

  it.each([
    ["key", "6", true], ["", "6", false], ["key", "", false], ["   ", "6", false], ["key", "   ", false],
  ])("atomically snapshots non-empty managed Chat configuration without returning credentials", (license, version, expected) => {
    const supplier = jest.fn(() => license);
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: version, licenseKey: supplier });
    expect(adapter.beginManagedChatDispatch() !== null).toBe(expected);
    expect(supplier).toHaveBeenCalledTimes(1);
  });

  it("uses one immutable managed Chat configuration snapshot without re-reading its supplier", async () => {
    const supplier = jest.fn().mockReturnValueOnce("first-key").mockReturnValue("changed-key");
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: " 6.0.0 ", licenseKey: supplier });
    const ticket = adapter.beginManagedChatDispatch()!;
    await adapter.streamAcceptedChat(ticket, { path: "/api/v1/chat/completions", capability: "chat_turn", idempotencyKey: "idem", body: {} });
    expect(supplier).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ licenseKey: "first-key", headers: { "x-license-key": "first-key", "x-plugin-version": "6.0.0" } });
  });

  it("adds operation contract headers and only explicit idempotency keys", async () => {
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6", licenseKey: () => " key " });
    await adapter.request({ path: "/op", method: "POST", body: { a: 1 }, capability: "embeddings", idempotencyKey: "idem" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      licenseKey: "key",
      headers: {
        "x-plugin-version": "6", "x-systemsculpt-contract": "managed-capabilities-v2",
        "x-systemsculpt-capability": "embeddings", "Idempotency-Key": "idem",
      },
    }));
  });

  it("forwards exact lowercase operation-scoped job headers without forcing plugin version", async () => {
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6", licenseKey: () => "key" });
    await adapter.job({ path: "/job", headers: {
      "x-systemsculpt-job-contract": "managed-job-protocol-v1",
      "x-systemsculpt-capability": "transcription",
      "idempotency-key": "op:create",
    } });
    expect(request.mock.calls[0][0].headers).toEqual({
      "x-systemsculpt-contract": "managed-capabilities-v2",
      "x-systemsculpt-job-contract": "managed-job-protocol-v1",
      "x-systemsculpt-capability": "transcription",
      "idempotency-key": "op:create",
    });
    expect(request.mock.calls[0][0].headers).not.toHaveProperty("Idempotency-Key");
    expect(request.mock.calls[0][0].headers).not.toHaveProperty("x-plugin-version");
  });

  it("uses the fixed first-party managed image output route through the existing transport sink", async () => {
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6", licenseKey: () => "secret" });
    const headers = { "x-systemsculpt-image-output-contract": "managed-image-output-v1" };
    await adapter.managedImageOutput("/api/plugin/images/generations/jobs/123e4567-e89b-42d3-a456-426614174000/outputs/0", headers);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ url: "https://api.test/api/plugin/images/generations/jobs/123e4567-e89b-42d3-a456-426614174000/outputs/0", method: "GET", headers: expect.objectContaining(headers), preserveResponseHeaders: true, licenseKey: "secret" }));
    await expect(adapter.managedImageOutput("https://signed.test/output", headers)).rejects.toThrow("Invalid managed image output path");
    await expect(adapter.managedImageOutput("/api/plugin/documents/id/download", headers)).rejects.toThrow("Invalid managed image output path");
  });

  it("uses the existing transport sink for signed uploads without adding license or managed headers", async () => {
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6", licenseKey: () => "secret" });
    await (adapter as any).uploadSignedInput("https://signed.test/input", "PUT", { "content-type": "image/png" }, new Uint8Array([1]).buffer);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ url: "https://signed.test/input", method: "PUT", headers: { "content-type": "image/png" }, preserveResponseHeaders: false }));
    expect(request.mock.calls[0][0].licenseKey).toBeUndefined();
  });

  it("returns bounded diagnostics with preserved response metadata", async () => {
    request.mockResolvedValue(response(503, { error: "x".repeat(5000) }));
    const adapter = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "6", licenseKey: () => "secret" });
    const result = await adapter.request({ path: "/op", method: "POST" });
    expect(result.diagnostics).toMatchObject({ status: 503, requestId: "request-1", contentType: "application/json", retryAfter: "5" });
    expect(result.diagnostics.errorText.length).toBeLessThanOrEqual(2048);
    expect(result.diagnostics.errorText).not.toContain("secret");
  });

  it("preserves requestUrl response headers and locally suppresses an aborted result without claiming server cancellation", async () => {
    const ActualClient = jest.requireActual("../../PlatformRequestClient").PlatformRequestClient as typeof PlatformRequestClient;
    (PlatformContext.get as jest.Mock).mockReturnValue({ preferredTransport: () => "requestUrl" });
    (requestUrl as jest.Mock).mockResolvedValue({ status: 429, text: "limited", json: null, headers: {
      "Content-Type": "application/json", "X-Request-Id": "native-1", "X-RateLimit-Remaining": "0", "Retry-After": "7",
    } });
    const nativeResponse = await new ActualClient().request({ url: "https://api.test/op", method: "GET" });
    expect(nativeResponse.headers.get("x-request-id")).toBe("native-1");
    expect(nativeResponse.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(nativeResponse.headers.get("retry-after")).toBe("7");

    let resolveNative!: (value: any) => void;
    (requestUrl as jest.Mock).mockReturnValue(new Promise((resolve) => { resolveNative = resolve; }));
    const controller = new AbortController();
    const pending = new ActualClient().request({ url: "https://api.test/op", method: "GET", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolveNative({ status: 200, text: "late", headers: {} });
  });
});
