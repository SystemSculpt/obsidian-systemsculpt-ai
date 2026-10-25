/** A managed index namespace as the server assigns it; the plugin only parses these. */
export function managedNamespace(dimensions: number, generationId = "semantic-v1", indexSchemaVersion = 3): string {
  return `systemsculpt:managed:${generationId}:v${indexSchemaVersion}:${dimensions}`;
}
