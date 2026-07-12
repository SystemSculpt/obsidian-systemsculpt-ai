import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { ManagedAdmission } from "../ManagedAdmission";
import { ManagedCapabilityCatalog } from "../ManagedCapabilityCatalog";

const catalog = ManagedCapabilityCatalog.parse(fixture);

describe("ManagedAdmission", () => {
  let now = 1_000_000;
  const getCatalog = jest.fn();
  const getAdmission = jest.fn();
  const licenseKey = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    now = 1_000_000;
    getCatalog.mockResolvedValue(catalog);
    getAdmission.mockResolvedValue({ outcome: "allowed", diagnostics: { status: 200 } });
    licenseKey.mockReturnValue("license");
  });

  const create = () => new ManagedAdmission({ transport: { getCatalog, getAdmission } as any, licenseKey, now: () => now });

  it.each(["allowed", "license_required", "license_rejected", "temporarily_unavailable", "rate_limited"] as const)(
    "preserves server outcome %s", async (outcome) => {
      getAdmission.mockResolvedValue({ outcome, diagnostics: { status: 200 } });
      expect((await create().acquireLease({ alias: "systemsculpt/chat", requestContract: "chat_turn" })).outcome).toBe(outcome);
    },
  );

  it.each([null, "disclosure-compatibility-metadata"]) (
    "treats disclosure metadata %p as non-authoritative and keeps payload creation lazy",
    async (disclosureVersion) => {
    const payload = jest.fn();
    const compatible = structuredClone(fixture) as any;
    compatible.disclosure_version = disclosureVersion;
    getCatalog.mockResolvedValue(ManagedCapabilityCatalog.parse(compatible));
    const admission = create();
    const first = await admission.withLease({ alias: "systemsculpt/chat", requestContract: "chat_turn" }, payload);
    expect(first).toBeUndefined();
    expect(payload).toHaveBeenCalledTimes(1);

    const unavailable = structuredClone(fixture) as any;
    unavailable.capabilities[0].availability = "unavailable";
    getCatalog.mockResolvedValue(ManagedCapabilityCatalog.parse(unavailable));
    const second = await create().withLease({ alias: "systemsculpt/chat" }, payload);
    expect(second.outcome).toBe("capability_unavailable");
    expect(payload).toHaveBeenCalledTimes(1);
  });

  it("uses one deterministic cache entry, expiring at the exact boundary", async () => {
    const admission = create();
    await admission.acquireLease({ alias: "systemsculpt/chat" });
    now += 299_999;
    await admission.acquireLease({ alias: "systemsculpt/chat" });
    expect(getCatalog).toHaveBeenCalledTimes(1);
    now += 1;
    await admission.acquireLease({ alias: "systemsculpt/chat" });
    expect(getCatalog).toHaveBeenCalledTimes(2);
  });

  it("invalidates synchronously for license changes", async () => {
    const admission = create();
    await admission.acquireLease({ alias: "systemsculpt/chat" });
    licenseKey.mockReturnValue("other");
    await admission.acquireLease({ alias: "systemsculpt/chat" });
    expect(getCatalog).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, false, "300", {}, [], 0, -1, 1, 299, 301, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])(
    "returns temporarily_unavailable and never caches cache TTL drift %p",
    async (cacheTTL) => {
      const drifted = { ...catalog, cache_ttl_seconds: cacheTTL } as any;
      if (typeof cacheTTL === "undefined") delete drifted.cache_ttl_seconds;
      getCatalog.mockResolvedValue(drifted);
      const admission = create();
      expect((await admission.acquireLease({ alias: "systemsculpt/chat" })).outcome).toBe("temporarily_unavailable");
      expect((await admission.acquireLease({ alias: "systemsculpt/chat" })).outcome).toBe("temporarily_unavailable");
      expect(getCatalog).toHaveBeenCalledTimes(2);
      expect(getAdmission).not.toHaveBeenCalled();
    },
  );

  it("discards a stale pending catalog, refetches once, and never uses the old catalog", async () => {
    let resolveFirst!: (value: typeof catalog) => void;
    let resolveSecond!: (value: typeof catalog) => void;
    getCatalog
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    const stale = structuredClone(catalog);
    stale.capabilities[0].availability = "unavailable";
    const admission = create();
    const pending = admission.acquireLease({ alias: "systemsculpt/chat", requestContract: "chat_turn" });
    licenseKey.mockReturnValue("mutated-during-fetch");
    resolveFirst(stale);
    await Promise.resolve();
    await Promise.resolve();
    expect(getCatalog).toHaveBeenCalledTimes(2);
    resolveSecond(catalog);
    expect((await pending).outcome).toBe("allowed");
    expect(getCatalog).toHaveBeenCalledTimes(2);
  });

  it("returns temporarily_unavailable when snapshots mutate during the one allowed refetch", async () => {
    let resolveFirst!: (value: typeof catalog) => void;
    let resolveSecond!: (value: typeof catalog) => void;
    getCatalog
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    const admission = create();
    const pending = admission.acquireLease({ alias: "systemsculpt/chat", requestContract: "chat_turn" });
    licenseKey.mockReturnValue("first-mutation");
    resolveFirst(catalog);
    await Promise.resolve();
    await Promise.resolve();
    expect(getCatalog).toHaveBeenCalledTimes(2);
    licenseKey.mockReturnValue("second-mutation");
    resolveSecond(catalog);
    expect((await pending).outcome).toBe("temporarily_unavailable");
    expect(getCatalog).toHaveBeenCalledTimes(2);
    expect(getAdmission).not.toHaveBeenCalled();
  });

  it("returns temporarily_unavailable after expiry when config refresh fails", async () => {
    const admission = create();
    await admission.acquireLease({ alias: "systemsculpt/chat" });
    now += 300_000;
    getCatalog.mockRejectedValue(new Error("offline"));
    expect((await admission.acquireLease({ alias: "systemsculpt/chat" })).outcome).toBe("temporarily_unavailable");
  });
});
