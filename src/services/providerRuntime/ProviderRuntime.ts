import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import { supportsImages, supportsTools } from "../../utils/modelUtils";
import { PlatformContext } from "../PlatformContext";
import { buildPiTextProviderSetupMessage, hasPiTextProviderAuth } from "../pi-native/PiTextAuth";
import { assertPiTextExecutionReady } from "../pi-native/PiTextRuntime";
import { resolveRemoteProviderEndpoint } from "./RemoteProviderCatalog";
import { resolveStudioPiProviderApiKey } from "../../studio/piAuth/StudioPiAuthStorage";

export type ProviderRuntimePlan = {
  mode: "local" | "remote";
  actualModelId: string;
  providerId: string;
  authMode: "local" | "byok";
  endpoint?: string;
  supportsTools: boolean;
  supportsImages: boolean;
};

function normalizeProviderId(model: SystemSculptModel, actualModelId: string): string {
  return (
    String(model.sourceProviderId || "").trim() ||
    String(model.provider || "").trim() ||
    String(actualModelId || "").split("/")[0] ||
    "unknown"
  );
}

export async function resolveProviderRuntimePlan(
  model: SystemSculptModel,
  plugin?: SystemSculptPlugin,
): Promise<ProviderRuntimePlan> {
  if (model.sourceMode === "pi_local") {
    const plan = await assertPiTextExecutionReady(model);
    return {
      mode: plan.mode,
      actualModelId: plan.actualModelId,
      providerId: plan.providerId,
      authMode: plan.authMode,
      supportsTools: supportsTools(model),
      supportsImages: supportsImages(model),
    };
  }

  if (model.sourceMode === "custom_endpoint" && model.piRemoteAvailable) {
    const actualModelId = String(model.piExecutionModelId || "").trim();
    if (!actualModelId) {
      throw new Error(`Model "${model.id}" is missing a remote execution model id.`);
    }
    const providerId = normalizeProviderId(model, actualModelId);
    const resolvedApiKey = await resolveStudioPiProviderApiKey(providerId, { plugin });
    const hasAuth = (resolvedApiKey && resolvedApiKey.length > 0) || await hasPiTextProviderAuth(providerId, plugin);
    if (!hasAuth) {
      throw new Error(buildPiTextProviderSetupMessage(providerId, actualModelId));
    }
    const endpoint = resolveRemoteProviderEndpoint(providerId);
    if (!endpoint) {
      throw new Error(`No remote endpoint is configured for provider "${providerId}".`);
    }
    return {
      mode: "remote",
      actualModelId,
      providerId,
      authMode: "byok",
      endpoint,
      supportsTools: supportsTools(model),
      supportsImages: supportsImages(model),
    };
  }

  throw new Error(
    PlatformContext.get().supportsDesktopOnlyFeatures()
      ? "The selected model is not configured for provider-backed execution."
      : "The selected model is not available for mobile provider-backed execution.",
  );
}

export async function ensureProviderRuntimeReady(
  model: SystemSculptModel,
  plugin?: SystemSculptPlugin,
): Promise<ProviderRuntimePlan> {
  return await resolveProviderRuntimePlan(model, plugin);
}
