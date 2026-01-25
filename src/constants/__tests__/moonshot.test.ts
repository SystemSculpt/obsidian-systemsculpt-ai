/**
 * @jest-environment node
 */
import { isMoonshotEndpoint, MOONSHOT_API_BASE_URL } from "../moonshot";

describe("moonshot constants", () => {
  describe("MOONSHOT_API_BASE_URL", () => {
    it("is the correct Moonshot API URL", () => {
      expect(MOONSHOT_API_BASE_URL).toBe("https://api.moonshot.ai/v1");
    });
  });

  describe("isMoonshotEndpoint", () => {
    it("returns true for moonshot.ai endpoints", () => {
      expect(isMoonshotEndpoint("https://api.moonshot.ai/v1")).toBe(true);
      expect(isMoonshotEndpoint("https://api.moonshot.ai")).toBe(true);
      expect(isMoonshotEndpoint("https://moonshot.ai/api")).toBe(true);
    });

    it("returns true for moonshot.cn endpoints", () => {
      expect(isMoonshotEndpoint("https://api.moonshot.cn/v1")).toBe(true);
      expect(isMoonshotEndpoint("https://api.moonshot.cn")).toBe(true);
      expect(isMoonshotEndpoint("https://moonshot.cn/api")).toBe(true);
    });

    it("is case insensitive for string match", () => {
      expect(isMoonshotEndpoint("https://api.MOONSHOT.AI/v1")).toBe(true);
      expect(isMoonshotEndpoint("https://api.MOONSHOT.CN")).toBe(true);
    });

    it("returns false for non-moonshot endpoints", () => {
      expect(isMoonshotEndpoint("https://api.openai.com")).toBe(false);
      expect(isMoonshotEndpoint("https://api.anthropic.com")).toBe(false);
      expect(isMoonshotEndpoint("https://api.minimax.io")).toBe(false);
      expect(isMoonshotEndpoint("https://example.com")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isMoonshotEndpoint("")).toBe(false);
    });

    it("returns false for null or undefined", () => {
      expect(isMoonshotEndpoint(null as any)).toBe(false);
      expect(isMoonshotEndpoint(undefined as any)).toBe(false);
    });

    it("handles valid URL parsing", () => {
      expect(isMoonshotEndpoint("https://api.moonshot.ai:443/v1/chat")).toBe(true);
    });

    it("handles invalid URLs with moonshot in string", () => {
      expect(isMoonshotEndpoint("moonshot.ai-is-here")).toBe(true);
    });

    it("handles invalid URLs without moonshot", () => {
      expect(isMoonshotEndpoint("not-a-url")).toBe(false);
    });

    it("handles subdomains correctly", () => {
      expect(isMoonshotEndpoint("https://chat.moonshot.ai")).toBe(true);
      expect(isMoonshotEndpoint("https://v1.api.moonshot.cn")).toBe(true);
    });
  });
});
