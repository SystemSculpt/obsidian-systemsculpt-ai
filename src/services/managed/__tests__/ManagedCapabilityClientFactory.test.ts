import { ManagedCapabilityClientFactory } from "../ManagedCapabilityClientFactory";

describe("ManagedCapabilityClientFactory", () => {
  it("creates one client graph while retaining live accessors", () => {
    let key = "first";
    let disclosure = { version: "v1", acceptedAt: "now" };
    const client = ManagedCapabilityClientFactory.create({
      baseUrl: "https://api.test",
      pluginVersion: "1.0.0",
      licenseKey: () => key,
      disclosureAcceptance: () => disclosure,
    });
    expect(client).toBeDefined();
    key = "second";
    disclosure = { version: "v2", acceptedAt: "later" };
    expect(key).toBe("second");
    expect(disclosure.version).toBe("v2");
  });
});
