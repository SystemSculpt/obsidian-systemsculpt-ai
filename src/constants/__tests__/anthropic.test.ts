/**
 * @jest-environment node
 */
import {
  ANTHROPIC_API_BASE_URL,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MODELS,
  ANTHROPIC_STREAM_EVENTS,
  isAnthropicEndpoint,
  correctAnthropicEndpoint,
  isCorrectableAnthropicEndpoint,
  resolveAnthropicModelId,
} from "../anthropic";

describe("anthropic constants", () => {
  describe("ANTHROPIC_API_BASE_URL", () => {
    it("is the correct Anthropic API URL", () => {
      expect(ANTHROPIC_API_BASE_URL).toBe("https://api.anthropic.com");
    });
  });

  describe("ANTHROPIC_API_VERSION", () => {
    it("is a valid API version string", () => {
      expect(ANTHROPIC_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("ANTHROPIC_MODELS", () => {
    it("is a non-empty array", () => {
      expect(Array.isArray(ANTHROPIC_MODELS)).toBe(true);
      expect(ANTHROPIC_MODELS.length).toBeGreaterThan(0);
    });

    it("all models have required fields", () => {
      for (const model of ANTHROPIC_MODELS) {
        expect(model.id).toBeDefined();
        expect(model.name).toBeDefined();
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxOutput).toBeGreaterThan(0);
        expect(Array.isArray(model.capabilities)).toBe(true);
        expect(typeof model.supportsStreaming).toBe("boolean");
        expect(typeof model.supportsTools).toBe("boolean");
      }
    });

    it("all models have unique ids", () => {
      const ids = ANTHROPIC_MODELS.map((m) => m.id);
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds.length).toBe(ids.length);
    });

    it("includes Claude Opus and Sonnet models", () => {
      const modelNames = ANTHROPIC_MODELS.map((m) => m.name.toLowerCase());
      expect(modelNames.some((n) => n.includes("opus"))).toBe(true);
      expect(modelNames.some((n) => n.includes("sonnet"))).toBe(true);
    });
  });

  describe("ANTHROPIC_STREAM_EVENTS", () => {
    it("has all required event types", () => {
      expect(ANTHROPIC_STREAM_EVENTS.MESSAGE_START).toBe("message_start");
      expect(ANTHROPIC_STREAM_EVENTS.CONTENT_BLOCK_START).toBe("content_block_start");
      expect(ANTHROPIC_STREAM_EVENTS.CONTENT_BLOCK_DELTA).toBe("content_block_delta");
      expect(ANTHROPIC_STREAM_EVENTS.CONTENT_BLOCK_STOP).toBe("content_block_stop");
      expect(ANTHROPIC_STREAM_EVENTS.MESSAGE_DELTA).toBe("message_delta");
      expect(ANTHROPIC_STREAM_EVENTS.MESSAGE_STOP).toBe("message_stop");
      expect(ANTHROPIC_STREAM_EVENTS.PING).toBe("ping");
      expect(ANTHROPIC_STREAM_EVENTS.ERROR).toBe("error");
    });
  });

  describe("isAnthropicEndpoint", () => {
    it("returns true for api.anthropic.com", () => {
      expect(isAnthropicEndpoint("https://api.anthropic.com")).toBe(true);
      expect(isAnthropicEndpoint("https://api.anthropic.com/v1")).toBe(true);
      expect(isAnthropicEndpoint("https://API.ANTHROPIC.COM")).toBe(true);
    });

    it("returns true for claude.ai", () => {
      expect(isAnthropicEndpoint("https://claude.ai")).toBe(true);
      expect(isAnthropicEndpoint("https://claude.ai/api")).toBe(true);
      expect(isAnthropicEndpoint("https://CLAUDE.AI")).toBe(true);
    });

    it("returns false for non-Anthropic endpoints", () => {
      expect(isAnthropicEndpoint("https://api.openai.com")).toBe(false);
      expect(isAnthropicEndpoint("https://example.com")).toBe(false);
      expect(isAnthropicEndpoint("https://api.moonshot.ai")).toBe(false);
    });

    it("handles edge cases", () => {
      expect(isAnthropicEndpoint("")).toBe(false);
      expect(isAnthropicEndpoint("anthropic")).toBe(false);
    });
  });

  describe("isCorrectableAnthropicEndpoint", () => {
    it("returns true for endpoints containing api.anthropic.com", () => {
      expect(isCorrectableAnthropicEndpoint("https://api.anthropic.com")).toBe(true);
      expect(isCorrectableAnthropicEndpoint("https://proxy.example.com/api.anthropic.com")).toBe(true);
      expect(isCorrectableAnthropicEndpoint("api.anthropic.com/v1")).toBe(true);
    });

    it("returns false for other endpoints", () => {
      expect(isCorrectableAnthropicEndpoint("https://claude.ai")).toBe(false);
      expect(isCorrectableAnthropicEndpoint("https://api.openai.com")).toBe(false);
    });

    it("is case insensitive", () => {
      expect(isCorrectableAnthropicEndpoint("https://API.ANTHROPIC.COM")).toBe(true);
    });
  });

  describe("correctAnthropicEndpoint", () => {
    it("returns unchanged for already correct endpoint", () => {
      const result = correctAnthropicEndpoint("https://api.anthropic.com");
      expect(result.correctedEndpoint).toBe("https://api.anthropic.com");
      expect(result.wasCorrected).toBe(false);
      expect(result.originalEndpoint).toBe("https://api.anthropic.com");
    });

    it("returns unchanged for endpoint with /v1", () => {
      const result = correctAnthropicEndpoint("https://api.anthropic.com/v1");
      expect(result.wasCorrected).toBe(false);
    });

    it("returns unchanged for endpoint with trailing slash", () => {
      const result = correctAnthropicEndpoint("https://api.anthropic.com/");
      expect(result.wasCorrected).toBe(false);
    });

    it("corrects malformed proxy endpoint", () => {
      const result = correctAnthropicEndpoint("https://proxy.example.com/api.anthropic.com/v1");
      expect(result.correctedEndpoint).toBe(ANTHROPIC_API_BASE_URL);
      expect(result.wasCorrected).toBe(true);
      expect(result.originalEndpoint).toBe("https://proxy.example.com/api.anthropic.com/v1");
    });

    it("corrects endpoint without protocol", () => {
      const result = correctAnthropicEndpoint("api.anthropic.com/v1/messages");
      expect(result.correctedEndpoint).toBe(ANTHROPIC_API_BASE_URL);
      expect(result.wasCorrected).toBe(true);
    });

    it("corrects endpoint with extra path", () => {
      const result = correctAnthropicEndpoint("https://api.anthropic.com/v1/messages");
      expect(result.correctedEndpoint).toBe(ANTHROPIC_API_BASE_URL);
      expect(result.wasCorrected).toBe(true);
    });

    it("returns unchanged for non-anthropic endpoints", () => {
      const result = correctAnthropicEndpoint("https://api.openai.com/v1");
      expect(result.correctedEndpoint).toBe("https://api.openai.com/v1");
      expect(result.wasCorrected).toBe(false);
    });

    it("trims whitespace", () => {
      const result = correctAnthropicEndpoint("  https://api.anthropic.com  ");
      expect(result.originalEndpoint).toBe("https://api.anthropic.com");
    });
  });

  describe("resolveAnthropicModelId", () => {
    it("returns canonical ID when given canonical ID", () => {
      const model = ANTHROPIC_MODELS[0];
      expect(resolveAnthropicModelId(model.id)).toBe(model.id);
    });

    it("resolves alias to canonical ID", () => {
      // Find a model with aliases
      const modelWithAlias = ANTHROPIC_MODELS.find((m) => m.aliases && m.aliases.length > 0);
      if (modelWithAlias && modelWithAlias.aliases) {
        const alias = modelWithAlias.aliases[0];
        expect(resolveAnthropicModelId(alias)).toBe(modelWithAlias.id);
      }
    });

    it("returns input unchanged for unknown model", () => {
      const unknownModel = "claude-unknown-model-2024";
      expect(resolveAnthropicModelId(unknownModel)).toBe(unknownModel);
    });

    it("resolves claude-opus-4-1 alias", () => {
      const resolved = resolveAnthropicModelId("claude-opus-4-1");
      // Should resolve to the full model ID
      expect(resolved).toMatch(/claude-opus-4-1/);
    });

    it("handles empty string", () => {
      expect(resolveAnthropicModelId("")).toBe("");
    });

    it("is case sensitive", () => {
      const model = ANTHROPIC_MODELS[0];
      const upperCaseId = model.id.toUpperCase();
      // If upper case doesn't match, it returns as-is
      expect(resolveAnthropicModelId(upperCaseId)).toBe(upperCaseId);
    });
  });
});
