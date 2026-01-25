/**
 * @jest-environment node
 */
import { simpleHash, generateSha1Hash, generateSha256Hash } from "../cryptoUtils";

describe("cryptoUtils", () => {
  describe("simpleHash", () => {
    it("returns a hex string", () => {
      const result = simpleHash("test");
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it("returns consistent results for same input", () => {
      const result1 = simpleHash("hello");
      const result2 = simpleHash("hello");
      expect(result1).toBe(result2);
    });

    it("returns different results for different inputs", () => {
      const result1 = simpleHash("hello");
      const result2 = simpleHash("world");
      expect(result1).not.toBe(result2);
    });

    it("handles empty string", () => {
      const result = simpleHash("");
      expect(result).toBe("00000000");
    });

    it("pads result to at least 8 characters", () => {
      const result = simpleHash("a");
      expect(result.length).toBeGreaterThanOrEqual(8);
    });

    it("handles unicode characters", () => {
      const result = simpleHash("你好世界");
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it("handles very long strings", () => {
      const longString = "a".repeat(10000);
      const result = simpleHash(longString);
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it("handles special characters", () => {
      const result = simpleHash("!@#$%^&*()");
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it("handles newlines and whitespace", () => {
      const result = simpleHash("hello\nworld\t!");
      expect(result).toMatch(/^[0-9a-f]+$/);
    });
  });

  // Test SHA functions using real crypto API in Node environment
  describe("generateSha1Hash", () => {
    it("generates consistent SHA-1 hash", async () => {
      const result1 = await generateSha1Hash("test");
      const result2 = await generateSha1Hash("test");
      expect(result1).toBe(result2);
    });

    it("returns a 40-character hex string", async () => {
      const result = await generateSha1Hash("hello");
      expect(result).toMatch(/^[0-9a-f]{40}$/);
    });

    it("produces different hashes for different inputs", async () => {
      const hash1 = await generateSha1Hash("hello");
      const hash2 = await generateSha1Hash("world");
      expect(hash1).not.toBe(hash2);
    });

    it("handles empty string", async () => {
      const result = await generateSha1Hash("");
      expect(result).toMatch(/^[0-9a-f]{40}$/);
    });

    it("handles unicode characters", async () => {
      const result = await generateSha1Hash("你好世界");
      expect(result).toMatch(/^[0-9a-f]{40}$/);
    });

    it("throws when crypto.subtle is unavailable", async () => {
      const originalCrypto = global.crypto;
      (global as any).crypto = { subtle: undefined };

      await expect(generateSha1Hash("test")).rejects.toThrow("Web Crypto API");

      global.crypto = originalCrypto;
    });

    it("throws when digest operation fails", async () => {
      const originalCrypto = global.crypto;
      (global as any).crypto = {
        subtle: {
          digest: jest.fn().mockRejectedValue(new Error("Digest failed")),
        },
      };

      await expect(generateSha1Hash("test")).rejects.toThrow("Failed to generate SHA-1 hash");

      global.crypto = originalCrypto;
    });
  });

  describe("generateSha256Hash", () => {
    it("generates consistent SHA-256 hash", async () => {
      const result1 = await generateSha256Hash("test");
      const result2 = await generateSha256Hash("test");
      expect(result1).toBe(result2);
    });

    it("returns a 64-character hex string", async () => {
      const result = await generateSha256Hash("hello");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different hashes for different inputs", async () => {
      const hash1 = await generateSha256Hash("hello");
      const hash2 = await generateSha256Hash("world");
      expect(hash1).not.toBe(hash2);
    });

    it("handles empty string", async () => {
      const result = await generateSha256Hash("");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("handles unicode characters", async () => {
      const result = await generateSha256Hash("你好世界");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("handles long strings", async () => {
      const longString = "a".repeat(10000);
      const result = await generateSha256Hash(longString);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("throws when crypto.subtle is unavailable", async () => {
      const originalCrypto = global.crypto;
      (global as any).crypto = { subtle: undefined };

      await expect(generateSha256Hash("test")).rejects.toThrow("Web Crypto API");

      global.crypto = originalCrypto;
    });

    it("throws when digest operation fails", async () => {
      const originalCrypto = global.crypto;
      (global as any).crypto = {
        subtle: {
          digest: jest.fn().mockRejectedValue(new Error("Digest failed")),
        },
      };

      await expect(generateSha256Hash("test")).rejects.toThrow("Failed to generate SHA-256 hash");

      global.crypto = originalCrypto;
    });
  });
});
