import { MiniMaxAdapter } from "../MiniMaxAdapter";
import { OpenAICompatibleAdapter } from "../OpenAICompatibleAdapter";
import type { CustomProvider } from "../../../../types/llm";

const baseProvider: CustomProvider = {
  id: "minimax",
  name: "MiniMax",
  endpoint: "https://api.minimax.io/v1",
  apiKey: "test-key",
  isEnabled: true,
};

describe("MiniMaxAdapter", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns OpenAI-style chat endpoint for standard base URL", () => {
    const adapter = new MiniMaxAdapter(baseProvider);
    expect(adapter.getChatEndpoint()).toBe("https://api.minimax.io/v1/chat/completions");
  });

  it("handles text-prefixed MiniMax routes", () => {
    const provider: CustomProvider = {
      ...baseProvider,
      endpoint: "https://api.minimax.chat/v1/text",
    };
    const adapter = new MiniMaxAdapter(provider);
    expect(adapter.getChatEndpoint()).toBe("https://api.minimax.chat/v1/text/chatcompletion");
  });

  it("preserves explicit chatcompletion endpoints", () => {
    const provider: CustomProvider = {
      ...baseProvider,
      endpoint: "https://api.minimax.chat/v1/text/chatcompletion_v2",
    };
    const adapter = new MiniMaxAdapter(provider);
    expect(adapter.getChatEndpoint()).toBe("https://api.minimax.chat/v1/text/chatcompletion_v2");
  });

  it("omits tool_choice and parallel_tool_calls for tool requests", () => {
    const adapter = new MiniMaxAdapter(baseProvider);
    const body = adapter.buildRequestBody(
      [{ role: "user", content: "Hi", message_id: "1" }],
      "MiniMax-M2.1",
      [
        {
          type: "function",
          function: { name: "example", description: "Example", parameters: {} },
        },
      ]
    );

    expect(body.tools).toBeDefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  it("preserves tools payloads for MiniMax", () => {
    const adapter = new MiniMaxAdapter(baseProvider);
    const body = adapter.buildRequestBody(
      [{ role: "user", content: "Hi", message_id: "1" }],
      "MiniMax-M2.1",
      [
        {
          type: "function",
          function: {
            name: "example",
            description: "Example",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        },
      ]
    );

    expect(body.tools).toBeDefined();
    expect(body.functions).toBeUndefined();
    expect(body.function_call).toBeUndefined();
  });

  it("falls back to bundled model metadata when API listing fails", async () => {
    jest
      .spyOn(OpenAICompatibleAdapter.prototype, "getModels")
      .mockRejectedValue({ status: 404 });

    const adapter = new MiniMaxAdapter(baseProvider);
    const models = await adapter.getModels();

    expect(models.some((model) => model.id === "MiniMax-M2")).toBe(true);
    expect(models.some((model) => model.id === "MiniMax-M2.1")).toBe(true);
    expect(models.some((model) => model.id === "MiniMax-M1")).toBe(true);
    expect(models.some((model) => model.id === "MiniMax-Text-01")).toBe(true);
  });

  it("merges API models with fallback without duplication", async () => {
    jest
      .spyOn(OpenAICompatibleAdapter.prototype, "getModels")
      .mockResolvedValue([{ id: "MiniMax-M2" } as any]);

    const adapter = new MiniMaxAdapter(baseProvider);
    const models = await adapter.getModels();

    const minimaxM2Count = models.filter((model) => model.id === "MiniMax-M2").length;
    expect(minimaxM2Count).toBe(1);
    expect(models.some((model) => model.id === "MiniMax-M2.1")).toBe(true);
    expect(models.some((model) => model.id === "MiniMax-M1")).toBe(true);
  });
});
