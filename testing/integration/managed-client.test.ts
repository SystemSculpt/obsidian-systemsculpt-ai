import fixture from "../fixtures/managed/managed-capabilities-v2.json";
import { ManagedCapabilityCatalog } from "../../src/services/managed/ManagedCapabilityCatalog";
import { ManagedCapabilityClient } from "../../src/services/managed/ManagedCapabilityClient";

describe("managed capability client built-bundle foundation", () => {
  it("loads the canonical contract through bundle-safe modules", () => {
    const catalog = ManagedCapabilityCatalog.parse(fixture);
    expect(catalog.contract_version).toBe("managed-capabilities-v2");
    expect(catalog.capabilities).toHaveLength(5);
    expect(typeof ManagedCapabilityClient).toBe("function");
  });

  it("contains no eager Node builtin imports in the managed foundation", () => {
    const sources = [ManagedCapabilityCatalog.toString(), ManagedCapabilityClient.toString()].join("\n");
    expect(sources).not.toMatch(/node:|require\(["'](?:fs|path|crypto)["']\)/);
  });
});
