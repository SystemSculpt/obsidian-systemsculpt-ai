import {
  hasAuthenticatedModelSelectorProvider,
  normalizeModelSelectorProviderId,
} from "../StandardModelSelectionModal";

describe("StandardModelSelectionModal auth helpers", () => {
  it("normalizes provider IDs safely", () => {
    expect(normalizeModelSelectorProviderId(" OpenAI-Codex ")).toBe("openai-codex");
    expect(normalizeModelSelectorProviderId("")).toBe("");
    expect(normalizeModelSelectorProviderId(null)).toBe("");
  });

  it("detects authenticated providers from stored credential flags", () => {
    expect(
      hasAuthenticatedModelSelectorProvider({
        provider: "anthropic",
        hasStoredCredential: true,
        credentialType: "none",
      })
    ).toBe(true);
    expect(
      hasAuthenticatedModelSelectorProvider({
        provider: "openai-codex",
        hasStoredCredential: false,
        credentialType: "oauth",
      })
    ).toBe(true);
    expect(
      hasAuthenticatedModelSelectorProvider({
        provider: "openai",
        hasStoredCredential: false,
        credentialType: "api_key",
      })
    ).toBe(true);
    expect(
      hasAuthenticatedModelSelectorProvider({
        provider: "openrouter",
        hasStoredCredential: false,
        credentialType: "none",
      })
    ).toBe(false);
  });
});
