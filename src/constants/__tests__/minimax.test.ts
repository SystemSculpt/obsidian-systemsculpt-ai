/**
 * @jest-environment node
 */
import { isMiniMaxEndpoint, MINIMAX_BASE_URL } from "../minimax";

describe("minimax constants", () => {
  describe("MINIMAX_BASE_URL", () => {
    it("is the correct MiniMax API URL", () => {
      expect(MINIMAX_BASE_URL).toBe("https://api.minimax.io/v1");
    });
  });

  describe("isMiniMaxEndpoint", () => {
    it("returns true for minimax.io endpoints", () => {
      expect(isMiniMaxEndpoint("https://api.minimax.io/v1")).toBe(true);
      expect(isMiniMaxEndpoint("https://api.minimax.io")).toBe(true);
      expect(isMiniMaxEndpoint("https://minimax.io/api")).toBe(true);
    });

    it("returns true for endpoints containing minimax", () => {
      expect(isMiniMaxEndpoint("https://proxy.example.com/minimax/api")).toBe(true);
      expect(isMiniMaxEndpoint("http://localhost:8080/minimax")).toBe(true);
    });

    it("is case insensitive for string match", () => {
      expect(isMiniMaxEndpoint("https://api.MINIMAX.io/v1")).toBe(true);
      expect(isMiniMaxEndpoint("MINIMAX")).toBe(true);
    });

    it("returns false for non-minimax endpoints", () => {
      expect(isMiniMaxEndpoint("https://api.openai.com")).toBe(false);
      expect(isMiniMaxEndpoint("https://api.anthropic.com")).toBe(false);
      expect(isMiniMaxEndpoint("https://api.moonshot.ai")).toBe(false);
      expect(isMiniMaxEndpoint("https://example.com")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isMiniMaxEndpoint("")).toBe(false);
    });

    it("returns false for null or undefined", () => {
      expect(isMiniMaxEndpoint(null as any)).toBe(false);
      expect(isMiniMaxEndpoint(undefined as any)).toBe(false);
    });

    it("handles valid URL parsing", () => {
      expect(isMiniMaxEndpoint("https://api.minimax.io:443/v1/chat")).toBe(true);
    });

    it("handles invalid URLs gracefully", () => {
      // Invalid URL but contains minimax
      expect(isMiniMaxEndpoint("not-a-url-but-has-minimax")).toBe(true);
      // Invalid URL without minimax
      expect(isMiniMaxEndpoint("not-a-url")).toBe(false);
    });
  });
});
