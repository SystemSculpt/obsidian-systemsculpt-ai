import { TFile } from "obsidian";
import { TitleGenerationService } from "../TitleGenerationService";
import { SystemSculptService } from "../SystemSculptService";
import type { ChatMessage } from "../../types";

const createPlugin = () => {
  const app: any = {
    vault: {
      read: jest.fn(async () => "Note body"),
      getAbstractFileByPath: jest.fn(),
    },
  };
  const plugin: any = {
    app,
    settings: {
      selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      settingsMode: "advanced",
      useLatestModelEverywhere: true,
      titleGenerationPromptType: "precise",
      titleGenerationPrompt: "",
      titleGenerationPromptPath: "",
      titleGenerationModelId: "",
      titleGenerationProviderId: "",
    },
    modelService: {
      validateSpecificModel: jest.fn(async () => ({ isAvailable: true })),
    },
    getSettingsManager: () => ({
      updateSettings: jest.fn(async () => {}),
    }),
  };
  return { app, plugin };
};

describe("TitleGenerationService", () => {
  let streamMessage: jest.Mock;
  let setTimeoutSpy: jest.SpyInstance;
  let clearTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    setTimeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation(() => 0 as any);
    clearTimeoutSpy = jest.spyOn(global, "clearTimeout").mockImplementation(() => {});
    streamMessage = jest.fn();
    jest.spyOn(SystemSculptService, "getInstance").mockReturnValue({
      streamMessage,
    } as any);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    jest.restoreAllMocks();
    (TitleGenerationService as any).instance = null;
  });

  it("streams a title for chat messages", async () => {
    const { plugin } = createPlugin();
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello", message_id: "1" },
      { role: "assistant", content: "Hi there", message_id: "2" },
    ];

    streamMessage.mockImplementation(() =>
      (async function* () {
        yield { type: "content", text: "My Title" };
      })()
    );

    const service = TitleGenerationService.getInstance(plugin);
    const title = await service.generateTitle(messages);

    expect(streamMessage).toHaveBeenCalled();
    expect(title).toBe("My Title");
  });

  it("uses movie-style prompt for notes", async () => {
    const { plugin, app } = createPlugin();
    plugin.settings.titleGenerationPromptType = "movie-style";
    const file = new TFile({ path: "Note.md" });

    let capturedMessages: any[] = [];
    streamMessage.mockImplementation((params: any) => {
      capturedMessages = params.messages;
      return (async function* () {
        yield { type: "content", text: "Cinematic Title" };
      })();
    });

    const service = TitleGenerationService.getInstance(plugin);
    const title = await service.generateTitle(file);

    expect(app.vault.read).toHaveBeenCalled();
    expect(title).toBe("Cinematic Title");
    expect(capturedMessages[0]?.content).toContain("movie-style");
    expect(capturedMessages[0]?.content).toContain("note");
  });

  it("uses custom prompt string when provided", async () => {
    const { plugin } = createPlugin();
    plugin.settings.titleGenerationPrompt = "Custom prompt for conversation titles.";

    let capturedMessages: any[] = [];
    streamMessage.mockImplementation((params: any) => {
      capturedMessages = params.messages;
      return (async function* () {
        yield { type: "content", text: "Custom Title" };
      })();
    });

    const service = TitleGenerationService.getInstance(plugin);
    const title = await service.generateTitle([
      { role: "user", content: "Hello", message_id: "1" },
    ]);

    expect(title).toBe("Custom Title");
    expect(capturedMessages[0]?.content).toBe("Custom prompt for conversation titles.");
  });

  it("returns Untitled Chat when generated title is empty", async () => {
    const { plugin } = createPlugin();
    streamMessage.mockImplementation(() =>
      (async function* () {
        yield { type: "content", text: "   " };
      })()
    );

    const service = TitleGenerationService.getInstance(plugin);
    const title = await service.generateTitle([
      { role: "user", content: "Hello", message_id: "1" },
    ]);

    expect(title).toBe("Untitled Chat");
  });

  it("throws when no chat messages are provided", async () => {
    const { plugin } = createPlugin();
    streamMessage.mockImplementation(() =>
      (async function* () {
        yield { type: "content", text: "Title" };
      })()
    );

    const service = TitleGenerationService.getInstance(plugin);
    await expect(service.generateTitle([])).rejects.toThrow("No chat messages");
  });

  describe("sanitizeTitle", () => {
    it("sanitizes title using titleUtils", () => {
      const { plugin } = createPlugin();
      const service = TitleGenerationService.getInstance(plugin);

      // Test basic sanitization
      const result = service.sanitizeTitle("Test Title");
      expect(result).toBe("Test Title");
    });

    it("removes invalid filename characters", () => {
      const { plugin } = createPlugin();
      const service = TitleGenerationService.getInstance(plugin);

      const result = service.sanitizeTitle('Title: With / Invalid \\ Chars * ? " < > |');
      expect(result).not.toContain(":");
      expect(result).not.toContain("/");
      expect(result).not.toContain("\\");
    });
  });

  describe("singleton pattern", () => {
    it("returns same instance", () => {
      const { plugin } = createPlugin();
      const service1 = TitleGenerationService.getInstance(plugin);
      const service2 = TitleGenerationService.getInstance(plugin);

      expect(service1).toBe(service2);
    });
  });

  describe("model selection", () => {
    it("uses titleGenerationModelId when already canonical", async () => {
      const { plugin } = createPlugin();
      plugin.settings.useLatestModelEverywhere = false;
      plugin.settings.titleGenerationModelId = "openai@@gpt-4";
      plugin.settings.titleGenerationProviderId = "";

      streamMessage.mockImplementation((params: any) => {
        expect(params.model).toBe("openai@@gpt-4");
        return (async function* () {
          yield { type: "content", text: "Title" };
        })();
      });

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle([{ role: "user", content: "Hello", message_id: "1" }]);
    });

    it("constructs canonical ID from provider and model", async () => {
      const { plugin } = createPlugin();
      plugin.settings.useLatestModelEverywhere = false;
      plugin.settings.titleGenerationModelId = "gpt-4";
      plugin.settings.titleGenerationProviderId = "openai";

      streamMessage.mockImplementation((params: any) => {
        expect(params.model).toBe("openai@@gpt-4");
        return (async function* () {
          yield { type: "content", text: "Title" };
        })();
      });

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle([{ role: "user", content: "Hello", message_id: "1" }]);
    });

    it("uses fallback model when validation fails", async () => {
      const { plugin } = createPlugin();
      plugin.modelService.validateSpecificModel = jest.fn(async () => ({
        isAvailable: false,
        alternativeModel: { id: "openai@@gpt-3.5-turbo" },
      }));

      streamMessage.mockImplementation((params: any) => {
        expect(params.model).toBe("openai@@gpt-3.5-turbo");
        return (async function* () {
          yield { type: "content", text: "Title" };
        })();
      });

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle([{ role: "user", content: "Hello", message_id: "1" }]);
    });

    it("throws when no model is determined", async () => {
      const { plugin } = createPlugin();
      plugin.settings.selectedModelId = "";
      plugin.settings.titleGenerationModelId = "";
      plugin.settings.useLatestModelEverywhere = true;

      const service = TitleGenerationService.getInstance(plugin);
      await expect(
        service.generateTitle([{ role: "user", content: "Hello", message_id: "1" }])
      ).rejects.toThrow("Failed to determine a valid model");
    });
  });

  describe("custom prompt from file", () => {
    it("loads custom prompt from file path", async () => {
      const { plugin, app } = createPlugin();
      plugin.settings.titleGenerationPromptType = "custom";
      plugin.settings.titleGenerationPromptPath = "prompts/custom.md";

      const mockFile = new TFile({ path: "prompts/custom.md" });
      app.vault.getAbstractFileByPath = jest.fn().mockReturnValue(mockFile);
      app.vault.read = jest.fn(async () => "Custom file prompt for conversation");

      let capturedMessages: any[] = [];
      streamMessage.mockImplementation((params: any) => {
        capturedMessages = params.messages;
        return (async function* () {
          yield { type: "content", text: "Title" };
        })();
      });

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle([{ role: "user", content: "Hello", message_id: "1" }]);

      expect(capturedMessages[0]?.content).toBe("Custom file prompt for conversation");
    });

    it("falls back to default when custom file not found", async () => {
      const { plugin, app } = createPlugin();
      plugin.settings.titleGenerationPromptType = "custom";
      plugin.settings.titleGenerationPromptPath = "prompts/missing.md";

      app.vault.getAbstractFileByPath = jest.fn().mockReturnValue(null);

      streamMessage.mockImplementation(() =>
        (async function* () {
          yield { type: "content", text: "Title" };
        })()
      );

      const service = TitleGenerationService.getInstance(plugin);
      const title = await service.generateTitle([
        { role: "user", content: "Hello", message_id: "1" },
      ]);

      expect(title).toBe("Title");
    });
  });

  describe("progress callbacks", () => {
    it("calls onProgress with streaming title", async () => {
      const { plugin } = createPlugin();
      const onProgress = jest.fn();

      streamMessage.mockImplementation(() =>
        (async function* () {
          yield { type: "content", text: "My " };
          yield { type: "content", text: "Title" };
        })()
      );

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle(
        [{ role: "user", content: "Hello", message_id: "1" }],
        onProgress
      );

      expect(onProgress).toHaveBeenCalledWith("My");
      expect(onProgress).toHaveBeenCalledWith("My Title");
    });

    it("calls onStatusUpdate at different stages", async () => {
      const { plugin } = createPlugin();
      const onStatusUpdate = jest.fn();

      streamMessage.mockImplementation(() =>
        (async function* () {
          yield { type: "content", text: "Title" };
        })()
      );

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle(
        [{ role: "user", content: "Hello", message_id: "1" }],
        undefined,
        onStatusUpdate
      );

      expect(onStatusUpdate).toHaveBeenCalledWith(20, expect.any(String));
      expect(onStatusUpdate).toHaveBeenCalledWith(40, expect.any(String));
      expect(onStatusUpdate).toHaveBeenCalledWith(60, expect.any(String));
      expect(onStatusUpdate).toHaveBeenCalledWith(80, expect.any(String));
    });
  });

  describe("additional context", () => {
    it("includes additional context in prompt for chat", async () => {
      const { plugin } = createPlugin();

      let capturedMessages: any[] = [];
      streamMessage.mockImplementation((params: any) => {
        capturedMessages = params.messages;
        return (async function* () {
          yield { type: "content", text: "Title" };
        })();
      });

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle(
        [{ role: "user", content: "Hello", message_id: "1" }],
        undefined,
        undefined,
        "Extra context for title"
      );

      expect(capturedMessages[1]?.content).toContain("Extra context for title");
      expect(capturedMessages[1]?.content).toContain("user_provided_context");
    });

    it("includes additional context in prompt for notes", async () => {
      const { plugin, app } = createPlugin();
      const file = new TFile({ path: "Note.md" });

      let capturedMessages: any[] = [];
      streamMessage.mockImplementation((params: any) => {
        capturedMessages = params.messages;
        return (async function* () {
          yield { type: "content", text: "Title" };
        })();
      });

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle(file, undefined, undefined, "Note context");

      expect(capturedMessages[1]?.content).toContain("Note context");
    });
  });

  describe("multipart content handling", () => {
    it("handles array content in messages", async () => {
      const { plugin } = createPlugin();

      let capturedMessages: any[] = [];
      streamMessage.mockImplementation((params: any) => {
        capturedMessages = params.messages;
        return (async function* () {
          yield { type: "content", text: "Title" };
        })();
      });

      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "First text" },
            { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
            { type: "text", text: "Second text" },
          ] as any,
          message_id: "1",
        },
      ];

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle(messages);

      // The multipart content should be extracted to just text
      expect(capturedMessages[1]?.content).toContain("First text");
      expect(capturedMessages[1]?.content).toContain("Second text");
    });
  });

  describe("standard mode", () => {
    it("uses global model in standard mode", async () => {
      const { plugin } = createPlugin();
      plugin.settings.settingsMode = "standard";
      plugin.settings.titleGenerationModelId = "custom-model";

      streamMessage.mockImplementation((params: any) => {
        // Should use global model, not the custom one
        expect(params.model).not.toBe("custom-model");
        return (async function* () {
          yield { type: "content", text: "Title" };
        })();
      });

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle([{ role: "user", content: "Hello", message_id: "1" }]);
    });
  });

  describe("message limits", () => {
    it("uses first 25 messages for context", async () => {
      const { plugin } = createPlugin();

      let capturedMessages: any[] = [];
      streamMessage.mockImplementation((params: any) => {
        capturedMessages = params.messages;
        return (async function* () {
          yield { type: "content", text: "Title" };
        })();
      });

      // Create 30 messages
      const messages: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Message ${i + 1}`,
        message_id: String(i),
      }));

      const service = TitleGenerationService.getInstance(plugin);
      await service.generateTitle(messages);

      // Should contain message 1 but not message 30
      expect(capturedMessages[1]?.content).toContain("Message 1");
      expect(capturedMessages[1]?.content).not.toContain("Message 30");
    });
  });
});
