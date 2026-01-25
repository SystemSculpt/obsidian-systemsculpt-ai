/**
 * @jest-environment node
 */
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSION,
  SUPPORTED_EMBEDDING_MODELS,
  LEGACY_EMBEDDING_MODELS,
  MAX_EMBEDDING_BATCH,
  EMBEDDING_SCHEMA_VERSION,
} from "../embeddings";

describe("embeddings constants", () => {
  describe("DEFAULT_EMBEDDING_MODEL", () => {
    it("is defined", () => {
      expect(DEFAULT_EMBEDDING_MODEL).toBeDefined();
    });

    it("is a string", () => {
      expect(typeof DEFAULT_EMBEDDING_MODEL).toBe("string");
    });

    it("uses openrouter provider", () => {
      expect(DEFAULT_EMBEDDING_MODEL).toContain("openrouter");
    });

    it("uses text-embedding-3-small model", () => {
      expect(DEFAULT_EMBEDDING_MODEL).toContain("text-embedding-3-small");
    });
  });

  describe("DEFAULT_EMBEDDING_DIMENSION", () => {
    it("is defined", () => {
      expect(DEFAULT_EMBEDDING_DIMENSION).toBeDefined();
    });

    it("is a number", () => {
      expect(typeof DEFAULT_EMBEDDING_DIMENSION).toBe("number");
    });

    it("is 1536", () => {
      expect(DEFAULT_EMBEDDING_DIMENSION).toBe(1536);
    });

    it("is a power of 2 * 3", () => {
      // 1536 = 512 * 3 = 2^9 * 3
      expect(DEFAULT_EMBEDDING_DIMENSION % 512).toBe(0);
    });
  });

  describe("SUPPORTED_EMBEDDING_MODELS", () => {
    it("is an array", () => {
      expect(Array.isArray(SUPPORTED_EMBEDDING_MODELS)).toBe(true);
    });

    it("is not empty", () => {
      expect(SUPPORTED_EMBEDDING_MODELS.length).toBeGreaterThan(0);
    });

    it("contains the default model", () => {
      expect(SUPPORTED_EMBEDDING_MODELS).toContain(DEFAULT_EMBEDDING_MODEL);
    });

    it("contains text-embedding-3-small variants", () => {
      const smallModels = SUPPORTED_EMBEDDING_MODELS.filter((m) =>
        m.includes("text-embedding-3-small")
      );
      expect(smallModels.length).toBeGreaterThan(0);
    });

    it("contains text-embedding-3-large", () => {
      const largeModels = SUPPORTED_EMBEDDING_MODELS.filter((m) =>
        m.includes("text-embedding-3-large")
      );
      expect(largeModels.length).toBeGreaterThan(0);
    });

    it("all models are non-empty strings", () => {
      SUPPORTED_EMBEDDING_MODELS.forEach((model) => {
        expect(typeof model).toBe("string");
        expect(model.length).toBeGreaterThan(0);
      });
    });
  });

  describe("LEGACY_EMBEDDING_MODELS", () => {
    it("is an array", () => {
      expect(Array.isArray(LEGACY_EMBEDDING_MODELS)).toBe(true);
    });

    it("is not empty", () => {
      expect(LEGACY_EMBEDDING_MODELS.length).toBeGreaterThan(0);
    });

    it("contains text-embedding-ada-002", () => {
      expect(LEGACY_EMBEDDING_MODELS).toContain("text-embedding-ada-002");
    });

    it("all models are non-empty strings", () => {
      LEGACY_EMBEDDING_MODELS.forEach((model) => {
        expect(typeof model).toBe("string");
        expect(model.length).toBeGreaterThan(0);
      });
    });

    it("does not overlap with supported models", () => {
      LEGACY_EMBEDDING_MODELS.forEach((legacyModel) => {
        expect(SUPPORTED_EMBEDDING_MODELS).not.toContain(legacyModel);
      });
    });

    it("includes some gemini models", () => {
      const geminiModels = LEGACY_EMBEDDING_MODELS.filter(
        (m) => m.includes("gemini") || m.includes("google")
      );
      expect(geminiModels.length).toBeGreaterThan(0);
    });
  });

  describe("MAX_EMBEDDING_BATCH", () => {
    it("is defined", () => {
      expect(MAX_EMBEDDING_BATCH).toBeDefined();
    });

    it("is a number", () => {
      expect(typeof MAX_EMBEDDING_BATCH).toBe("number");
    });

    it("is 25", () => {
      expect(MAX_EMBEDDING_BATCH).toBe(25);
    });

    it("is a positive integer", () => {
      expect(MAX_EMBEDDING_BATCH).toBeGreaterThan(0);
      expect(Number.isInteger(MAX_EMBEDDING_BATCH)).toBe(true);
    });
  });

  describe("EMBEDDING_SCHEMA_VERSION", () => {
    it("is defined", () => {
      expect(EMBEDDING_SCHEMA_VERSION).toBeDefined();
    });

    it("is a number", () => {
      expect(typeof EMBEDDING_SCHEMA_VERSION).toBe("number");
    });

    it("is a positive integer", () => {
      expect(EMBEDDING_SCHEMA_VERSION).toBeGreaterThan(0);
      expect(Number.isInteger(EMBEDDING_SCHEMA_VERSION)).toBe(true);
    });

    it("is 2", () => {
      expect(EMBEDDING_SCHEMA_VERSION).toBe(2);
    });
  });
});
