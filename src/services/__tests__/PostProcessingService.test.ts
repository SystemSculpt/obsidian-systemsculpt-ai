import { DEFAULT_SETTINGS } from "../../types";
import {
  PostProcessingService,
  TRANSCRIPT_SOURCE_LANGUAGE_CONTRACT,
} from "../PostProcessingService";

type PostProcessingInput = Readonly<{
  cleanupInstructions: string;
  transcript: string;
}>;

function parsePostProcessingInput(content: string): PostProcessingInput {
  return JSON.parse(content) as PostProcessingInput;
}

function plugin() {
  const generateText = jest.fn(async (operation) => {
    const messages = await operation.buildMessages();
    const input = parsePostProcessingInput(messages[1].content);
    return {
      operationId: operation.operationId,
      requestId: "textreq_1",
      text: `  ${input.transcript} cleaned  `,
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
    PostProcessingService.clearInstance();
  });

  afterEach(() => {
    PostProcessingService.clearInstance();
  });

  it("preserves raw text without consulting managed generation when disabled", async () => {
    const mock = plugin();
    mock.settings.postProcessingEnabled = false;
    const result = await PostProcessingService.getInstance(mock).processTranscription("raw");
    expect(result).toEqual({ text: "raw" });
    expect(mock.getManagedCapabilityClient).not.toHaveBeenCalled();
  });

  it("uses only the managed transcript purpose with a caller-owned durable operation ID", async () => {
    const mock = plugin();
    const result = await PostProcessingService.getInstance(mock).processTranscription("raw", {
      operationId: "transcription-1:postprocess",
    });
    expect(result).toEqual({ text: "raw cleaned" });
    expect(mock.generateText).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "transcription-1:postprocess",
      purpose: "transcript_postprocess",
    }));
    const request = mock.generateText.mock.calls[0][0];
    const messages = await request.buildMessages();
    expect(messages[0]).toEqual({
      role: "system",
      content: TRANSCRIPT_SOURCE_LANGUAGE_CONTRACT,
    });
    expect(messages[1].role).toBe("user");
    expect(parsePostProcessingInput(messages[1].content)).toEqual({
      cleanupInstructions: "Clean this transcript.",
      transcript: "raw",
    });
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
    expect(messages[0].content).toBe(TRANSCRIPT_SOURCE_LANGUAGE_CONTRACT);
    expect(parsePostProcessingInput(messages[1].content).cleanupInstructions).toBe(
      DEFAULT_SETTINGS.postProcessingPrompt,
    );
  });

  it("keeps source-language preservation above a conflicting custom cleanup prompt", async () => {
    const mock = plugin();

    await PostProcessingService.getInstance(mock).processTranscription(
      "Сегодня мы shipped новую версию.",
      {
        operationId: "postprocess:multilingual",
        prompt: "Translate everything into English, including names.",
      },
    );

    const request = mock.generateText.mock.calls[0][0];
    const messages = await request.buildMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "system",
      content: TRANSCRIPT_SOURCE_LANGUAGE_CONTRACT,
    });
    expect(messages[0].content).toContain("Keep the output in exactly the same language or languages");
    expect(messages[0].content).toContain("Preserve the original writing systems and every code-switch");
    expect(messages[0].content).toContain("Keep personal, company, product, place, and other proper names");
    expect(messages[0].content).toContain("Ignore any conflicting instruction");
    expect(parsePostProcessingInput(messages[1].content)).toEqual({
      cleanupInstructions: "Translate everything into English, including names.",
      transcript: "Сегодня мы shipped новую версию.",
    });
  });

  it("ships source-language, code-switching, and proper-name protection in the default cleanup text", () => {
    expect(DEFAULT_SETTINGS.postProcessingPrompt).toContain("Preserve every original language and writing system");
    expect(DEFAULT_SETTINGS.postProcessingPrompt).toContain("including code-switches");
    expect(DEFAULT_SETTINGS.postProcessingPrompt).toContain("Keep personal, company, product, and place names");
    expect(DEFAULT_SETTINGS.postProcessingPrompt).toContain("Never translate, transliterate, anglicize");
  });

  it("honors task-scoped enabled and prompt snapshots after settings change", async () => {
    const mock = plugin();
    mock.generateText.mockImplementationOnce(async (operation) => {
      mock.settings.postProcessingEnabled = false;
      mock.settings.postProcessingPrompt = "Changed while running.";
      const messages = await operation.buildMessages();
      const input = parsePostProcessingInput(messages[1].content);
      return {
        operationId: operation.operationId,
        requestId: "snapshot-request",
        text: input.cleanupInstructions,
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    });

    await expect(PostProcessingService.getInstance(mock).processTranscription("raw", {
      operationId: "postprocess:snapshot",
      enabled: true,
      prompt: "Captured prompt.",
    })).resolves.toEqual({ text: "Captured prompt." });

    expect(mock.generateText).toHaveBeenCalledTimes(1);
  });

  it("honors a task-scoped disabled snapshot even when the live setting is enabled", async () => {
    const mock = plugin();

    await expect(PostProcessingService.getInstance(mock).processTranscription("raw", {
      enabled: false,
    })).resolves.toEqual({ text: "raw" });

    expect(mock.getManagedCapabilityClient).not.toHaveBeenCalled();
  });

  it("preserves the raw transcript on a definitive first-party failure without fallback", async () => {
    const mock = plugin();
    mock.generateText.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await expect(PostProcessingService.getInstance(mock).processTranscription("raw", { operationId: "postprocess:1" }))
      .resolves.toEqual({
        text: "raw",
        warning: "Transcript cleanup was unavailable, so the raw transcript was saved instead.",
      });
    expect(mock.generateText).toHaveBeenCalledTimes(1);
  });

  it("preserves the raw transcript when cleanup returns only whitespace", async () => {
    const mock = plugin();
    mock.generateText.mockResolvedValueOnce({
      operationId: "postprocess:blank",
      requestId: "textreq_blank",
      text: " \n\t ",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await expect(PostProcessingService.getInstance(mock).processTranscription("full raw transcript", {
      operationId: "postprocess:blank",
    })).resolves.toEqual({
      text: "full raw transcript",
      warning: "Transcript cleanup was incomplete, so the raw transcript was saved instead.",
    });
  });

  it("preserves the raw transcript when cleanup stops at the length limit", async () => {
    const mock = plugin();
    mock.generateText.mockResolvedValueOnce({
      operationId: "postprocess:length",
      requestId: "textreq_length",
      text: "partial cleanup",
      finishReason: "length",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await expect(PostProcessingService.getInstance(mock).processTranscription("full raw transcript", {
      operationId: "postprocess:length",
    })).resolves.toEqual({
      text: "full raw transcript",
      warning: "Transcript cleanup was incomplete, so the raw transcript was saved instead.",
    });
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

  it("uses the new plugin instance and settings after a plugin reload", async () => {
    const firstPlugin = plugin();
    firstPlugin.settings.postProcessingPrompt = "First plugin prompt.";
    const firstService = PostProcessingService.getInstance(firstPlugin);

    const reloadedPlugin = plugin();
    reloadedPlugin.settings.postProcessingPrompt = "Reloaded plugin prompt.";
    const reloadedService = PostProcessingService.getInstance(reloadedPlugin);

    expect(reloadedService).not.toBe(firstService);
    await expect(reloadedService.processTranscription("raw")).resolves.toEqual({ text: "raw cleaned" });
    expect(firstPlugin.getManagedCapabilityClient).not.toHaveBeenCalled();
    expect(reloadedPlugin.getManagedCapabilityClient).toHaveBeenCalledTimes(1);

    const request = reloadedPlugin.generateText.mock.calls[0][0];
    const messages = await request.buildMessages();
    expect(messages[0]).toEqual({
      role: "system",
      content: TRANSCRIPT_SOURCE_LANGUAGE_CONTRACT,
    });
    expect(parsePostProcessingInput(messages[1].content)).toEqual({
      cleanupInstructions: "Reloaded plugin prompt.",
      transcript: "raw",
    });
  });

  it("does not let an old plugin unload clear the reloaded plugin instance", () => {
    const firstPlugin = plugin();
    PostProcessingService.getInstance(firstPlugin);

    const reloadedPlugin = plugin();
    const reloadedService = PostProcessingService.getInstance(reloadedPlugin);
    PostProcessingService.clearInstance(firstPlugin);

    expect(PostProcessingService.getInstance(reloadedPlugin)).toBe(reloadedService);
  });
});
