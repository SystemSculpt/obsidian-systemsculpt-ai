/**
 * Regression guard for issue #201 — providers disappearing from the model
 * dropdown. Locks the two invariants of the text model catalog:
 *
 *   1. The managed SystemSculpt model is ALWAYS present (first entry),
 *      license or not, providers configured or not.
 *   2. A BYOK custom provider with an API key (e.g. OpenRouter) makes its
 *      remote seed model appear; removing the key or disabling the provider
 *      makes it disappear without touching the managed model.
 *
 * Platform flags are forced to mobile for determinism: the desktop-only
 * branch of the catalog scans local Pi provider auth state on the host
 * machine, which is not reproducible in CI. The managed + remote-seed paths
 * asserted here are platform-independent.
 */
import { Platform } from "obsidian";

import { listPiTextCatalogModels } from "src/services/pi-native/PiTextCatalog";
import { SYSTEMSCULPT_PI_CANONICAL_MODEL_ID } from "src/services/pi/PiCanonicalIds";
import { createCanonicalId } from "src/utils/modelUtils";

const { startProviderFixtures } = require("../fixtures/providers/index.cjs");

type Fixtures = Awaited<ReturnType<typeof startProviderFixtures>>;

const OPENROUTER_SEED_MODEL_ID = createCanonicalId("openrouter", "openai/gpt-5.4-mini");
const OPENAI_SEED_MODEL_ID = createCanonicalId("openai", "gpt-5.4-mini");
const ANTHROPIC_SEED_MODEL_ID = createCanonicalId("anthropic", "claude-sonnet-4-6");
const GOOGLE_SEED_MODEL_ID = createCanonicalId("google", "gemini-3-flash-preview");

function buildPluginStub(customProviders: unknown[] = []) {
  return {
    settings: { customProviders },
    manifest: { version: "0.0.0" },
    getLogger: () => ({
      warn: () => {},
      info: () => {},
      error: () => {},
    }),
  } as never;
}

describe("text model catalog (#201 guard)", () => {
  let fixtures: Fixtures;
  const platformAny = Platform as unknown as Record<string, boolean>;
  let savedFlags: Record<string, boolean>;

  beforeAll(async () => {
    fixtures = await startProviderFixtures();
    savedFlags = { ...platformAny };
    platformAny.isDesktop = false;
    platformAny.isDesktopApp = false;
    platformAny.isMobile = true;
    platformAny.isMobileApp = true;
  });

  afterAll(async () => {
    Object.assign(platformAny, savedFlags);
    await fixtures.close();
  });

  it("always lists the managed model first, even with no providers configured", async () => {
    const models = await listPiTextCatalogModels(buildPluginStub());
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe(SYSTEMSCULPT_PI_CANONICAL_MODEL_ID);
  });

  it("lists the OpenRouter seed model when a keyed custom provider is configured", async () => {
    const models = await listPiTextCatalogModels(
      buildPluginStub([
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: fixtures.openrouter.url,
          apiKey: "fixture-key",
          isEnabled: true,
        },
      ])
    );

    const ids = models.map((model) => model.id);
    expect(ids[0]).toBe(SYSTEMSCULPT_PI_CANONICAL_MODEL_ID);
    expect(ids).toContain(OPENROUTER_SEED_MODEL_ID);

    const seed = models.find((model) => model.id === OPENROUTER_SEED_MODEL_ID);
    expect(seed?.piAuthMode).toBe("byok");
    expect(seed?.provider).toBe("openrouter");
  });

  it("lists the OpenAI seed model when a keyed custom provider is configured (#201)", async () => {
    const models = await listPiTextCatalogModels(
      buildPluginStub([
        {
          id: "openai",
          name: "OpenAI",
          endpoint: "https://api.openai.com/v1",
          apiKey: "fixture-key",
          isEnabled: true,
        },
      ])
    );

    const ids = models.map((model) => model.id);
    expect(ids[0]).toBe(SYSTEMSCULPT_PI_CANONICAL_MODEL_ID);
    expect(ids).toContain(OPENAI_SEED_MODEL_ID);

    const seed = models.find((model) => model.id === OPENAI_SEED_MODEL_ID);
    expect(seed?.piAuthMode).toBe("byok");
    expect(seed?.provider).toBe("openai");
  });

  it("lists the Claude seed model when a keyed Anthropic provider is configured (#230)", async () => {
    const models = await listPiTextCatalogModels(
      buildPluginStub([
        {
          id: "anthropic",
          name: "Anthropic",
          endpoint: "https://api.anthropic.com/v1",
          apiKey: "fixture-key",
          isEnabled: true,
        },
      ])
    );

    const ids = models.map((model) => model.id);
    expect(ids[0]).toBe(SYSTEMSCULPT_PI_CANONICAL_MODEL_ID);
    expect(ids).toContain(ANTHROPIC_SEED_MODEL_ID);

    const seed = models.find((model) => model.id === ANTHROPIC_SEED_MODEL_ID);
    expect(seed?.piAuthMode).toBe("byok");
    expect(seed?.provider).toBe("anthropic");
  });

  it("lists the Gemini seed model when a keyed Google provider is configured (#231)", async () => {
    const models = await listPiTextCatalogModels(
      buildPluginStub([
        {
          id: "google",
          name: "Google Gemini",
          endpoint: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "fixture-key",
          isEnabled: true,
        },
      ])
    );

    const ids = models.map((model) => model.id);
    expect(ids[0]).toBe(SYSTEMSCULPT_PI_CANONICAL_MODEL_ID);
    expect(ids).toContain(GOOGLE_SEED_MODEL_ID);

    const seed = models.find((model) => model.id === GOOGLE_SEED_MODEL_ID);
    expect(seed?.piAuthMode).toBe("byok");
    expect(seed?.provider).toBe("google");
  });

  it("drops the seed model when the provider has no API key", async () => {
    const models = await listPiTextCatalogModels(
      buildPluginStub([
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: fixtures.openrouter.url,
          apiKey: "",
          isEnabled: true,
        },
      ])
    );

    const ids = models.map((model) => model.id);
    expect(ids).not.toContain(OPENROUTER_SEED_MODEL_ID);
    expect(ids[0]).toBe(SYSTEMSCULPT_PI_CANONICAL_MODEL_ID);
  });

  it("drops the seed model when the provider is disabled", async () => {
    const models = await listPiTextCatalogModels(
      buildPluginStub([
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: fixtures.openrouter.url,
          apiKey: "fixture-key",
          isEnabled: false,
        },
      ])
    );

    expect(models.map((model) => model.id)).not.toContain(OPENROUTER_SEED_MODEL_ID);
  });
});
