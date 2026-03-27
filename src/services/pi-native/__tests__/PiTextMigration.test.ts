import {
  normalizeLegacyPiTextSelectionId,
  resolveLegacyPiTextSelection,
  resolveLegacyPiTextSelectionId,
} from "../PiTextMigration";

describe("resolveLegacyPiTextSelection", () => {
  const models = [
    {
      id: "openai@@gpt-4.1",
      provider: "openai",
      piExecutionModelId: "openai/gpt-4.1",
      piLocalAvailable: true,
    },
    {
      id: "anthropic@@claude-haiku-4-5",
      provider: "anthropic",
      piExecutionModelId: "anthropic/claude-haiku-4-5",
      piLocalAvailable: true,
    },
    {
      id: "anthropic@@claude-sonnet-4-6",
      provider: "anthropic",
      piExecutionModelId: "anthropic/claude-sonnet-4-6",
      piLocalAvailable: true,
    },
    {
      id: "systemsculpt@@systemsculpt/ai-agent",
      provider: "systemsculpt",
      piExecutionModelId: "systemsculpt/ai-agent",
      piLocalAvailable: true,
    },
  ] as any;

  it("maps legacy Local Pi canonical ids onto the merged Pi catalog", () => {
    const resolved = resolveLegacyPiTextSelection("local-pi-openai@@gpt-4.1", models, []);
    expect(resolved?.id).toBe("openai@@gpt-4.1");
  });

  it("maps legacy custom-provider selections through endpoint provider hints", () => {
    const resolved = resolveLegacyPiTextSelection(
      "my-openai@@gpt-4.1",
      models,
      [
        {
          id: "provider_1",
          name: "My OpenAI",
          endpoint: "https://api.openai.com/v1",
          apiKey: "sk-test",
          isEnabled: true,
        },
      ] as any
    );

    expect(resolved?.id).toBe("openai@@gpt-4.1");
  });

  it("still maps legacy custom-provider selections after provider secrets are redacted", () => {
    const resolved = resolveLegacyPiTextSelection(
      "my-openai@@gpt-4.1",
      models,
      [
        {
          id: "provider_1",
          name: "My OpenAI",
          endpoint: "https://api.openai.com/v1",
          apiKey: "",
          isEnabled: true,
        },
      ] as any
    );

    expect(resolved?.id).toBe("openai@@gpt-4.1");
  });

  it("maps the legacy SystemSculpt alias back onto the canonical SystemSculpt Pi model", () => {
    const resolved = resolveLegacyPiTextSelection("systemsculpt@@systemsculpt/managed", models, []);
    expect(resolved?.id).toBe("systemsculpt@@systemsculpt/ai-agent");
  });

  it("migrates pinned legacy model ids onto stable latest aliases when available", () => {
    const resolved = resolveLegacyPiTextSelection(
      "local-pi-anthropic@@claude-haiku-4-5-20251001",
      models,
      []
    );

    expect(resolved?.id).toBe("anthropic@@claude-haiku-4-5");
  });

  it("normalizes legacy SystemSculpt ids even before models are loaded", () => {
    expect(normalizeLegacyPiTextSelectionId("systemsculpt@@systemsculpt/managed"))
      .toBe("systemsculpt@@systemsculpt/ai-agent");
    expect(
      resolveLegacyPiTextSelectionId("systemsculpt@@systemsculpt/managed", [], [])
    ).toBe("systemsculpt@@systemsculpt/ai-agent");
  });
});
