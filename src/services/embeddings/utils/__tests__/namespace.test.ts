import {
  isManagedNamespace,
  parseManagedNamespace,
  parseNamespaceDimension,
} from "../namespace";

describe("managed embedding namespaces", () => {
  it("parses the current v3 namespace", () => {
    const namespace = "systemsculpt:managed:semantic-v1:v3:1536";

    expect(parseManagedNamespace(namespace)).toEqual({
      generationId: "semantic-v1",
      indexSchemaVersion: 3,
      dimensions: 1536,
    });
    expect(parseNamespaceDimension(namespace)).toBe(1536);
  });

  it("accepts bounded future generation and schema identities", () => {
    const namespace = "systemsculpt:managed:semantic-v2.1_rc-3:v999999:4096";

    expect(isManagedNamespace(namespace)).toBe(true);
    expect(parseManagedNamespace(namespace)).toEqual({
      generationId: "semantic-v2.1_rc-3",
      indexSchemaVersion: 999_999,
      dimensions: 4096,
    });
  });

  it.each([
    "systemsculpt:managed::v3:1536",
    `systemsculpt:managed:${"a".repeat(65)}:v3:1536`,
    "systemsculpt:managed:semantic/v2:v3:1536",
    "systemsculpt:managed:semantic-v1:v0:1536",
    "systemsculpt:managed:semantic-v1:v1000001:1536",
    "systemsculpt:managed:semantic-v1:v3:0",
    "systemsculpt:managed:semantic-v1:v3:8193",
    "systemsculpt:managed:semantic-v1:v03:1536",
    "systemsculpt:managed:semantic-v1:v3:01536",
    "systemsculpt:managed:semantic-v1:v3:1536:extra",
  ])("rejects malformed or oversized identity %s", (namespace) => {
    expect(isManagedNamespace(namespace)).toBe(false);
    expect(parseManagedNamespace(namespace)).toBeNull();
    expect(parseNamespaceDimension(namespace)).toBeNull();
  });
});
