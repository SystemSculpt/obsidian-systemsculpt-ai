import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { ManagedCapabilityClient } from "../ManagedCapabilityClient";
import { ManagedCapabilityCatalog } from "../ManagedCapabilityCatalog";

const catalog = ManagedCapabilityCatalog.parse(fixture);
const leaseFor = (alias: string, requestContract?: string) => {
  const descriptor = catalog.capabilities.find((entry) => entry.alias === alias)!;
  return { outcome: "allowed", descriptor, requestContract: descriptor.request_contracts.find((entry) => entry.capability === requestContract) } as any;
};

describe("ManagedCapabilityClient", () => {
  it("never creates or sends a payload before an allowed lease", async () => {
    const withLease = jest.fn().mockResolvedValue({ outcome: "license_required" });
    const request = jest.fn();
    const payload = jest.fn(() => ({ secret: true }));
    const client = new ManagedCapabilityClient({ admission: { withLease } as any, transport: { request } as any });
    const result = await client.request({ alias: "systemsculpt/embeddings", requestContract: "embeddings", body: payload });
    expect(result.outcome).toBe("license_required");
    expect(payload).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["request", "systemsculpt/chat", "chat_turn"],
    ["stream", "systemsculpt/embeddings", "embeddings"],
    ["job", "systemsculpt/chat", "chat_turn"],
  ] as const)("rejects %s mode mismatch before payload or transport", async (kind, alias, requestContract) => {
    const lease = leaseFor(alias, requestContract);
    const withLease = jest.fn(async (_op, callback) => callback(lease));
    const transport = { request: jest.fn(), stream: jest.fn(), job: jest.fn() };
    const payload = jest.fn(() => ({ secret: true }));
    const client = new ManagedCapabilityClient({ admission: { withLease } as any, transport: transport as any });
    const result = await client[kind]({ alias, requestContract, body: payload } as any);
    expect(result.outcome).toBe("capability_unavailable");
    expect(payload).not.toHaveBeenCalled();
    expect(transport[kind]).not.toHaveBeenCalled();
  });

  it("derives stream endpoint and method from the acquired nested lease contract", async () => {
    const lease = leaseFor("systemsculpt/chat", "chat_turn");
    const withLease = jest.fn(async (_op, callback) => callback(lease));
    const transport = { request: jest.fn(), stream: jest.fn().mockResolvedValue({ response: new Response("") }), job: jest.fn() };
    const client = new ManagedCapabilityClient({ admission: { withLease } as any, transport: transport as any });
    await client.stream({ alias: "systemsculpt/chat", requestContract: "chat_turn", body: () => ({}) });
    expect(transport.stream).toHaveBeenCalledWith(expect.objectContaining({
      path: "/api/plugin/chat/completions", method: "POST", capability: "chat_turn",
    }));
  });

  it("derives request and job endpoints/modes from their leased descriptors", async () => {
    const withLease = jest.fn(async (operation, callback) => callback(leaseFor(operation.alias, operation.requestContract)));
    const transport = { request: jest.fn().mockResolvedValue({}), stream: jest.fn(), job: jest.fn().mockResolvedValue({}) };
    const client = new ManagedCapabilityClient({ admission: { withLease } as any, transport: transport as any });
    await client.request({ alias: "systemsculpt/embeddings", requestContract: "embeddings", body: () => ({}) });
    await client.job({ alias: "systemsculpt/documents", body: () => ({}) });
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ path: "/api/plugin/embeddings", method: "POST" }));
    expect(transport.job).toHaveBeenCalledWith(expect.objectContaining({ path: "/api/plugin/documents/jobs" }));
  });

  it("rejects a nested contract that is not owned by the leased descriptor", async () => {
    const lease = { ...leaseFor("systemsculpt/embeddings", "embeddings"), requestContract: leaseFor("systemsculpt/chat", "chat_turn").requestContract };
    const withLease = jest.fn(async (_op, callback) => callback(lease));
    const transport = { request: jest.fn(), stream: jest.fn(), job: jest.fn() };
    const payload = jest.fn();
    const client = new ManagedCapabilityClient({ admission: { withLease } as any, transport: transport as any });
    expect((await client.request({ alias: "systemsculpt/embeddings", requestContract: "embeddings", body: payload })).outcome).toBe("capability_unavailable");
    expect(payload).not.toHaveBeenCalled();
  });
});
