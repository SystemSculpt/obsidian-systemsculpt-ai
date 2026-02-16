import type { CanvasFlowPromptConfig } from "./PromptNote";
import {
  deriveCanvasFlowPromptUiDefaults,
  type CanvasFlowNanoDefaults,
} from "./CanvasFlowPromptNodeState";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  getDefaultImageAspectRatio,
  type ImageGenerationServerCatalogModel,
} from "./ImageGenerationModelCatalog";

export type CanvasFlowPromptDraft = {
  body: string;
  explicitModel: string;
  seedText: string;
  imageCount: number;
  aspectRatioPreset: string;
  widthText: string;
  heightText: string;
  nano: CanvasFlowNanoDefaults;
};

export type CanvasFlowPromptDraftEntry = {
  promptPath: string;
  sourceMtime: number;
  dirty: boolean;
  draft: CanvasFlowPromptDraft;
};

export function cloneCanvasFlowPromptDraft(draft: CanvasFlowPromptDraft): CanvasFlowPromptDraft {
  return {
    body: String(draft.body || ""),
    explicitModel: String(draft.explicitModel || ""),
    seedText: String(draft.seedText || ""),
    imageCount: clampImageCount(draft.imageCount),
    aspectRatioPreset: String(draft.aspectRatioPreset || ""),
    widthText: String(draft.widthText || ""),
    heightText: String(draft.heightText || ""),
    nano: {
      aspect_ratio: String(draft.nano?.aspect_ratio || "match_input_image"),
      resolution: String(draft.nano?.resolution || "4K"),
      output_format: String(draft.nano?.output_format || "jpg"),
      safety_filter_level: String(draft.nano?.safety_filter_level || "block_only_high"),
    },
  };
}

export function createCanvasFlowPromptDraft(options: {
  promptBody: string;
  promptConfig: CanvasFlowPromptConfig;
  frontmatter: Record<string, unknown>;
}): CanvasFlowPromptDraft {
  const defaults = deriveCanvasFlowPromptUiDefaults({
    frontmatter: options.frontmatter,
    promptConfig: options.promptConfig,
  });

  return {
    body: String(options.promptBody || ""),
    explicitModel: String(options.promptConfig.imageModelId || "").trim(),
    seedText:
      options.promptConfig.seed !== null && Number.isFinite(options.promptConfig.seed)
        ? String(Math.floor(options.promptConfig.seed))
        : "",
    imageCount: clampImageCount(defaults.imageCount),
    aspectRatioPreset: String(defaults.preferredAspectRatio || "").trim(),
    widthText: defaults.width !== null ? String(Math.max(1, Math.floor(defaults.width))) : "",
    heightText: defaults.height !== null ? String(Math.max(1, Math.floor(defaults.height))) : "",
    nano: {
      aspect_ratio: String(defaults.nanoDefaults.aspect_ratio || "match_input_image"),
      resolution: String(defaults.nanoDefaults.resolution || "4K"),
      output_format: String(defaults.nanoDefaults.output_format || "jpg"),
      safety_filter_level: String(defaults.nanoDefaults.safety_filter_level || "block_only_high"),
    },
  };
}

export function clampImageCount(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(4, Math.floor(n)));
}

export function parsePositiveInt(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const out = Math.floor(n);
  return out >= 1 ? out : null;
}

function roundDownToMultiple(value: number, multiple: number): number {
  if (!Number.isFinite(value) || value <= 0) return multiple;
  const m = Math.max(1, Math.floor(multiple));
  return Math.max(m, Math.floor(value / m) * m);
}

export function deriveDimensionsFromAspectPreset(options: {
  preset: string;
  widthText: string;
  heightText: string;
}): { widthText: string; heightText: string } {
  const ratioText = String(options.preset || "").trim();
  if (!ratioText) {
    return {
      widthText: String(options.widthText || ""),
      heightText: String(options.heightText || ""),
    };
  }

  const [wStr, hStr] = ratioText.split(":");
  const wRatio = Number(wStr);
  const hRatio = Number(hStr);
  if (!Number.isFinite(wRatio) || !Number.isFinite(hRatio) || wRatio <= 0 || hRatio <= 0) {
    return {
      widthText: String(options.widthText || ""),
      heightText: String(options.heightText || ""),
    };
  }

  const currentW = parsePositiveInt(options.widthText) ?? 0;
  const currentH = parsePositiveInt(options.heightText) ?? 0;
  const baseRaw = Math.max(currentW, currentH, 1024);
  const base = roundDownToMultiple(baseRaw, 8);

  let nextW: number;
  let nextH: number;
  if (wRatio >= hRatio) {
    nextW = base;
    nextH = roundDownToMultiple((base * hRatio) / wRatio, 8);
  } else {
    nextH = base;
    nextW = roundDownToMultiple((base * wRatio) / hRatio, 8);
  }

  nextW = Math.max(64, nextW);
  nextH = Math.max(64, nextH);

  return {
    widthText: String(nextW),
    heightText: String(nextH),
  };
}

export function getEffectiveDraftModel(options: {
  explicitModel: string;
  settingsModelSlug: string;
}): string {
  return (
    String(options.explicitModel || "").trim() ||
    String(options.settingsModelSlug || "").trim() ||
    DEFAULT_IMAGE_GENERATION_MODEL_ID
  );
}

export function getDraftAspectRatioOrDefault(options: {
  draftAspectRatio: string;
  effectiveModel: string;
  serverModels?: readonly ImageGenerationServerCatalogModel[];
}): string {
  return (
    String(options.draftAspectRatio || "").trim() ||
    getDefaultImageAspectRatio(
      String(options.effectiveModel || "").trim() || DEFAULT_IMAGE_GENERATION_MODEL_ID,
      options.serverModels
    )
  );
}
