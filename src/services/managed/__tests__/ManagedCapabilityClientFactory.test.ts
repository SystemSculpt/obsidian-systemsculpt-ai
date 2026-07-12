import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { PlatformRequestClient } from "../../PlatformRequestClient";
import { ManagedCapabilityClientFactory } from "../ManagedCapabilityClientFactory";

function responseFor(url: string): Response {
  if (url.endsWith("/api/plugin/config")) return new Response(JSON.stringify(fixture), { status: 200 });
  if (url.endsWith("/api/plugin/license/validate")) return new Response(JSON.stringify({ code: "allowed" }), { status: 200 });
  throw new Error(`Unexpected URL: ${url}`);
}

describe("ManagedCapabilityClientFactory", () => {
  it("shares one graph and evaluates the live credential accessor on every invalidated admission", async () => {
    const request = jest.spyOn(PlatformRequestClient.prototype, "request").mockImplementation(async (input) => responseFor(input.url));
    let key = "first";
    const graph = ManagedCapabilityClientFactory.createGraph({
      baseUrl: "https://api.test", pluginVersion: "1.0.0",
      licenseKey: () => key,
    });
    const acquire = jest.spyOn(graph.admission, "acquireLease");

    const first = await graph.client.acquireChatTurnLease();
    expect(first.outcome).toBe("allowed");
    expect(acquire).toHaveBeenCalledTimes(1);
    const admitted = await acquire.mock.results[0].value;
    if (first.outcome !== "allowed") throw new Error("Expected allowed fixture lease");
    expect(first.lease).toBe(admitted);
    expect(Object.isFrozen(first.lease)).toBe(true);
    expect(Object.isFrozen(first.lease.descriptor)).toBe(true);
    expect(Object.isFrozen(first.lease.requestContract)).toBe(true);
    expect(() => { Object.defineProperty(first.lease.requestContract, "capability", { value: "embeddings" }); }).toThrow();
    expect(first.lease.descriptor.request_contracts).toContain(first.lease.requestContract);
    expect(request.mock.calls.some(([input]) => input.licenseKey === "first")).toBe(true);

    key = "second";
    const second = await graph.client.acquireChatTurnLease();
    expect(second.outcome).toBe("allowed");
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.some(([input]) => input.licenseKey === "second")).toBe(true);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(acquire.mock.instances.every((owner) => owner === graph.admission)).toBe(true);
    request.mockRestore();
  });
});
