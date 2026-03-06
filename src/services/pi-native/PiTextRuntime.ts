import { Platform } from "obsidian";
import type { SystemSculptModel } from "../../types/llm";

export type PiTextExecutionPlan = {
  mode: "local";
  actualModelId: string;
};

function requireActualModelId(model: SystemSculptModel): string {
  const actualModelId = String(model.piExecutionModelId || "").trim();
  if (!actualModelId) {
    throw new Error(`Model "${model.id}" is missing a Pi execution model id.`);
  }
  return actualModelId;
}

export function shouldUseLocalPiExecution(model: SystemSculptModel): boolean {
  return Platform.isDesktopApp && !!model.piLocalAvailable;
}

export async function resolvePiTextExecutionPlan(
  model: SystemSculptModel
): Promise<PiTextExecutionPlan> {
  const actualModelId = requireActualModelId(model);

  if (!Platform.isDesktopApp) {
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
  };
}
