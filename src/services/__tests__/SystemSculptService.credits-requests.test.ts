/**
 * @jest-environment node
 */
import { ERROR_CODES } from "../../utils/errors";
import { PlatformRequestClient } from "../PlatformRequestClient";
import { SystemSculptService } from "../SystemSculptService";

const balancePayload = {
  included_remaining: 10,
  add_on_remaining: 5,
  total_remaining: 15,
  included_per_month: 100,
  usage_class: "customer",
  cycle_anchor_at: "2026-10-01T00:00:00.000Z",
  cycle_started_at: "2026-10-01T00:00:00.000Z",
  cycle_ends_at: "2026-11-01T00:00:00.000Z",
  turn_in_flight_until: null,
};

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), init);
}

function createService(licenseKey = " license_for_test ") {
  const plugin = { settings: { licenseKey }, app: {} };
  return { plugin, service: SystemSculptService.getInstance(plugin as never) };
}

describe("SystemSculptService credits requests", () => {
  let request: jest.SpiedFunction<PlatformRequestClient["request"]>;

  beforeEach(() => {
    SystemSculptService.clearInstance();
    request = jest.spyOn(PlatformRequestClient.prototype, "request").mockImplementation(async () => {
      throw new Error("Unexpected credits request");
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    SystemSculptService.clearInstance();
  });

  it.each(["", " \t "])("does not send usage requests without a license (%j)", async (licenseKey) => {
    const { service } = createService(licenseKey);
    await expect(service.getCreditsUsage()).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_LICENSE,
      statusCode: 401,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("encodes usage filters, forwards cancellation and decodes billed activity", async () => {
    const { service } = createService();
    const controller = new AbortController();
    request.mockResolvedValue(jsonResponse({
      items: [{
        id: "usage-1", created_at: "2026-10-24T12:00:00.000Z", endpoint: " /chat ",
        usage_kind: "agent_turn", duration_seconds: "1.5", total_tokens: 30,
        input_tokens: "20", output_tokens: 10, cache_read_tokens: 8, cache_write_tokens: 2,
        page_count: "3", credits_charged: "4", included_delta: -3, add_on_delta: "-1",
        total_delta: -4, included_before: 10, included_after: 7, add_on_before: 5,
        add_on_after: 4, total_before: 15, total_after: 11, raw_usd: "0.004",
        file_size_bytes: "1024", file_format: " pdf ", billing_formula_version: " v1 ",
        billing_credits_per_usd: "100", billing_markup_multiplier: 2,
        billing_credits_exact: "0.8",
      }],
      next_before: " cursor+/= ",
    }));

    await expect(service.getCreditsUsage({
      limit: 5.9, before: " cursor+/= ", endpoints: [" /chat ", "", "  ", "/audio"],
      signal: controller.signal,
    })).resolves.toEqual({
      items: [{
        id: "usage-1", createdAt: "2026-10-24T12:00:00.000Z", endpoint: "/chat",
        transactionType: "agent_turn", usageKind: "agent_turn", durationSeconds: 1.5,
        totalTokens: 30, inputTokens: 20, outputTokens: 10, cacheReadTokens: 8,
        cacheWriteTokens: 2, pageCount: 3, creditsCharged: 4, includedDelta: -3,
        addOnDelta: -1, totalDelta: -4, includedBefore: 10, includedAfter: 7,
        addOnBefore: 5, addOnAfter: 4, totalBefore: 15, totalAfter: 11, rawUsd: 0.004,
        fileSizeBytes: 1024, fileFormat: "pdf", billingFormulaVersion: "v1",
        billingCreditsPerUsd: 100, billingMarkupMultiplier: 2, billingCreditsExact: 0.8,
      }],
      nextBefore: "cursor+/=",
    });
    expect(request).toHaveBeenCalledTimes(1);
    const input = request.mock.calls[0][0];
    const url = new URL(input.url);
    expect(url.pathname).toBe("/api/plugin/credits/usage");
    expect([...url.searchParams]).toEqual([
      ["limit", "5"], ["before", "cursor+/="], ["endpoint", "/chat"], ["endpoint", "/audio"],
    ]);
    expect(input.signal).toBe(controller.signal);
    expect(input.method).toBe("GET");
    expect(input.headers).toMatchObject({ Accept: "application/json", "x-license-key": "license_for_test" });
  });

  it.each([0, -1, NaN, Infinity])("omits invalid usage limits (%s) and blank cursors", async (limit) => {
    const { service } = createService();
    request.mockResolvedValue(jsonResponse({ items: [], next_before: null }));
    await expect(service.getCreditsUsage({ limit, before: " " })).resolves.toEqual({
      items: [], nextBefore: null,
    });
    expect(new URL(request.mock.calls[0][0].url).search).toBe("");
  });

  it.each([null, [], "invalid", { items: "invalid", next_before: 42 }])(
    "handles missing usage-page fields without crashing (%j)", async (payload) => {
      const { service } = createService();
      request.mockResolvedValue(jsonResponse(payload));
      await expect(service.getCreditsUsage()).resolves.toEqual({ items: [], nextBefore: null });
    },
  );

  it("keeps supported activity types and safely defaults unknown or malformed legacy fields", async () => {
    const { service } = createService();
    const kinds = ["audio_transcription", "embeddings", "document_processing", "agent_turn", "request"];
    request.mockResolvedValue(jsonResponse({
      items: [
        ...kinds.map((usage_kind) => ({ usage_kind })),
        { usage_kind: "future-kind", credits_charged: "not-a-number", total_tokens: "Infinity", file_format: 9 },
        null, [],
      ],
    }));
    const page = await service.getCreditsUsage();
    expect(page.items.map((item) => item.usageKind)).toEqual([...kinds, "request", "request", "request"]);
    expect(page.items[5]).toMatchObject({
      creditsCharged: 0, totalTokens: 0, fileFormat: null, fileSizeBytes: null,
      billingFormulaVersion: null, billingCreditsPerUsd: null,
      billingMarkupMultiplier: null, billingCreditsExact: null,
    });
    expect(page.items[6]).toEqual(page.items[7]);
    expect(page.items[6]).toMatchObject({ id: "", createdAt: "", endpoint: null });
  });

  it.each(["balance", "usage"] as const)("preserves account-recovery errors from the %s endpoint", async (kind) => {
    const { service } = createService();
    request.mockResolvedValue(jsonResponse({
      error: { code: "invalid_license", message: "Sign in again." },
    }, { status: 401 }));
    await expect(kind === "balance" ? service.getCreditsBalance() : service.getCreditsUsage())
      .rejects.toMatchObject({
        code: ERROR_CODES.INVALID_LICENSE, statusCode: 401, message: "Sign in again.",
        metadata: { licenseFailure: true, endpoint: `${service.baseUrl}/credits/${kind}` },
      });
  });

  it("observes status and server timing without letting a diagnostics failure break the balance", async () => {
    const { service } = createService();
    const observer = jest.fn(() => { throw new Error("Diagnostics unavailable"); });
    request.mockImplementation(async (input) => {
      input.onTransportSelected?.("requestUrl");
      return jsonResponse(balancePayload, { headers: { "server-timing": "auth;dur=4, total;dur=12" } });
    });
    await expect(service.getCreditsBalance({ onObservation: observer })).resolves.toMatchObject({ totalRemaining: 15 });
    expect(observer).toHaveBeenCalledWith({
      transport: "requestUrl", status: 200, serverTiming: { authMs: 4, totalMs: 12 },
    });
  });

  it("reports the selected transport and preserves the original network failure", async () => {
    const { service } = createService();
    const error = new Error("Network disconnected");
    const observer = jest.fn(() => { throw new Error("Diagnostics unavailable"); });
    request.mockImplementation(async (input) => {
      input.onTransportSelected?.("fetch");
      throw error;
    });
    await expect(service.getCreditsBalance({ onObservation: observer })).rejects.toBe(error);
    expect(observer).toHaveBeenCalledWith({ transport: "fetch" });
  });

  it.each(["{truncated", JSON.stringify({ ...balancePayload, total_remaining: 999 })])(
    "rejects unreadable balances instead of displaying zero or an invented total (%s)", async (body) => {
      const { service } = createService();
      request.mockResolvedValue(new Response(body));
      await expect(service.getCreditsBalance()).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_RESPONSE, statusCode: 502, message: "Unable to read credits balance.",
      });
    },
  );

  it.each(["balance", "usage"] as const)("preserves a payment-required response from %s without changing local credit state", async (kind) => {
    const { service, plugin } = createService();
    request.mockResolvedValue(jsonResponse({ error: { code: "payment_required", message: "Add credits to continue." } }, { status: 402 }));
    await expect(kind === "balance" ? service.getCreditsBalance() : service.getCreditsUsage())
      .rejects.toMatchObject({ code: ERROR_CODES.INSUFFICIENT_CREDITS, statusCode: 402 });
    expect(plugin.settings).toEqual({ licenseKey: " license_for_test " });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("ignores non-string endpoint filters rather than serializing them into billing queries", async () => {
    const { service } = createService();
    request.mockResolvedValue(jsonResponse({ items: [] }));
    await service.getCreditsUsage({ endpoints: [null, 42, "/chat"] as unknown as string[] });
    expect(new URL(request.mock.calls[0][0].url).searchParams.getAll("endpoint")).toEqual(["/chat"]);
  });

  it("does not reuse a cached balance after the license is removed", async () => {
    const { service, plugin } = createService();
    request.mockResolvedValue(jsonResponse(balancePayload));
    await service.readCreditsBalance();
    plugin.settings.licenseKey = "";
    await expect(service.readCreditsBalance()).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_LICENSE, statusCode: 401, metadata: { licenseFailure: true },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("shares displayed balances, refreshes after purchases and never reuses another account's balance", async () => {
    const { service, plugin } = createService();
    request.mockImplementation(async () => jsonResponse(balancePayload));
    const listener = jest.fn();
    const unsubscribe = service.onCreditsBalance(listener);

    const first = await service.readCreditsBalance();
    expect(await service.readCreditsBalance()).toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(first);

    request.mockResolvedValueOnce(jsonResponse({ ...balancePayload, add_on_remaining: 25, total_remaining: 35 }));
    await expect(service.readCreditsBalance({ fresh: true })).resolves.toMatchObject({ totalRemaining: 35 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ totalRemaining: 35 }));

    unsubscribe();
    plugin.settings = { licenseKey: "other_account" };
    await expect(service.readCreditsBalance()).resolves.toMatchObject({ totalRemaining: 15 });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][0].headers).toMatchObject({ "x-license-key": "other_account" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
