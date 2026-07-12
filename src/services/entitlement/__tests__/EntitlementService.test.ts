/**
 * Issue #209 — the entitlement/gating service is the single owner of every
 * gating decision for chat and recorder/transcription. UI must never
 * inline `licenseKey && licenseValid` or decide "managed needs a license"
 * itself — it asks this service.
 *
 * The load-bearing behavior the bug report (May 2026) demanded: a BYOK user
 * with a working custom provider and NO SystemSculpt license must never be
 * walled out of chat just because the managed model is the selected/default
 * one. The matrix below locks that: license × custom-providers × selected-model
 * × feature.
 */
import { EntitlementService } from "../EntitlementService";
import { SYSTEMSCULPT_PI_CANONICAL_MODEL_ID } from "../../pi/PiCanonicalIds";
import { createCanonicalId } from "../../../utils/modelUtils";

const MANAGED_ID = SYSTEMSCULPT_PI_CANONICAL_MODEL_ID;
const OPENROUTER_ID = createCanonicalId("openrouter", "openai/gpt-5.4-mini");

const KEYED_OPENROUTER = [
  {
    id: "openrouter",
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "fixture-key",
    isEnabled: true,
  },
];

type StubConfig = {
  licenseKey?: string;
  licenseValid?: boolean;
  customProviders?: unknown[];
};

function entitlement(config: StubConfig = {}): EntitlementService {
  const plugin = {
    settings: {
      licenseKey: config.licenseKey ?? "",
      licenseValid: config.licenseValid ?? false,
      customProviders: config.customProviders ?? [],
    },
  } as never;
  return new EntitlementService(plugin);
}

const LICENSED = { licenseKey: "valid-key", licenseValid: true } as const;

describe("EntitlementService — license source of truth", () => {
  it("holds a license only when key is non-empty AND licenseValid is true", () => {
    expect(entitlement(LICENSED).hasSystemSculptLicense()).toBe(true);
    expect(entitlement({ licenseKey: "  ", licenseValid: true }).hasSystemSculptLicense()).toBe(false);
    expect(entitlement({ licenseKey: "k", licenseValid: false }).hasSystemSculptLicense()).toBe(false);
    expect(entitlement({}).hasSystemSculptLicense()).toBe(false);
  });
});

describe("EntitlementService — custom provider availability", () => {
  it("reports a usable custom-provider model only when one is keyed and enabled", () => {
    expect(entitlement({ customProviders: KEYED_OPENROUTER }).hasUsableCustomProviderModel()).toBe(true);
    expect(entitlement({}).hasUsableCustomProviderModel()).toBe(false);
    expect(
      entitlement({ customProviders: [{ id: "openrouter", apiKey: "", isEnabled: true }] }).hasUsableCustomProviderModel(),
    ).toBe(false);
    expect(
      entitlement({ customProviders: [{ id: "openrouter", apiKey: "k", isEnabled: false }] }).hasUsableCustomProviderModel(),
    ).toBe(false);
  });

  it("lists the configured custom-provider model ids", () => {
    expect(entitlement({ customProviders: KEYED_OPENROUTER }).listUsableCustomProviderModelIds()).toContain(
      OPENROUTER_ID,
    );
    expect(entitlement({}).listUsableCustomProviderModelIds()).toEqual([]);
  });
});

describe("EntitlementService — canUseModel", () => {
  it("requires a license for the managed model, never for custom/BYOK models", () => {
    expect(entitlement(LICENSED).canUseModel(MANAGED_ID)).toBe(true);
    expect(entitlement({}).canUseModel(MANAGED_ID)).toBe(false);
    // Custom/BYOK model is always usable regardless of license.
    expect(entitlement({}).canUseModel(OPENROUTER_ID)).toBe(true);
    expect(entitlement(LICENSED).canUseModel(OPENROUTER_ID)).toBe(true);
  });
});

describe("EntitlementService — resolveDefaultModel (BYOK fallback)", () => {
  it("keeps the managed model when licensed", () => {
    expect(entitlement({ ...LICENSED, customProviders: KEYED_OPENROUTER }).resolveDefaultModel(MANAGED_ID)).toBe(
      MANAGED_ID,
    );
  });

  it("falls back to a custom-provider model when managed is selected, no license, and a custom provider exists", () => {
    expect(
      entitlement({ customProviders: KEYED_OPENROUTER }).resolveDefaultModel(MANAGED_ID),
    ).toBe(OPENROUTER_ID);
  });

  it("stays on the managed model when there is no license AND no custom provider (license wall is then correct)", () => {
    expect(entitlement({}).resolveDefaultModel(MANAGED_ID)).toBe(MANAGED_ID);
  });

  it("never rewrites an explicit custom selection", () => {
    expect(entitlement({ customProviders: KEYED_OPENROUTER }).resolveDefaultModel(OPENROUTER_ID)).toBe(OPENROUTER_ID);
  });

  it("resolves the managed default for an empty selection (parity with getEffectiveChatModelId)", () => {
    expect(entitlement({}).resolveDefaultModel("")).toBe(MANAGED_ID);
    expect(entitlement({}).resolveDefaultModel(null, null)).toBe(MANAGED_ID);
  });
});

describe("EntitlementService — canUseChat (the bug surface)", () => {
  it("allows chat for a licensed user on the managed model", () => {
    expect(entitlement(LICENSED).canUseChat(MANAGED_ID).allowed).toBe(true);
  });

  it("allows a BYOK-no-license user to chat (resolved onto their custom model) — NEVER a license wall", () => {
    const result = entitlement({ customProviders: KEYED_OPENROUTER }).canUseChat(MANAGED_ID);
    expect(result.allowed).toBe(true);
  });

  it("blocks only when there is no license AND no custom alternative", () => {
    const result = entitlement({}).canUseChat(MANAGED_ID);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("license");
  });

  it("allows chat on an explicit custom model regardless of license", () => {
    expect(entitlement({ customProviders: KEYED_OPENROUTER }).canUseChat(OPENROUTER_ID).allowed).toBe(true);
  });
});

describe("EntitlementService — transcription feature gate", () => {
  it("gates the managed/systemsculpt provider on a license but never a custom provider", () => {

    expect(entitlement(LICENSED).canUseTranscription("systemsculpt")).toBe(true);
    expect(entitlement({}).canUseTranscription("systemsculpt")).toBe(false);
    expect(entitlement({}).canUseTranscription("openai")).toBe(true);
  });
});
