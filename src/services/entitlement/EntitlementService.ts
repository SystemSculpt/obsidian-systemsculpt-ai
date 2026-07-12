import type SystemSculptPlugin from "../../main";
import { ensureCanonicalId } from "../../utils/modelUtils";
import {
  getManagedSystemSculptModelId,
  hasActiveSystemSculptLicense,
  isManagedSystemSculptModelId,
} from "../systemsculpt/ManagedSystemSculptModel";
import {
  listConfiguredRemoteProviderModels,
  normalizeProviderId,
} from "../providerRuntime/RemoteProviderCatalog";

export type ChatEntitlementReason = "license";

export type ChatEntitlement = {
  allowed: boolean;
  /** Why chat is blocked, when it is. Drives messaging, never the wall itself. */
  reason?: ChatEntitlementReason;
};

/**
 * Single owner of chat and recorder/transcription gating decisions (issue #209).
 * UI components must consult this service instead of
 * inlining `licenseKey && licenseValid` or deciding "the managed model needs a
 * license" themselves — that scattering is exactly what made a BYOK user with a
 * working custom provider hit a SystemSculpt license wall on Chat (the May 2026
 * report) just because the managed model happened to be the default selection.
 *
 * Stateless by design: every method reads the live plugin settings, so a
 * license that validates mid-session — or a provider key added in Settings —
 * takes effect on the very next call without cache invalidation.
 */
export class EntitlementService {
  constructor(private readonly plugin: Pick<SystemSculptPlugin, "settings">) {}

  /** The one true SystemSculpt-license predicate. */
  hasSystemSculptLicense(): boolean {
    return hasActiveSystemSculptLicense(this.plugin);
  }

  /**
   * Custom-provider (BYOK) seed model ids the user can actually use right now —
   * i.e. a provider configured with an API key and not disabled. This is the
   * same signal the #201 catalog guard locks, so "the user is a BYOK user" has
   * exactly one definition across the plugin.
   */
  listUsableCustomProviderModelIds(): string[] {
    return listConfiguredRemoteProviderModels(this.plugin as SystemSculptPlugin).map(
      (model) => model.id,
    );
  }

  hasUsableCustomProviderModel(): boolean {
    return this.listUsableCustomProviderModelIds().length > 0;
  }

  /** The managed model needs a license; every BYOK/custom/local model is always usable. */
  canUseModel(modelId?: string | null): boolean {
    return isManagedSystemSculptModelId(modelId) ? this.hasSystemSculptLicense() : true;
  }

  /**
   * The model chat should actually run on. A BYOK user with no license is never
   * forced onto the license-walled managed model: when the (selected or default)
   * model is the managed one, there is no license, and a custom provider IS
   * configured, this resolves to that custom model instead. Otherwise it returns
   * the normal effective id. Pure — never mutates the stored selection (the
   * persisted default stays the managed model, per the #215 bundle-load guard).
   */
  resolveDefaultModel(selectedModelId?: string | null, fallbackModelId?: string | null): string {
    // Mirror getEffectiveChatModelId without importing it (avoids a chatview <-> service cycle).
    const effectiveId =
      ensureCanonicalId(String(selectedModelId || "").trim()) ||
      ensureCanonicalId(String(fallbackModelId || "").trim()) ||
      getManagedSystemSculptModelId();

    if (isManagedSystemSculptModelId(effectiveId) && !this.hasSystemSculptLicense()) {
      const [alternative] = this.listUsableCustomProviderModelIds();
      if (alternative) {
        return alternative;
      }
    }
    return effectiveId;
  }

  /**
   * Entitlement for chat with the current selection. The BYOK fallback is
   * resolved first, so a user with a working custom provider is always `allowed`
   * and never sees a license wall. The only blocked case is a user with NO
   * license AND no custom provider — for whom activating a license (or adding a
   * provider) is the genuine fix.
   */
  canUseChat(selectedModelId?: string | null, fallbackModelId?: string | null): ChatEntitlement {
    const effectiveId = this.resolveDefaultModel(selectedModelId, fallbackModelId);
    return this.canUseModel(effectiveId) ? { allowed: true } : { allowed: false, reason: "license" };
  }

  /** Transcription/recorder: same rule — only the systemsculpt provider needs a license. */
  canUseTranscription(providerId?: string | null): boolean {
    return this.providerNeedsLicense(providerId) ? this.hasSystemSculptLicense() : true;
  }

  private providerNeedsLicense(providerId?: string | null): boolean {
    return normalizeProviderId(providerId) === "systemsculpt";
  }
}
