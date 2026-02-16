import type SystemSculptPlugin from "../../main";
import type { SystemSculptSettings } from "../../types";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  getDefaultImageAspectRatio,
  type ImageGenerationServerCatalogModel,
} from "./ImageGenerationModelCatalog";

export type CanvasFlowPromptDefaults = {
  modelId: string;
  imageCount: number;
  aspectRatio: string;
};

export type CanvasFlowPromptDefaultsSource = "command" | "image-node";

type CanvasFlowLastUsedState = {
  modelId: string;
  imageCount: number;
  aspectRatio: string;
};

type CanvasFlowLastUsedPatch = {
  modelId?: string;
  imageCount?: unknown;
  aspectRatio?: string;
};

const NANO_BANANA_MODEL_ID = "google/nano-banana-pro";
const MIN_IMAGE_COUNT = 1;
const MAX_IMAGE_COUNT = 4;

let runtimeLastUsedPatch: Partial<CanvasFlowLastUsedState> = {};
let persistenceQueue: Promise<void> = Promise.resolve();

function clampImageCount(value: number): number {
  return Math.max(MIN_IMAGE_COUNT, Math.min(MAX_IMAGE_COUNT, Math.floor(value)));
}

function sanitizeModelId(value: unknown): string {
  return String(value || "").trim();
}

function sanitizeAspectRatio(value: unknown): string {
  return String(value || "").trim();
}

function sanitizeImageCountState(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return MIN_IMAGE_COUNT;
  }
  return clampImageCount(parsed);
}

function sanitizeImageCountPatch(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return clampImageCount(parsed);
}

function readStateFromSettings(
  settings: Pick<
    SystemSculptSettings,
    | "imageGenerationLastUsedModelId"
    | "imageGenerationLastUsedCount"
    | "imageGenerationLastUsedAspectRatio"
  >
): CanvasFlowLastUsedState {
  return {
    modelId: sanitizeModelId(settings.imageGenerationLastUsedModelId),
    imageCount: sanitizeImageCountState(settings.imageGenerationLastUsedCount),
    aspectRatio: sanitizeAspectRatio(settings.imageGenerationLastUsedAspectRatio),
  };
}

function toSettingsPatch(patch: Partial<CanvasFlowLastUsedState>): Partial<SystemSculptSettings> {
  const update: Partial<SystemSculptSettings> = {};
  if (Object.prototype.hasOwnProperty.call(patch, "modelId")) {
    update.imageGenerationLastUsedModelId = sanitizeModelId(patch.modelId);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "imageCount")) {
    update.imageGenerationLastUsedCount = sanitizeImageCountState(patch.imageCount);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "aspectRatio")) {
    update.imageGenerationLastUsedAspectRatio = sanitizeAspectRatio(patch.aspectRatio);
  }
  return update;
}

export function getCanvasFlowLastUsedState(
  settings: Pick<
    SystemSculptSettings,
    | "imageGenerationLastUsedModelId"
    | "imageGenerationLastUsedCount"
    | "imageGenerationLastUsedAspectRatio"
  >
): CanvasFlowLastUsedState {
  const stored = readStateFromSettings(settings);
  return {
    modelId:
      runtimeLastUsedPatch.modelId !== undefined
        ? sanitizeModelId(runtimeLastUsedPatch.modelId)
        : stored.modelId,
    imageCount:
      runtimeLastUsedPatch.imageCount !== undefined
        ? sanitizeImageCountState(runtimeLastUsedPatch.imageCount)
        : stored.imageCount,
    aspectRatio:
      runtimeLastUsedPatch.aspectRatio !== undefined
        ? sanitizeAspectRatio(runtimeLastUsedPatch.aspectRatio)
        : stored.aspectRatio,
  };
}

export function resolveCanvasFlowPromptDefaults(options: {
  settings: Pick<
    SystemSculptSettings,
    | "imageGenerationDefaultModelId"
    | "imageGenerationLastUsedModelId"
    | "imageGenerationLastUsedCount"
    | "imageGenerationLastUsedAspectRatio"
  >;
  source: CanvasFlowPromptDefaultsSource;
  serverModels?: readonly ImageGenerationServerCatalogModel[];
}): CanvasFlowPromptDefaults {
  const lastUsed = getCanvasFlowLastUsedState(options.settings);

  const settingsModelId = sanitizeModelId(options.settings.imageGenerationDefaultModelId);
  const modelId = lastUsed.modelId || settingsModelId || DEFAULT_IMAGE_GENERATION_MODEL_ID;

  const imageCount = sanitizeImageCountState(lastUsed.imageCount);

  let aspectRatio = sanitizeAspectRatio(lastUsed.aspectRatio);
  if (!aspectRatio) {
    if (options.source === "image-node" && modelId === NANO_BANANA_MODEL_ID) {
      aspectRatio = "match_input_image";
    } else {
      aspectRatio = getDefaultImageAspectRatio(modelId, options.serverModels);
    }
  }

  return {
    modelId,
    imageCount,
    aspectRatio,
  };
}

export function queueCanvasFlowLastUsedPatch(
  plugin: Pick<SystemSculptPlugin, "getSettingsManager">,
  patch: CanvasFlowLastUsedPatch
): Promise<void> {
  const nextPatch: Partial<CanvasFlowLastUsedState> = {};

  if (Object.prototype.hasOwnProperty.call(patch, "modelId")) {
    nextPatch.modelId = sanitizeModelId(patch.modelId);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "imageCount")) {
    const parsed = sanitizeImageCountPatch(patch.imageCount);
    if (parsed !== null) {
      nextPatch.imageCount = parsed;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "aspectRatio")) {
    nextPatch.aspectRatio = sanitizeAspectRatio(patch.aspectRatio);
  }

  if (Object.keys(nextPatch).length === 0) {
    return Promise.resolve();
  }

  runtimeLastUsedPatch = {
    ...runtimeLastUsedPatch,
    ...nextPatch,
  };

  const settingsPatch = toSettingsPatch(nextPatch);
  persistenceQueue = persistenceQueue
    .catch(() => {})
    .then(async () => {
      await plugin.getSettingsManager().updateSettings(settingsPatch);
    })
    .catch(() => {});

  return persistenceQueue;
}

export function __resetCanvasFlowPromptDefaultsRuntimeForTests(): void {
  runtimeLastUsedPatch = {};
  persistenceQueue = Promise.resolve();
}
