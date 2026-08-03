import { ManagedCapabilityClient } from "../ManagedCapabilityClient";

describe("ManagedCapabilityClient", () => {
  it("returns one stable managed embeddings index adapter", () => {
    const client = new ManagedCapabilityClient({
      admission: {} as any,
      transport: {} as any,
    });

    expect(client.getEmbeddingsIndex()).toBe(client.getEmbeddingsIndex());
  });
});
