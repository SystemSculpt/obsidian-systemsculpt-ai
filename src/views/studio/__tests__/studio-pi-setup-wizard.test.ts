import {
  buildApiKeyHint,
  getApiKeyEnvVarForProvider,
  getStudioPiAuthMethodRestriction,
  KNOWN_OAUTH_PROVIDER_IDS,
  PROVIDER_AUTH_HINT_OVERRIDES,
  PROVIDER_LABEL_OVERRIDES,
  resolveProviderLabel,
  selectDefaultAuthMethod,
  supportsOAuthLogin,
} from "../../../studio/piAuth/StudioPiProviderRegistry";
import type { StudioPiOAuthProvider } from "../../../studio/piAuth/StudioPiAuthStorage";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function oauthMap(
  entries: Array<{ id: string; name?: string }>
): Map<string, StudioPiOAuthProvider> {
  return new Map(
    entries.map((e) => [
      e.id,
      { id: e.id, name: e.name ?? e.id, usesCallbackServer: false },
    ])
  );
}

const EMPTY_OAUTH = new Map<string, StudioPiOAuthProvider>();

// ─── KNOWN_OAUTH_PROVIDER_IDS ─────────────────────────────────────────────

describe("KNOWN_OAUTH_PROVIDER_IDS", () => {
  it("includes openai-codex", () => {
    expect(KNOWN_OAUTH_PROVIDER_IDS.has("openai-codex")).toBe(true);
  });

  it("includes github-copilot", () => {
    expect(KNOWN_OAUTH_PROVIDER_IDS.has("github-copilot")).toBe(true);
  });

  it("includes google-gemini-cli", () => {
    expect(KNOWN_OAUTH_PROVIDER_IDS.has("google-gemini-cli")).toBe(true);
  });

  it("includes google-antigravity", () => {
    expect(KNOWN_OAUTH_PROVIDER_IDS.has("google-antigravity")).toBe(true);
  });

  it("includes anthropic", () => {
    expect(KNOWN_OAUTH_PROVIDER_IDS.has("anthropic")).toBe(true);
  });

  it("does not include api-key-only providers", () => {
    expect(KNOWN_OAUTH_PROVIDER_IDS.has("openai")).toBe(false);
    expect(KNOWN_OAUTH_PROVIDER_IDS.has("mistral")).toBe(false);
    expect(KNOWN_OAUTH_PROVIDER_IDS.has("groq")).toBe(false);
  });
});

// ─── supportsOAuthLogin ───────────────────────────────────────────────────

describe("supportsOAuthLogin", () => {
  it("returns true for openai-codex even with empty dynamic provider list", () => {
    expect(supportsOAuthLogin("openai-codex", EMPTY_OAUTH)).toBe(true);
  });

  it("returns true for github-copilot even with empty dynamic provider list", () => {
    expect(supportsOAuthLogin("github-copilot", EMPTY_OAUTH)).toBe(true);
  });

  it("returns true for google-gemini-cli even with empty dynamic provider list", () => {
    expect(supportsOAuthLogin("google-gemini-cli", EMPTY_OAUTH)).toBe(true);
  });

  it("returns true for google-antigravity even with empty dynamic provider list", () => {
    expect(supportsOAuthLogin("google-antigravity", EMPTY_OAUTH)).toBe(true);
  });

  it("returns true for anthropic even with empty dynamic provider list", () => {
    expect(supportsOAuthLogin("anthropic", EMPTY_OAUTH)).toBe(true);
  });

  it("returns true for a provider only present in the dynamic list", () => {
    const dynamic = oauthMap([{ id: "some-new-oauth-provider" }]);
    expect(supportsOAuthLogin("some-new-oauth-provider", dynamic)).toBe(true);
  });

  it("returns false for a purely API-key provider with no dynamic entry", () => {
    expect(supportsOAuthLogin("openai", EMPTY_OAUTH)).toBe(false);
    expect(supportsOAuthLogin("groq", EMPTY_OAUTH)).toBe(false);
    expect(supportsOAuthLogin("mistral", EMPTY_OAUTH)).toBe(false);
  });

  it("returns false for an empty provider id", () => {
    expect(supportsOAuthLogin("", EMPTY_OAUTH)).toBe(false);
    expect(supportsOAuthLogin("   ", EMPTY_OAUTH)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(supportsOAuthLogin("OpenAI-Codex", EMPTY_OAUTH)).toBe(true);
    expect(supportsOAuthLogin("GITHUB-COPILOT", EMPTY_OAUTH)).toBe(true);
    const dynamic = oauthMap([{ id: "myoauthprovider" }]);
    expect(supportsOAuthLogin("MYOAUTHPROVIDER", dynamic)).toBe(true);
  });

  it("returns true when a provider appears in both static and dynamic lists", () => {
    const dynamic = oauthMap([{ id: "openai-codex" }]);
    expect(supportsOAuthLogin("openai-codex", dynamic)).toBe(true);
  });
});

// ─── selectDefaultAuthMethod ──────────────────────────────────────────────

describe("selectDefaultAuthMethod", () => {
  it("selects oauth for openai-codex even without a dynamic provider list", () => {
    expect(selectDefaultAuthMethod("openai-codex", EMPTY_OAUTH)).toBe("oauth");
  });

  it("selects oauth for github-copilot even without a dynamic provider list", () => {
    expect(selectDefaultAuthMethod("github-copilot", EMPTY_OAUTH)).toBe("oauth");
  });

  it("selects oauth for a provider that is only in the dynamic list", () => {
    const dynamic = oauthMap([{ id: "some-oauth-provider" }]);
    expect(selectDefaultAuthMethod("some-oauth-provider", dynamic)).toBe("oauth");
  });

  it("selects api_key for anthropic because subscription login is disabled", () => {
    expect(selectDefaultAuthMethod("anthropic", EMPTY_OAUTH)).toBe("api_key");
  });

  it("selects api_key for openai (no OAuth support)", () => {
    expect(selectDefaultAuthMethod("openai", EMPTY_OAUTH)).toBe("api_key");
  });

  it("selects api_key for an unknown provider", () => {
    expect(selectDefaultAuthMethod("unknown-provider-xyz", EMPTY_OAUTH)).toBe("api_key");
  });

  it("selects api_key for an empty provider id", () => {
    expect(selectDefaultAuthMethod("", EMPTY_OAUTH)).toBe("api_key");
  });
});

// ─── getStudioPiAuthMethodRestriction ──────────────────────────────────────

describe("getStudioPiAuthMethodRestriction", () => {
  it("disables anthropic oauth with an inline reason and hover details", () => {
    const restriction = getStudioPiAuthMethodRestriction("anthropic", "oauth");

    expect(restriction.disabled).toBe(true);
    expect(restriction.inlineReason).toContain("Claude Code");
    expect(restriction.hoverDetails).toContain("risk getting banned");
  });

  it("leaves anthropic api key auth enabled", () => {
    expect(getStudioPiAuthMethodRestriction("anthropic", "api_key")).toEqual({
      disabled: false,
    });
  });

  it("returns enabled for providers without a restriction", () => {
    expect(getStudioPiAuthMethodRestriction("openai-codex", "oauth")).toEqual({
      disabled: false,
    });
  });
});

// ─── resolveProviderLabel ─────────────────────────────────────────────────

describe("resolveProviderLabel", () => {
  it("uses the dynamic OAuth provider name when available", () => {
    const dynamic = oauthMap([{ id: "openai-codex", name: "OpenAI Codex Dynamic Name" }]);
    expect(resolveProviderLabel("openai-codex", dynamic)).toBe("OpenAI Codex Dynamic Name");
  });

  it("falls back to PROVIDER_LABEL_OVERRIDES when not in dynamic list", () => {
    for (const [id, label] of Object.entries(PROVIDER_LABEL_OVERRIDES)) {
      expect(resolveProviderLabel(id, EMPTY_OAUTH)).toBe(label);
    }
  });

  it("falls back to the raw normalized id when no override exists", () => {
    expect(resolveProviderLabel("some-unknown-provider", EMPTY_OAUTH)).toBe("some-unknown-provider");
  });

  it("returns 'Unknown provider' for an empty id", () => {
    expect(resolveProviderLabel("", EMPTY_OAUTH)).toBe("Unknown provider");
    expect(resolveProviderLabel("   ", EMPTY_OAUTH)).toBe("Unknown provider");
  });

  it("is case-insensitive for label overrides", () => {
    expect(resolveProviderLabel("Anthropic", EMPTY_OAUTH)).toBe("Anthropic");
    expect(resolveProviderLabel("OPENAI", EMPTY_OAUTH)).toBe("OpenAI");
  });

  it("prefers dynamic name even when a PROVIDER_LABEL_OVERRIDE exists", () => {
    const dynamic = oauthMap([{ id: "github-copilot", name: "GitHub Copilot (Enterprise)" }]);
    expect(resolveProviderLabel("github-copilot", dynamic)).toBe("GitHub Copilot (Enterprise)");
  });
});

// ─── buildApiKeyHint ─────────────────────────────────────────────────────

describe("buildApiKeyHint", () => {
  it("uses PROVIDER_AUTH_HINT_OVERRIDES for amazon-bedrock", () => {
    expect(buildApiKeyHint("amazon-bedrock", undefined)).toBe(
      PROVIDER_AUTH_HINT_OVERRIDES["amazon-bedrock"]
    );
  });

  it("uses PROVIDER_AUTH_HINT_OVERRIDES for google-vertex", () => {
    expect(buildApiKeyHint("google-vertex", undefined)).toBe(
      PROVIDER_AUTH_HINT_OVERRIDES["google-vertex"]
    );
  });

  it("includes the env var name when provided", () => {
    const hint = buildApiKeyHint("anthropic", "ANTHROPIC_API_KEY");
    expect(hint).toContain("ANTHROPIC_API_KEY");
  });

  it("returns a generic paste hint when no env var is known", () => {
    const hint = buildApiKeyHint("some-custom-provider", undefined);
    expect(hint.toLowerCase()).toContain("api key");
  });
});

// ─── getApiKeyEnvVarForProvider ──────────────────────────────────────────

describe("getApiKeyEnvVarForProvider", () => {
  it("maps anthropic to ANTHROPIC_API_KEY", () => {
    expect(getApiKeyEnvVarForProvider("anthropic")).toBe("ANTHROPIC_API_KEY");
  });

  it("maps openai to OPENAI_API_KEY", () => {
    expect(getApiKeyEnvVarForProvider("openai")).toBe("OPENAI_API_KEY");
  });

  it("maps google to GEMINI_API_KEY", () => {
    expect(getApiKeyEnvVarForProvider("google")).toBe("GEMINI_API_KEY");
  });

  it("does not have entries for pure-OAuth providers", () => {
    // These providers use OAuth, not API keys, so should not be in this map
    expect(getApiKeyEnvVarForProvider("openai-codex")).toBe("");
    expect(getApiKeyEnvVarForProvider("github-copilot")).toBe("");
    expect(getApiKeyEnvVarForProvider("google-gemini-cli")).toBe("");
    expect(getApiKeyEnvVarForProvider("google-antigravity")).toBe("");
  });
});
