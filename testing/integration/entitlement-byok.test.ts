/**
 * Issue #209 — integration guard. A BYOK-only user (a configured custom
 * provider, NO SystemSculpt license) must get a working chat model and never be
 * gated by a license, proven end-to-end across the REAL model catalog (#201)
 * and the entitlement service together — not just in isolated unit mocks. This
 * is the "completes a chat without ever seeing a license prompt" acceptance,
 * verified at the integration layer (no Obsidian host, no secrets).
 *
 * Platform flags are forced to mobile for determinism, mirroring the #201
 * provider-listing guard: the desktop-only catalog branch scans local Pi auth
 * on the host, which is not reproducible in CI. The managed + remote-seed paths
 * exercised here are platform-independent.
 */
import { Platform } from "obsidian";

import { listPiTextCatalogModels } from "src/services/pi-native/PiTextCatalog";
import { EntitlementService } from "src/services/entitlement/EntitlementService";
import { SYSTEMSCULPT_PI_CANONICAL_MODEL_ID } from "src/services/pi/PiCanonicalIds";
import { createCanonicalId } from "src/utils/modelUtils";

const MANAGED_ID = SYSTEMSCULPT_PI_CANONICAL_MODEL_ID;
const OPENROUTER_SEED_MODEL_ID = createCanonicalId("openrouter", "openai/gpt-5.4-mini");

const KEYED_OPENROUTER = [
  {
    id: "openrouter",
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "fixture-key",
    isEnabled: true,
  },
];

function buildPluginStub(opts: {
  licenseKey?: string;
  licenseValid?: boolean;
  customProviders?: unknown[];
}) {
  return {
    settings: {
      // The shipped default selection is always the managed model (#215 guard).
      selectedModelId: MANAGED_ID,
      licenseKey: opts.licenseKey ?? "",
      licenseValid: opts.licenseValid ?? false,
      customProviders: opts.customProviders ?? [],
    },
    manifest: { version: "0.0.0" },
    getLogger: () => ({ warn() {}, info() {}, error() {} }),
  } as never;
}

describe("entitlement BYOK chat (#209 integration guard)", () => {
  const platformAny = Platform as unknown as Record<string, boolean>;
  let savedFlags: Record<string, boolean>;

  beforeAll(() => {
    savedFlags = { ...platformAny };
    platformAny.isDesktop = false;
    platformAny.isDesktopApp = false;
    platformAny.isMobile = true;
    platformAny.isMobileApp = true;
  });

  afterAll(() => {
    Object.assign(platformAny, savedFlags);
  });

  it("resolves a no-license BYOK user onto their custom model and allows chat (no license wall)", async () => {
    const plugin = buildPluginStub({ customProviders: KEYED_OPENROUTER });
    const entitlement = new EntitlementService(plugin);

    // No SystemSculpt license — but a keyed custom provider IS configured.
    expect(entitlement.hasSystemSculptLicense()).toBe(false);

    // The managed default is NOT forced on them: chat resolves onto their BYOK model.
    const resolved = entitlement.resolveDefaultModel(MANAGED_ID, MANAGED_ID);
    expect(resolved).toBe(OPENROUTER_SEED_MODEL_ID);

    // Chat is allowed end-to-end — the user never hits a license prompt.
    expect(entitlement.canUseChat(MANAGED_ID, MANAGED_ID).allowed).toBe(true);

    // Cohesion with the real catalog: the resolved fallback is a model the
    // dropdown actually lists, not a phantom id.
    const catalog = await listPiTextCatalogModels(plugin);
    expect(catalog.map((model) => model.id)).toContain(resolved);
  });

  it("keeps a user with no license AND no custom provider on managed, blocked (the wall is then correct)", () => {
    const plugin = buildPluginStub({});
    const entitlement = new EntitlementService(plugin);

    expect(entitlement.resolveDefaultModel(MANAGED_ID, MANAGED_ID)).toBe(MANAGED_ID);
    const chat = entitlement.canUseChat(MANAGED_ID, MANAGED_ID);
    expect(chat.allowed).toBe(false);
    expect(chat.reason).toBe("license");
  });
});
