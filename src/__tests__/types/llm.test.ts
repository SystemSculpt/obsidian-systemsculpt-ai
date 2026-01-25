/**
 * @jest-environment node
 */
import {
  DEFAULT_FILTER_SETTINGS,
  type ModelFilterSettings,
  type ModelIdentifier,
  type SystemSculptModel,
  type CustomProvider,
  type ActiveProvider,
  type ModelArchitecture,
  type ModelPricing,
  type TopProvider,
} from "../../types/llm";

describe("DEFAULT_FILTER_SETTINGS", () => {
  it("has showVisionModels set to false", () => {
    expect(DEFAULT_FILTER_SETTINGS.showVisionModels).toBe(false);
  });

  it("has showReasoningModels set to false", () => {
    expect(DEFAULT_FILTER_SETTINGS.showReasoningModels).toBe(false);
  });

  it("has showCreativeModels set to false", () => {
    expect(DEFAULT_FILTER_SETTINGS.showCreativeModels).toBe(false);
  });

  it("is a valid ModelFilterSettings object", () => {
    const settings: ModelFilterSettings = DEFAULT_FILTER_SETTINGS;
    expect(settings).toBeDefined();
    expect(typeof settings.showVisionModels).toBe("boolean");
    expect(typeof settings.showReasoningModels).toBe("boolean");
    expect(typeof settings.showCreativeModels).toBe("boolean");
  });
});

describe("ModelIdentifier type", () => {
  it("can create a basic identifier", () => {
    const id: ModelIdentifier = {
      providerId: "openrouter",
      modelId: "gpt-4",
    };

    expect(id.providerId).toBe("openrouter");
    expect(id.modelId).toBe("gpt-4");
    expect(id.displayName).toBeUndefined();
  });

  it("can create an identifier with display name", () => {
    const id: ModelIdentifier = {
      providerId: "systemsculpt",
      modelId: "custom-model",
      displayName: "My Custom Model",
    };

    expect(id.displayName).toBe("My Custom Model");
  });
});

describe("ModelArchitecture type", () => {
  it("can create with all fields", () => {
    const arch: ModelArchitecture = {
      modality: "text",
      tokenizer: "cl100k_base",
      instruct_type: "chat",
    };

    expect(arch.modality).toBe("text");
    expect(arch.tokenizer).toBe("cl100k_base");
    expect(arch.instruct_type).toBe("chat");
  });

  it("can have null instruct_type", () => {
    const arch: ModelArchitecture = {
      modality: "text->text",
      tokenizer: "gpt2",
      instruct_type: null,
    };

    expect(arch.instruct_type).toBeNull();
  });
});

describe("ModelPricing type", () => {
  it("can create pricing info", () => {
    const pricing: ModelPricing = {
      prompt: "0.03",
      completion: "0.06",
      image: "0.00",
      request: "0.00",
    };

    expect(pricing.prompt).toBe("0.03");
    expect(pricing.completion).toBe("0.06");
    expect(pricing.image).toBe("0.00");
    expect(pricing.request).toBe("0.00");
  });
});

describe("TopProvider type", () => {
  it("can create provider info", () => {
    const provider: TopProvider = {
      context_length: 128000,
      max_completion_tokens: 4096,
      is_moderated: false,
    };

    expect(provider.context_length).toBe(128000);
    expect(provider.max_completion_tokens).toBe(4096);
    expect(provider.is_moderated).toBe(false);
  });

  it("can have null max_completion_tokens", () => {
    const provider: TopProvider = {
      context_length: 8192,
      max_completion_tokens: null,
      is_moderated: true,
    };

    expect(provider.max_completion_tokens).toBeNull();
  });
});

describe("SystemSculptModel type", () => {
  it("can create a full model definition", () => {
    const model: SystemSculptModel = {
      identifier: {
        providerId: "openrouter",
        modelId: "gpt-4",
      },
      id: "openrouter@@gpt-4",
      name: "GPT-4",
      description: "OpenAI's most capable model",
      context_length: 128000,
      capabilities: ["text", "code", "reasoning"],
      architecture: {
        modality: "text->text",
        tokenizer: "cl100k_base",
      },
      pricing: {
        prompt: "0.03",
        completion: "0.06",
        image: "0.00",
        request: "0.00",
      },
      provider: "openai",
    };

    expect(model.id).toBe("openrouter@@gpt-4");
    expect(model.name).toBe("GPT-4");
    expect(model.context_length).toBe(128000);
    expect(model.capabilities).toContain("text");
    expect(model.isFavorite).toBeUndefined();
  });

  it("can have optional fields", () => {
    const model: SystemSculptModel = {
      identifier: {
        providerId: "systemsculpt",
        modelId: "custom",
      },
      id: "systemsculpt@@custom",
      name: "Custom Model",
      description: "A custom model",
      context_length: 4096,
      capabilities: ["text"],
      supported_parameters: ["tools", "functions"],
      upstream_model: "openrouter/openai/gpt-4",
      architecture: {
        modality: "text",
        instruct_type: "chat",
      },
      pricing: {
        prompt: "0.01",
        completion: "0.02",
        image: "0.00",
        request: "0.00",
      },
      provider: "systemsculpt",
      top_provider: {
        context_length: 4096,
        max_completion_tokens: 2048,
        is_moderated: false,
      },
      isFavorite: true,
    };

    expect(model.supported_parameters).toContain("tools");
    expect(model.upstream_model).toBe("openrouter/openai/gpt-4");
    expect(model.top_provider?.context_length).toBe(4096);
    expect(model.isFavorite).toBe(true);
  });
});

describe("CustomProvider type", () => {
  it("can create a basic custom provider", () => {
    const provider: CustomProvider = {
      id: "my-ollama",
      name: "My Ollama",
      endpoint: "http://localhost:11434/v1",
      apiKey: "",
      isEnabled: true,
    };

    expect(provider.id).toBe("my-ollama");
    expect(provider.name).toBe("My Ollama");
    expect(provider.endpoint).toBe("http://localhost:11434/v1");
    expect(provider.isEnabled).toBe(true);
    expect(provider.lastTested).toBeUndefined();
  });

  it("can have all optional fields", () => {
    const now = Date.now();
    const provider: CustomProvider = {
      id: "custom-1",
      name: "Custom Provider",
      endpoint: "https://api.example.com",
      apiKey: "sk-xxx",
      isEnabled: false,
      lastTested: now,
      cachedModels: ["model-a", "model-b"],
      failureCount: 2,
      lastFailureTime: now - 60000,
      lastHealthyAt: now - 120000,
      lastHealthyConfigHash: "abc123",
    };

    expect(provider.lastTested).toBe(now);
    expect(provider.cachedModels).toContain("model-a");
    expect(provider.failureCount).toBe(2);
    expect(provider.lastFailureTime).toBeLessThan(now);
    expect(provider.lastHealthyAt).toBeLessThan(provider.lastFailureTime!);
    expect(provider.lastHealthyConfigHash).toBe("abc123");
  });
});

describe("ActiveProvider type", () => {
  it("can create a native provider", () => {
    const provider: ActiveProvider = {
      id: "systemsculpt",
      name: "SystemSculpt",
      type: "native",
    };

    expect(provider.id).toBe("systemsculpt");
    expect(provider.type).toBe("native");
  });

  it("can create a custom provider", () => {
    const provider: ActiveProvider = {
      id: "ollama-local",
      name: "Ollama",
      type: "custom",
    };

    expect(provider.type).toBe("custom");
  });
});

describe("ModelFilterSettings type", () => {
  it("can create settings with all enabled", () => {
    const settings: ModelFilterSettings = {
      showVisionModels: true,
      showReasoningModels: true,
      showCreativeModels: true,
    };

    expect(settings.showVisionModels).toBe(true);
    expect(settings.showReasoningModels).toBe(true);
    expect(settings.showCreativeModels).toBe(true);
  });

  it("can create mixed settings", () => {
    const settings: ModelFilterSettings = {
      showVisionModels: true,
      showReasoningModels: false,
      showCreativeModels: true,
    };

    expect(settings.showVisionModels).toBe(true);
    expect(settings.showReasoningModels).toBe(false);
    expect(settings.showCreativeModels).toBe(true);
  });
});
