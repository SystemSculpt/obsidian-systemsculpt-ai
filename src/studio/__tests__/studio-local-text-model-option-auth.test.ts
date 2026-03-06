import {
  decorateStudioLocalTextModelOptionsWithAuth,
  resolveStudioLocalTextModelProviderId,
} from "../StudioLocalTextModelOptionAuth";

describe("StudioLocalTextModelOptionAuth", () => {
  it("resolves provider IDs from badge or provider/model values", () => {
    expect(
      resolveStudioLocalTextModelProviderId({
        value: "openai/gpt-5",
        badge: "OpenAI",
      })
    ).toBe("openai");

    expect(
      resolveStudioLocalTextModelProviderId({
        value: "anthropic/claude-sonnet-4",
      })
    ).toBe("anthropic");

    expect(
      resolveStudioLocalTextModelProviderId({
        value: "missing-delimiter",
      })
    ).toBe("");
  });

  it("marks authenticated providers, appends check badges, and sorts them first", () => {
    const decorated = decorateStudioLocalTextModelOptionsWithAuth(
      [
        {
          value: "openai/gpt-5",
          label: "gpt-5",
          badge: "openai",
        },
        {
          value: "anthropic/claude-sonnet-4",
          label: "claude-sonnet-4",
          badge: "anthropic",
        },
        {
          value: "openrouter/deepseek-r1",
          label: "deepseek-r1",
          badge: "openrouter",
        },
      ],
      [
        {
          provider: "anthropic",
          displayName: "Anthropic",
          hasAnyAuth: true,
          hasStoredCredential: false,
          credentialType: "oauth",
        },
        {
          provider: "openrouter",
          hasAnyAuth: true,
          displayName: "OpenRouter",
          hasStoredCredential: true,
          credentialType: "none",
        },
      ]
    );

    expect(decorated.map((option) => option.value)).toEqual([
      "anthropic/claude-sonnet-4",
      "openrouter/deepseek-r1",
      "openai/gpt-5",
    ]);

    const anthropic = decorated[0];
    expect(anthropic.providerAuthenticated).toBe(true);
    expect(anthropic.badge).toBe("Anthropic ✓");
    expect(anthropic.keywords).toEqual(
      expect.arrayContaining(["authenticated", "oauth", "api key"])
    );

    const openai = decorated[2];
    expect(openai.providerAuthenticated).toBe(false);
    expect(openai.badge).toBe("openai");
  });
});
