import {
  buildManagedNamespace,
  CURRENT_MANAGED_EMBEDDING_GENERATION,
  CURRENT_MANAGED_EMBEDDING_SCHEMA_VERSION,
  isManagedNamespace,
  parseManagedNamespace,
  parseNamespaceDimension,
} from "../namespace";

describe("managed embedding namespaces", () => {
  it("builds and parses the current v3 namespace", () => {
    const namespace = buildManagedNamespace(1536);

    expect(namespace).toBe("systemsculpt:managed:semantic-v1:v3:1536");
    expect(parseManagedNamespace(namespace)).toEqual({
      generationId: CURRENT_MANAGED_EMBEDDING_GENERATION,
      indexSchemaVersion: CURRENT_MANAGED_EMBEDDING_SCHEMA_VERSION,
      dimensions: 1536,
    });
    expect(parseNamespaceDimension(namespace)).toBe(1536);
  });

  it("accepts bounded future generation and schema identities", () => {
    const namespace = buildManagedNamespace(4096, "semantic-v2.1_rc-3", 999_999);

    expect(namespace).toBe("systemsculpt:managed:semantic-v2.1_rc-3:v999999:4096");
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

  it.each([
    [1, "", 3],
    [1, "semantic-v1", 0],
    [8193, "semantic-v1", 3],
  ] as const)("refuses to build an unsafe namespace", (dimensions, generation, schema) => {
    expect(() => buildManagedNamespace(dimensions, generation, schema)).toThrow(
      "Managed embedding namespace identity is invalid.",
    );
  });
});
