import type { CanvasFlowPromptConfig } from "./PromptNote";
import {
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  formatImageAspectRatioLabel,
  getDefaultImageAspectRatio,
  getRecommendedImageAspectRatios,
  getSupportedImageAspectRatios,
  type ImageGenerationServerCatalogModel,
} from "./ImageGenerationModelCatalog";

export type CanvasFlowNanoDefaults = {
  aspect_ratio: string;
  resolution: string;
  output_format: string;
  safety_filter_level: string;
};

export type CanvasFlowPromptUiDefaults = {
  imageCount: number;
  width: number | null;
  height: number | null;
  preferredAspectRatio: string;
  nanoDefaults: CanvasFlowNanoDefaults;
};

type SelectOptionSpec = {
  value: string;
  text: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function inferAspectRatioPreset(width: number | null, height: number | null): string {
  if (width === null || height === null) return "";
  if (width <= 0 || height <= 0) return "";

  const ratio = width / height;
  const closeTo = (target: number) => Math.abs(ratio - target) <= 0.01;
  if (closeTo(1)) return "1:1";
  if (closeTo(4 / 3)) return "4:3";
  if (closeTo(3 / 4)) return "3:4";
  if (closeTo(16 / 9)) return "16:9";
  if (closeTo(9 / 16)) return "9:16";
  return "";
}

export function deriveCanvasFlowPromptUiDefaults(options: {
  frontmatter: Record<string, unknown>;
  promptConfig: CanvasFlowPromptConfig;
}): CanvasFlowPromptUiDefaults {
  const imageOptionsRaw = readRecord(options.frontmatter["ss_image_options"]);
  const imageCount = Math.max(1, Math.min(4, Math.floor(options.promptConfig.imageCount || 1)));
  const widthFromFrontmatter = readNumber(options.frontmatter["ss_image_width"]);
  const heightFromFrontmatter = readNumber(options.frontmatter["ss_image_height"]);
  const width = widthFromFrontmatter ?? readNumber(imageOptionsRaw["width"]);
  const height = heightFromFrontmatter ?? readNumber(imageOptionsRaw["height"]);

  const nanoDefaults: CanvasFlowNanoDefaults = {
    aspect_ratio: readString(imageOptionsRaw["aspect_ratio"]) || "match_input_image",
    resolution: readString(imageOptionsRaw["resolution"]) || "4K",
    output_format: readString(imageOptionsRaw["output_format"]) || "jpg",
    safety_filter_level: readString(imageOptionsRaw["safety_filter_level"]) || "block_only_high",
  };

  const preferredAspectRatio =
    String(options.promptConfig.aspectRatio || "").trim() || inferAspectRatioPreset(width, height) || "";

  return {
    imageCount,
    width,
    height,
    preferredAspectRatio,
    nanoDefaults,
  };
}

function buildAspectRatioOptionSpecs(supported: readonly string[], recommended: readonly string[]): SelectOptionSpec[] {
  return supported.map((ratio) => {
    const label = formatImageAspectRatioLabel(ratio);
    return {
      value: ratio,
      text: recommended.includes(ratio) ? `${label} (Recommended)` : label,
    };
  });
}

function readSelectOptionSpecs(select: HTMLSelectElement): SelectOptionSpec[] {
  const out: SelectOptionSpec[] = [];
  for (let i = 0; i < select.options.length; i += 1) {
    const option = select.options[i];
    if (!option) continue;
    out.push({
      value: String(option.value || ""),
      text: String(option.text || ""),
    });
  }
  return out;
}

function equalOptionSpecs(a: readonly SelectOptionSpec[], b: readonly SelectOptionSpec[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].value !== b[i].value) return false;
    if (a[i].text !== b[i].text) return false;
  }
  return true;
}

function setSelectOptions(select: HTMLSelectElement, options: readonly SelectOptionSpec[]): void {
  while (select.options.length > 0) {
    select.remove(0);
  }
  for (const option of options) {
    select.createEl("option", { value: option.value, text: option.text });
  }
}

function isElementFocused(el: HTMLElement | null): boolean {
  if (!el) return false;
  const doc = el.ownerDocument;
  if (!doc) return false;
  return doc.activeElement === el;
}

export function syncCanvasFlowAspectRatioPresetControls(options: {
  select: HTMLSelectElement | null;
  modelId: string;
  preferred: string;
  helpEl?: HTMLElement | null;
  serverModels?: readonly ImageGenerationServerCatalogModel[];
  deferWhileFocused?: boolean;
}): string {
  const select = options.select;
  if (!select) {
    if (options.helpEl && options.helpEl.textContent !== "") options.helpEl.setText("");
    return "";
  }

  const modelId = String(options.modelId || "").trim() || DEFAULT_IMAGE_GENERATION_MODEL_ID;
  const preferred = String(options.preferred || "").trim();
  const supported = getSupportedImageAspectRatios(modelId, options.serverModels);
  const recommended = getRecommendedImageAspectRatios(modelId, options.serverModels);
  const defaultRatio = getDefaultImageAspectRatio(modelId, options.serverModels);
  const shouldDeferMutations = options.deferWhileFocused === true && isElementFocused(select);
  const desiredOptions = buildAspectRatioOptionSpecs(supported, recommended);
  const currentOptions = readSelectOptionSpecs(select);
  const optionsChanged = !equalOptionSpecs(currentOptions, desiredOptions);

  if (optionsChanged && !shouldDeferMutations) {
    setSelectOptions(select, desiredOptions);
    delete select.dataset.ssCanvasflowAspectSyncDeferred;
  } else if (optionsChanged && shouldDeferMutations) {
    select.dataset.ssCanvasflowAspectSyncDeferred = "true";
  } else if (!shouldDeferMutations && select.dataset.ssCanvasflowAspectSyncDeferred === "true") {
    delete select.dataset.ssCanvasflowAspectSyncDeferred;
  }

  const selected = supported.includes(preferred) ? preferred : defaultRatio;
  if (selected && !shouldDeferMutations && select.value !== selected) {
    select.value = selected;
  }

  if (options.helpEl) {
    const recommendedText = recommended.map((ratio) => formatImageAspectRatioLabel(ratio)).join(" | ");
    const defaultText = formatImageAspectRatioLabel(defaultRatio);
    const helpText =
      recommendedText
        ? `Recommended: ${recommendedText}. Default: ${defaultText}.`
        : `Default: ${defaultText}.`;
    if (options.helpEl.textContent !== helpText) {
      options.helpEl.setText(helpText);
    }
  }

  return selected;
}
