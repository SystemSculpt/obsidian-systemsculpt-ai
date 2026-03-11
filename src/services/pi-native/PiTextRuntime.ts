import type { SystemSculptModel } from "../../types/llm";
import { PlatformContext } from "../PlatformContext";

export type PiTextExecutionPlan = {
  mode: "local";
  actualModelId: string;
  providerId: string;
  authMode: "local";
};

function supportsDesktopPiFeatures(): boolean {
  return PlatformContext.get().supportsDesktopOnlyFeatures();
}

function requireActualModelId(model: SystemSculptModel): string {
  const actualModelId = String(model.piExecutionModelId || "").trim();
  if (!actualModelId) {
    throw new Error(`Model "${model.id}" is missing a Pi execution model id.`);
  }
  return actualModelId;
}

function resolveProviderId(model: SystemSculptModel, actualModelId: string): string {
  return (
    String(model.sourceProviderId || "").trim() ||
    String(model.provider || "").trim() ||
    actualModelId.split("/")[0] ||
    "unknown"
  );
}

export function shouldUseLocalPiExecution(model: SystemSculptModel): boolean {
  return supportsDesktopPiFeatures() && model.sourceMode === "pi_local" && !!model.piLocalAvailable;
}

export async function resolvePiTextExecutionPlan(
  model: SystemSculptModel
): Promise<PiTextExecutionPlan> {
  const actualModelId = requireActualModelId(model);
  const providerId = resolveProviderId(model, actualModelId);

  if (!supportsDesktopPiFeatures()) {
    throw new Error("Pi desktop text generation is only available in the desktop app.");
  }

  if (!model.piLocalAvailable) {
    throw new Error(
      `Pi desktop mode requires a locally available Pi model. "${actualModelId}" is not available in the local Pi runtime.`
    );
  }

  return {
    mode: "local",
    actualModelId,
    providerId,
    authMode: "local",
  };
}

export async function assertPiTextExecutionReady(
  model: SystemSculptModel
): Promise<PiTextExecutionPlan> {
  return await resolvePiTextExecutionPlan(model);
}
