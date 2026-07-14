import { DEFAULT_SETTINGS } from "../../types";
import { PostProcessingService } from "../PostProcessingService";

function plugin() {
  const generateText = jest.fn(async (operation) => {
    const messages = await operation.buildMessages();
    return {
      operationId: operation.operationId,
      requestId: "textreq_1",
      text: `  ${messages[1].content} cleaned  `,
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  });
  return {
    settings: {
      postProcessingEnabled: true,
      postProcessingPrompt: "Clean this transcript.",
    },
    getManagedCapabilityClient: jest.fn(() => ({ generateText })),
    generateText,
  } as any;
}

describe("PostProcessingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (PostProcessingService as unknown as { instance: PostProcessingService | null }).instance = null;
  });

  it("preserves raw text without consulting managed generation when disabled", async () => {
    const mock = plugin();
    mock.settings.postProcessingEnabled = false;
    const result = await PostProcessingService.getInstance(mock).processTranscription("raw");
    expect(result).toBe("raw");
    expect(mock.getManagedCapabilityClient).not.toHaveBeenCalled();
  });

  it("uses only the managed transcript purpose with a caller-owned durable operation ID", async () => {
    const mock = plugin();
    const result = await PostProcessingService.getInstance(mock).processTranscription("raw", {
      operationId: "transcription-1:postprocess",
    });
    expect(result).toBe("raw cleaned");
    expect(mock.generateText).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "transcription-1:postprocess",
      purpose: "transcript_postprocess",
    }));
    const request = mock.generateText.mock.calls[0][0];
    expect(await request.buildMessages()).toEqual([
      { role: "system", content: "Clean this transcript." },
      { role: "user", content: "raw" },
    ]);
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("provider");
  });

  it("defers prompt lookup and transcript message construction to the admitted callback", async () => {
    const mock = plugin();
    mock.generateText.mockImplementationOnce(async (operation) => {
      expect(operation.buildMessages).toEqual(expect.any(Function));
      return { operationId: operation.operationId, requestId: "r", text: "clean", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    });
    await PostProcessingService.getInstance(mock).processTranscription("secret", { operationId: "postprocess:1" });
    expect(mock.generateText).toHaveBeenCalledTimes(1);
  });

  it("uses the default cleanup prompt when the stored prompt is blank", async () => {
    const mock = plugin();
    mock.settings.postProcessingPrompt = "   ";
    await PostProcessingService.getInstance(mock).processTranscription("raw", { operationId: "postprocess:1" });
    const request = mock.generateText.mock.calls[0][0];
    const messages = await request.buildMessages();
    expect(messages[0].content).toBe(DEFAULT_SETTINGS.postProcessingPrompt);
  });

  it("preserves the raw transcript on a definitive first-party failure without fallback", async () => {
    const mock = plugin();
    mock.generateText.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await expect(PostProcessingService.getInstance(mock).processTranscription("raw", { operationId: "postprocess:1" }))
      .resolves.toBe("raw");
    expect(mock.generateText).toHaveBeenCalledTimes(1);
  });

  it("propagates local abort so no late transcription output is committed", async () => {
    const mock = plugin();
    const aborted = new Error("Stopped");
    aborted.name = "AbortError";
    mock.generateText.mockRejectedValueOnce(aborted);
    await expect(PostProcessingService.getInstance(mock).processTranscription("raw", { operationId: "postprocess:1" }))
      .rejects.toBe(aborted);
  });

  it("creates a first-party operation ID when no parent operation is available", async () => {
    const mock = plugin();
    await PostProcessingService.getInstance(mock).processTranscription("raw");
    expect(mock.generateText.mock.calls[0][0].operationId).toMatch(/^postprocess:[A-Za-z0-9]+$/);
  });
});
