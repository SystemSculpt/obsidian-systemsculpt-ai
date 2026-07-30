import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { PlatformRequestClient } from "../../PlatformRequestClient";
import { ManagedCapabilityClientFactory } from "../ManagedCapabilityClientFactory";

function responseFor(url: string): Response {
  if (url.endsWith("/api/plugin/config")) return new Response(JSON.stringify(fixture), { status: 200 });
  if (url.endsWith("/api/plugin/license/validate")) {
    return new Response(JSON.stringify({
      contract_version: "admission-v1",
      code: "allowed",
      message: "License admitted.",
      request_id: "request-1",
    }), { status: 200 });
  }
  throw new Error(`Unexpected URL: ${url}`);
}

describe("ManagedCapabilityClientFactory", () => {
  it("shares one graph and evaluates the live credential accessor on every admission request", async () => {
    const request = jest.spyOn(PlatformRequestClient.prototype, "request").mockImplementation(async (input) => responseFor(input.url));
    let key = "first";
    const graph = ManagedCapabilityClientFactory.createGraph({
      baseUrl: "https://api.test", pluginVersion: "1.0.0",
      licenseKey: () => key,
    });

    await expect(graph.client.getAdmission()).resolves.toMatchObject({
      outcome: "allowed",
    });
    expect(request.mock.calls.some(([input]) => input.licenseKey === "first")).toBe(true);
    await expect(graph.client.getCatalog()).resolves.toMatchObject({
      contract_version: "managed-capabilities-v2",
      capabilities: expect.any(Array),
    });

    key = "second";
    await expect(graph.client.getAdmission()).resolves.toMatchObject({
      outcome: "allowed",
    });
    expect(request.mock.calls.some(([input]) => input.licenseKey === "second")).toBe(true);
    expect(Object.isFrozen(graph)).toBe(true);
    request.mockRestore();
  });
});
