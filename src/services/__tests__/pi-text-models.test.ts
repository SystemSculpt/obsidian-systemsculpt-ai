import {
  buildLocalPiCanonicalModelId,
  buildLocalPiExecutionModelId,
  collectSharedPiProviderHints,
  resolveLocalPiExecutionModelIdFromCanonical,
  toLocalPiSystemSculptModel,
} from "../pi/PiTextModels";

describe("PiTextModels", () => {
  it("creates collision-safe Local Pi canonical IDs", () => {
    const canonicalId = buildLocalPiCanonicalModelId("openai", "gpt-4.1");

    expect(canonicalId).toBe("local-pi-openai@@gpt-4.1");
    expect(buildLocalPiExecutionModelId("openai", "gpt-4.1")).toBe("openai/gpt-4.1");
    expect(resolveLocalPiExecutionModelIdFromCanonical(canonicalId)).toBe("openai/gpt-4.1");
  });

  it("keeps nested provider/model execution IDs intact", () => {
    const canonicalId = buildLocalPiCanonicalModelId("openrouter", "openai/gpt-4.1");
    expect(canonicalId).toBe("local-pi-openrouter@@openai/gpt-4.1");
    expect(resolveLocalPiExecutionModelIdFromCanonical(canonicalId)).toBe("openrouter/openai/gpt-4.1");
  });

  it("collects default Pi provider hints and mapped custom endpoints", () => {
    const hints = collectSharedPiProviderHints([
      {
        id: "openai-fallback",
        name: "OpenAI fallback",
        endpoint: "https://api.openai.com/v1",
        apiKey: "",
        isEnabled: true,
      },
      {
        id: "custom-unknown",
        name: "Unknown",
        endpoint: "https://example.com/v1",
        apiKey: "",
        isEnabled: true,
      },
    ]);

    expect(hints).toContain("openai");
    expect(hints).toContain("anthropic");
    expect(hints).toContain("openrouter");
    expect(hints).toContain("ollama");
    expect(hints).toContain("lmstudio");
  });

  it("converts Pi listings into unified text models", () => {
    const model = toLocalPiSystemSculptModel({
      providerId: "openai",
      modelId: "gpt-4.1",
      label: "gpt-4.1",
      description: "context 1.0M • max out 32.8K • thinking no • images yes",
      contextLength: 1_000_000,
      maxOutputTokens: 32_800,
      supportsReasoning: false,
      supportsImages: true,
      keywords: ["openai/gpt-4.1"],
    });

    expect(model).toMatchObject({
      id: "local-pi-openai@@gpt-4.1",
      provider: "openai",
      sourceMode: "pi_local",
      sourceProviderId: "openai",
      context_length: 1_000_000,
    });
    expect(model.supported_parameters).toEqual(["tools"]);
  });
});
