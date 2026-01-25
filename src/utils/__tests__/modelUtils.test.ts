/**
 * @jest-environment jsdom
 */
import {
  MODEL_ID_SEPARATOR,
  createCanonicalId,
  parseCanonicalId,
  migrateFromLegacyId,
  getCanonicalId,
  findModelById,
  getDisplayName,
  getProviderDisplayPrefix,
  getModelLabelWithProvider,
  supportsImages,
  getImageCompatibilityInfo,
  ensureCanonicalId,
  isEmbeddingModel,
  filterChatModels,
  supportsTools,
  getToolCompatibilityInfo,
} from "../modelUtils";
import { SystemSculptModel } from "../../types/llm";

// Helper to create mock models
const createMockModel = (
  overrides: Partial<SystemSculptModel> = {}
): SystemSculptModel =>
  ({
    id: "openai@@gpt-4",
    name: "gpt-4",
    provider: "openai",
    capabilities: [],
    ...overrides,
  } as SystemSculptModel);

describe("modelUtils", () => {
  describe("MODEL_ID_SEPARATOR", () => {
    it("should be @@", () => {
      expect(MODEL_ID_SEPARATOR).toBe("@@");
    });
  });

  describe("createCanonicalId", () => {
    it("creates canonical ID from provider and model", () => {
      expect(createCanonicalId("openai", "gpt-4")).toBe("openai@@gpt-4");
    });

    it("lowercases the provider ID", () => {
      expect(createCanonicalId("OpenAI", "gpt-4")).toBe("openai@@gpt-4");
    });

    it("preserves model ID case and characters", () => {
      expect(createCanonicalId("openai", "GPT-4-Turbo")).toBe(
        "openai@@GPT-4-Turbo"
      );
    });

    it("handles model IDs with slashes", () => {
      expect(createCanonicalId("openrouter", "openai/o3-mini")).toBe(
        "openrouter@@openai/o3-mini"
      );
    });

    it("handles empty strings", () => {
      expect(createCanonicalId("", "")).toBe("@@");
    });
  });

  describe("parseCanonicalId", () => {
    it("parses canonical ID into components", () => {
      const result = parseCanonicalId("openai@@gpt-4");
      expect(result).toEqual({
        providerId: "openai",
        modelId: "gpt-4",
      });
    });

    it("lowercases provider ID", () => {
      const result = parseCanonicalId("OpenAI@@gpt-4");
      expect(result?.providerId).toBe("openai");
    });

    it("handles model IDs with slashes", () => {
      const result = parseCanonicalId("openrouter@@openai/o3-mini");
      expect(result).toEqual({
        providerId: "openrouter",
        modelId: "openai/o3-mini",
      });
    });

    it("returns null for non-canonical IDs", () => {
      expect(parseCanonicalId("openai/gpt-4")).toBeNull();
      expect(parseCanonicalId("gpt-4")).toBeNull();
    });

    it("returns null for null/undefined", () => {
      expect(parseCanonicalId(null as any)).toBeNull();
      expect(parseCanonicalId(undefined as any)).toBeNull();
    });

    it("handles IDs with multiple separators", () => {
      const result = parseCanonicalId("provider@@model@@part");
      expect(result).toEqual({
        providerId: "provider",
        modelId: "model@@part",
      });
    });
  });

  describe("migrateFromLegacyId", () => {
    it("returns canonical IDs unchanged", () => {
      expect(migrateFromLegacyId("openai@@gpt-4")).toBe("openai@@gpt-4");
    });

    it("converts legacy slash format", () => {
      expect(migrateFromLegacyId("openai/gpt-4")).toBe("openai@@gpt-4");
    });

    it("handles known providers with model slashes", () => {
      expect(migrateFromLegacyId("openrouter/openai/o3-mini")).toBe(
        "openrouter@@openai/o3-mini"
      );
    });

    it("uses default provider for bare model IDs", () => {
      expect(migrateFromLegacyId("gpt-4")).toBe("systemsculpt@@gpt-4");
    });

    it("uses custom default provider", () => {
      expect(migrateFromLegacyId("gpt-4", "openai")).toBe("openai@@gpt-4");
    });

    it("handles together provider", () => {
      expect(migrateFromLegacyId("together/meta-llama/llama-2")).toBe(
        "together@@meta-llama/llama-2"
      );
    });

    it("handles fireworks provider", () => {
      expect(migrateFromLegacyId("fireworks/llama-v2-7b")).toBe(
        "fireworks@@llama-v2-7b"
      );
    });
  });

  describe("getCanonicalId", () => {
    it("returns existing canonical ID", () => {
      const model = createMockModel({ id: "openai@@gpt-4" });
      expect(getCanonicalId(model)).toBe("openai@@gpt-4");
    });

    it("creates canonical ID from identifier", () => {
      const model = createMockModel({
        id: "legacy-id",
        identifier: { providerId: "anthropic", modelId: "claude-3" },
      });
      expect(getCanonicalId(model)).toBe("anthropic@@claude-3");
    });

    it("migrates legacy format using provider", () => {
      const model = createMockModel({
        id: "gpt-4",
        provider: "openai",
      });
      expect(getCanonicalId(model)).toBe("openai@@gpt-4");
    });

    it("uses unknown provider as fallback", () => {
      const model = createMockModel({
        id: "some-model",
        provider: undefined as any,
      });
      expect(getCanonicalId(model)).toBe("unknown@@some-model");
    });
  });

  describe("findModelById", () => {
    const models: SystemSculptModel[] = [
      createMockModel({ id: "openai@@gpt-4", name: "gpt-4", provider: "openai" }),
      createMockModel({
        id: "anthropic@@claude-3-opus",
        name: "claude-3-opus",
        provider: "anthropic",
      }),
      createMockModel({
        id: "openrouter@@openai/o3-mini",
        name: "o3-mini",
        provider: "openrouter",
        identifier: { providerId: "openrouter", modelId: "openai/o3-mini" },
      }),
    ];

    it("finds model by exact canonical ID", () => {
      const found = findModelById(models, "openai@@gpt-4");
      expect(found?.id).toBe("openai@@gpt-4");
    });

    it("finds model by legacy ID format", () => {
      const found = findModelById(models, "openai/gpt-4");
      expect(found?.id).toBe("openai@@gpt-4");
    });

    it("returns undefined for non-existent model", () => {
      expect(findModelById(models, "openai@@gpt-5")).toBeUndefined();
    });

    it("finds model by identifier.modelId", () => {
      const found = findModelById(models, "openrouter@@openai/o3-mini");
      expect(found?.id).toBe("openrouter@@openai/o3-mini");
    });

    it("returns undefined for empty models list", () => {
      expect(findModelById([], "openai@@gpt-4")).toBeUndefined();
    });
  });

  describe("getDisplayName", () => {
    it("extracts model name from canonical ID", () => {
      expect(getDisplayName("openai@@gpt-4")).toBe("gpt-4");
    });

    it("extracts last part from legacy slash format", () => {
      expect(getDisplayName("openai/gpt-4")).toBe("gpt-4");
    });

    it("returns bare model name unchanged", () => {
      expect(getDisplayName("gpt-4")).toBe("gpt-4");
    });

    it("handles OpenRouter model IDs with slashes", () => {
      expect(getDisplayName("openrouter@@openai/o3-mini")).toBe(
        "openai/o3-mini"
      );
    });

    it("handles undefined/null gracefully", () => {
      expect(getDisplayName(undefined as any)).toBeUndefined();
      expect(getDisplayName(null as any)).toBeNull();
    });
  });

  describe("getProviderDisplayPrefix", () => {
    it("returns [SS AI] for systemsculpt", () => {
      expect(getProviderDisplayPrefix("systemsculpt")).toBe("[SS AI] ");
    });

    it("returns uppercase bracketed prefix for other providers", () => {
      expect(getProviderDisplayPrefix("openai")).toBe("[OPENAI] ");
      expect(getProviderDisplayPrefix("anthropic")).toBe("[ANTHROPIC] ");
    });

    it("handles case-insensitively", () => {
      expect(getProviderDisplayPrefix("SystemSculpt")).toBe("[SS AI] ");
      expect(getProviderDisplayPrefix("OPENAI")).toBe("[OPENAI] ");
    });

    it("returns empty string for empty input", () => {
      expect(getProviderDisplayPrefix("")).toBe("");
      expect(getProviderDisplayPrefix(null as any)).toBe("");
    });
  });

  describe("getModelLabelWithProvider", () => {
    it("combines provider prefix with model name", () => {
      expect(getModelLabelWithProvider("openai@@gpt-4")).toBe("[OPENAI] gpt-4");
    });

    it("handles systemsculpt provider specially", () => {
      expect(getModelLabelWithProvider("systemsculpt@@vault-agent")).toBe(
        "[SS AI] vault-agent"
      );
    });

    it("returns empty string for empty input", () => {
      expect(getModelLabelWithProvider("")).toBe("");
    });

    it("migrates legacy format", () => {
      expect(getModelLabelWithProvider("openai/gpt-4")).toBe("[OPENAI] gpt-4");
    });
  });

  describe("supportsImages", () => {
    it("returns true for models with vision capability", () => {
      const model = createMockModel({ capabilities: ["vision"] });
      expect(supportsImages(model)).toBe(true);
    });

    it("returns true for models with image capability", () => {
      const model = createMockModel({ capabilities: ["image"] });
      expect(supportsImages(model)).toBe(true);
    });

    it("returns true for models with vision modality", () => {
      const model = createMockModel({
        capabilities: [],
        architecture: { modality: "text+image" },
      });
      expect(supportsImages(model)).toBe(true);
    });

    it("returns false for text-only models", () => {
      const model = createMockModel({
        capabilities: ["chat"],
        architecture: { modality: "text" },
      });
      expect(supportsImages(model)).toBe(false);
    });

    it("returns false for null/undefined model", () => {
      expect(supportsImages(null as any)).toBe(false);
      expect(supportsImages(undefined as any)).toBe(false);
    });
  });

  describe("getImageCompatibilityInfo", () => {
    it("returns high confidence for explicit vision capability", () => {
      const model = createMockModel({ capabilities: ["vision"] });
      const info = getImageCompatibilityInfo(model);
      expect(info.isCompatible).toBe(true);
      expect(info.confidence).toBe("high");
    });

    it("returns medium confidence for architecture modality", () => {
      const model = createMockModel({
        capabilities: [],
        architecture: { modality: "text+image" },
      });
      const info = getImageCompatibilityInfo(model);
      expect(info.isCompatible).toBe(true);
      expect(info.confidence).toBe("medium");
    });

    it("returns not compatible for text-only models", () => {
      const model = createMockModel({ capabilities: ["chat"] });
      const info = getImageCompatibilityInfo(model);
      expect(info.isCompatible).toBe(false);
    });

    it("handles no model provided", () => {
      const info = getImageCompatibilityInfo(null as any);
      expect(info.isCompatible).toBe(false);
      expect(info.confidence).toBe("low");
    });
  });

  describe("ensureCanonicalId", () => {
    it("returns canonical ID unchanged", () => {
      expect(ensureCanonicalId("openai@@gpt-4")).toBe("openai@@gpt-4");
    });

    it("migrates legacy format", () => {
      expect(ensureCanonicalId("openai/gpt-4")).toBe("openai@@gpt-4");
    });

    it("uses default provider for bare IDs", () => {
      expect(ensureCanonicalId("gpt-4")).toBe("systemsculpt@@gpt-4");
    });

    it("uses custom default provider", () => {
      expect(ensureCanonicalId("gpt-4", "openai")).toBe("openai@@gpt-4");
    });

    it("returns empty string for null/undefined", () => {
      expect(ensureCanonicalId(null as any)).toBe("");
      expect(ensureCanonicalId(undefined as any)).toBe("");
      expect(ensureCanonicalId("")).toBe("");
    });
  });

  describe("isEmbeddingModel", () => {
    it("returns true for models with embed in name", () => {
      const model = createMockModel({ name: "text-embedding-3-small" });
      expect(isEmbeddingModel(model)).toBe(true);
    });

    it("returns true for models with embed in ID", () => {
      const model = createMockModel({ id: "openai@@embed-v2" });
      expect(isEmbeddingModel(model)).toBe(true);
    });

    it("returns true for embeddings capability without chat", () => {
      const model = createMockModel({ capabilities: ["embeddings"] });
      expect(isEmbeddingModel(model)).toBe(true);
    });

    it("returns false for chat models with embeddings", () => {
      const model = createMockModel({ capabilities: ["chat", "embeddings"] });
      expect(isEmbeddingModel(model)).toBe(false);
    });

    it("returns false for regular chat models", () => {
      const model = createMockModel({
        name: "gpt-4",
        id: "openai@@gpt-4",
        capabilities: ["chat"],
      });
      expect(isEmbeddingModel(model)).toBe(false);
    });
  });

  describe("filterChatModels", () => {
    it("filters out embedding models", () => {
      const models = [
        createMockModel({ name: "gpt-4", id: "openai@@gpt-4" }),
        createMockModel({
          name: "text-embedding-3-small",
          id: "openai@@text-embedding-3-small",
        }),
        createMockModel({ name: "claude-3", id: "anthropic@@claude-3" }),
      ];

      const chatModels = filterChatModels(models);

      expect(chatModels.length).toBe(2);
      expect(chatModels.map((m) => m.name)).not.toContain(
        "text-embedding-3-small"
      );
    });

    it("returns empty array for empty input", () => {
      expect(filterChatModels([])).toEqual([]);
    });

    it("returns all models if none are embeddings", () => {
      const models = [
        createMockModel({ name: "gpt-4", id: "openai@@gpt-4" }),
        createMockModel({ name: "claude-3", id: "anthropic@@claude-3" }),
      ];

      expect(filterChatModels(models).length).toBe(2);
    });
  });

  describe("supportsTools", () => {
    it("returns true for models with tools in supported_parameters", () => {
      const model = createMockModel({
        supported_parameters: ["tools", "temperature"],
      });
      expect(supportsTools(model)).toBe(true);
    });

    it("returns false for models without tools in supported_parameters", () => {
      const model = createMockModel({
        supported_parameters: ["temperature", "max_tokens"],
      });
      expect(supportsTools(model)).toBe(false);
    });

    it("returns true for models with function_calling capability", () => {
      const model = createMockModel({ capabilities: ["function_calling"] });
      expect(supportsTools(model)).toBe(true);
    });

    it("returns true for models with tool_use capability", () => {
      const model = createMockModel({ capabilities: ["tool_use"] });
      expect(supportsTools(model)).toBe(true);
    });

    it("returns true by default when no data available (optimistic)", () => {
      const model = createMockModel({ capabilities: [] });
      expect(supportsTools(model)).toBe(true);
    });
  });

  describe("getToolCompatibilityInfo", () => {
    it("returns high confidence for OpenRouter supported_parameters", () => {
      const model = createMockModel({
        supported_parameters: ["tools"],
      });
      const info = getToolCompatibilityInfo(model);
      expect(info.isCompatible).toBe(true);
      expect(info.confidence).toBe("high");
    });

    it("returns high confidence when tools not in supported_parameters", () => {
      const model = createMockModel({
        supported_parameters: ["temperature"],
      });
      const info = getToolCompatibilityInfo(model);
      expect(info.isCompatible).toBe(false);
      expect(info.confidence).toBe("high");
    });

    it("returns medium confidence for capability-based detection", () => {
      const model = createMockModel({ capabilities: ["tools"] });
      const info = getToolCompatibilityInfo(model);
      expect(info.isCompatible).toBe(true);
      expect(info.confidence).toBe("medium");
    });

    it("returns low confidence when no data available", () => {
      const model = createMockModel({ capabilities: [] });
      const info = getToolCompatibilityInfo(model);
      expect(info.isCompatible).toBe(true);
      expect(info.confidence).toBe("low");
    });
  });
});
