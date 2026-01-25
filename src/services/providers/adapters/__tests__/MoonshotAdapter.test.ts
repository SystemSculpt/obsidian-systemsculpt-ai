import { MoonshotAdapter } from "../MoonshotAdapter";
import { OpenAICompatibleAdapter } from "../OpenAICompatibleAdapter";
import type { CustomProvider } from "../../../../types/llm";
import { ProviderAdapterFactory } from "../ProviderAdapterFactory";

const baseProvider: CustomProvider = {
  id: "moonshot",
  name: "Moonshot Kimi",
  endpoint: "https://api.moonshot.ai/v1",
  apiKey: "sk-test-moonshot-key",
  isEnabled: true,
};

describe("MoonshotAdapter", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates chat endpoint with /v1 suffix automatically", () => {
    const provider: CustomProvider = {
      ...baseProvider,
      endpoint: "https://api.moonshot.ai",
    };
    const adapter = new MoonshotAdapter(provider);
    expect(adapter.getChatEndpoint()).toBe("https://api.moonshot.ai/v1/chat/completions");
  });

  it("merges API models with fallback list without duplication", async () => {
    jest
      .spyOn(OpenAICompatibleAdapter.prototype, "getModels")
      .mockResolvedValue([{ id: "moonshotai/kimi-k2" } as any]);

    const adapter = new MoonshotAdapter(baseProvider);
    const models = await adapter.getModels();

    const ids = models.map((m) => m.id);
    expect(ids).toContain("moonshotai/kimi-k2");
    expect(ids).toContain("moonshotai/kimi-k2-vision");
    expect(ids.filter((id) => id === "moonshotai/kimi-k2")).toHaveLength(1);
  });

  it("returns fallback models when API list fails for non-auth reasons", async () => {
    jest
      .spyOn(OpenAICompatibleAdapter.prototype, "getModels")
      .mockRejectedValue({ status: 500 });

    const adapter = new MoonshotAdapter(baseProvider);
    const models = await adapter.getModels();

    expect(models.some((model) => model.id === "moonshotai/kimi-k2")).toBe(true);
    expect(models.some((model) => model.id === "moonshotai/kimi-k2-vision")).toBe(true);
  });

  it("parses Moonshot model listings from OpenAI-formatted responses", async () => {
    const adapter = new MoonshotAdapter(baseProvider);

    jest.spyOn<any, any>(adapter as any, "makeRequest").mockResolvedValue({
      json: {
        data: [
          { id: "moonshotai/kimi-k2", name: "Kimi K2", context_length: 200000 },
          { id: "moonshotai/kimi-k2-vision", name: "Kimi K2 Vision", context_length: 200000 },
        ],
      },
    });

    const models = await adapter.getModels();

    const kimi = models.find((model) => model.id === "moonshotai/kimi-k2");
    expect(kimi?.contextWindow).toBe(200000);
    expect(kimi?.supportsStreaming).toBe(true);
    expect(models.find((model) => model.id === "moonshotai/kimi-k2-vision")).toBeTruthy();
  });

  it("rethrows auth failures rather than silently falling back", async () => {
    const authError = { status: 401 };
    jest
      .spyOn(OpenAICompatibleAdapter.prototype, "getModels")
      .mockRejectedValue(authError);

    const adapter = new MoonshotAdapter(baseProvider);
    await expect(adapter.getModels()).rejects.toThrow("Invalid API key");
  });
});

describe("ProviderAdapterFactory Moonshot integration", () => {
  it("selects Moonshot adapter for Moonshot endpoints", () => {
    const adapter = ProviderAdapterFactory.createAdapter(baseProvider);
    expect(adapter).toBeInstanceOf(MoonshotAdapter);
  });

  it("labels Moonshot endpoints with specific provider type", () => {
    expect(ProviderAdapterFactory.getProviderType("https://api.moonshot.ai/v1")).toBe("moonshot");
  });
});
