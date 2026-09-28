import path from "node:path";
import { JSDOM } from "jsdom";
import { App, requestUrl } from "obsidian";
import fixture from "../fixtures/managed/managed-capabilities-v2.json";
import manifest from "../../manifest.json";

describe("built managed capability composition", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  beforeAll(() => Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document }));
  afterAll(() => { Reflect.deleteProperty(globalThis, "document"); dom.window.close(); });

  it("lazily reuses concrete capabilities while isolating vault state and reading the current license", async () => {
    const request = jest.mocked(requestUrl);
    request.mockReset();
    request.mockImplementation(async input => {
      const url = typeof input === "string" ? input : input.url;
      let value: unknown;
      if (url.endsWith("/config")) value = fixture;
      else if (url.endsWith("/license/validate")) {
        value = { contract_version: "admission-v1", code: "allowed", message: "License admitted.", request_id: "admission-1" };
      } else if (url.endsWith("/chat/completions")) {
        value = {
          id: "chatcmpl_1", object: "chat.completion", created: 1, model: "ai-agent",
          choices: [{ index: 0, message: { role: "assistant", content: "Generated text" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        };
      } else if (url.endsWith("/embeddings/index")) {
        value = {
          contract: "managed-embeddings-index-v1", vector_encoding: "float32-le-base64",
          generation: { id: "semantic-v1", index_schema_version: 2, index_namespace_template: "systemsculpt:managed:semantic-v1:v2:<dimensions>" },
          limits: { max_source_bytes: 8 * 1024 * 1024, max_result_bytes: 16 * 1024 * 1024 },
        };
      } else throw new Error(`Unexpected managed request: ${url}`);
      const text = JSON.stringify(value);
      return {
        status: 200,
        headers: {
          "content-type": "application/json", "x-request-id": "request-1",
          "cache-control": "no-store, max-age=0",
          "x-systemsculpt-embeddings-index-contract": "managed-embeddings-index-v1",
        },
        text, json: value, arrayBuffer: new TextEncoder().encode(text).buffer,
      };
    });

    // Exercise the shipped artifact, including its composition and host transport.
    const bundle = require(path.resolve(__dirname, "../../main.js"));
    const PluginClass = bundle.default ?? bundle;
    const first = new PluginClass(new App(), manifest);
    const second = new PluginClass(new App(), manifest);
    jest.spyOn(first, "settings", "get").mockReturnValue({ licenseKey: "vault-a" });
    jest.spyOn(second, "settings", "get").mockReturnValue({ licenseKey: "vault-b" });
    const graph = first.getManagedCapabilityGraph();
    const otherGraph = second.getManagedCapabilityGraph();
    expect(request).not.toHaveBeenCalled();
    expect(first.getManagedCapabilityGraph()).toBe(graph);

    await expect(graph.textGeneration.generate({
      operationId: "composition:text", purpose: "workflow_automation",
      buildMessages: () => [{ role: "user", content: "Source" }],
    })).resolves.toMatchObject({ text: "Generated text", operationId: "composition:text" });
    expect(await graph.embeddingsIndex.getMetadata()).toMatchObject({ generation: { id: "semantic-v1" } });
    expect(first.getManagedCapabilityGraph().embeddingsIndex.metadata).toBe(graph.embeddingsIndex.metadata);
    expect(otherGraph.embeddingsIndex.metadata).toBeUndefined();

    first.settings.licenseKey = "vault-a-new";
    await graph.embeddingsIndex.getMetadata();
    await otherGraph.embeddingsIndex.getMetadata();
    const headers = request.mock.calls.map(([input]) => typeof input === "string" ? {} : input.headers);
    expect(headers.slice(0, 4).every(value => value?.["x-license-key"] === "vault-a")).toBe(true);
    expect(headers.slice(-2).map(value => value?.["x-license-key"])).toEqual(["vault-a-new", "vault-b"]);
    expect(headers[2]).toMatchObject({ "x-systemsculpt-capability": "text_generation", "Idempotency-Key": "composition:text" });
  });
});
