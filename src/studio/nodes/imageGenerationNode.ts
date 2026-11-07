import { MANAGED_IMAGE_INPUT_MAX_COUNT, MANAGED_IMAGE_OUTPUT_MAX_COUNT } from "../../services/images/ManagedImageGenerationAdapter";
import type {
  StudioImageInput,
  StudioJsonValue,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeExecutionContext,
} from "../types";
import {
  extractImageInputCandidates,
  getText,
  parseStructuredPromptInput,
  resolveStudioImageInput,
  type StudioImageInputCandidate,
} from "./shared";

const IMAGE_PROMPT_MAX_CHARS = 8_000;
/** House default quality. A blank model runs the server's default image model. */
const DEFAULT_IMAGE_QUALITY = "max";
const LOG_PREFIX = "[studio.image_generation]";

const options = (values: readonly string[], labels: Record<string, string> = {}): StudioNodeConfigSelectOption[] =>
  values.map(value => ({ value, label: labels[value] ?? value }));

const QUALITY_OPTIONS = options(["max", "xhigh", "high", "medium", "low", "auto"], {
  max: "Max", xhigh: "Extra high", high: "High", medium: "Medium", low: "Low", auto: "Auto",
});
const ASPECT_RATIO_OPTIONS = options(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"], { auto: "Auto" });
const BACKGROUND_OPTIONS = options(["auto", "transparent", "opaque"], {
  auto: "Auto", transparent: "Transparent", opaque: "Opaque",
});

function resolveImagePrompt(context: StudioNodeExecutionContext): { prompt: string; structuredInputImages: StudioImageInputCandidate[] } {
  const rawPromptInput = context.inputs.prompt;
  const structured = parseStructuredPromptInput(rawPromptInput);
  if (structured.systemPrompt.trim().length > 0) {
    context.log(`${LOG_PREFIX} Ignoring system prompt for node "${context.node.id}". Build prompt strategy upstream in a text-generation node.`);
  }
  // A wired prompt input wins; the node's own Prompt box is the fallback.
  const wiredPrompt = structured.prompt.trim() || getText(rawPromptInput).trim();
  const prompt = wiredPrompt || getText(context.node.config.prompt).trim();
  if (prompt.length > IMAGE_PROMPT_MAX_CHARS) {
    throw new Error(`Image generation accepts prompts up to ${IMAGE_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters. Shorten the prompt before running it.`);
  }
  return { prompt, structuredInputImages: structured.inputImages };
}

/** Distinct references in edge order; extras past the protocol cap are dropped with a log line. */
async function resolveReferenceImages(
  context: StudioNodeExecutionContext,
  structuredInputImages: StudioImageInputCandidate[],
): Promise<StudioImageInput[]> {
  const candidates = [...structuredInputImages, ...extractImageInputCandidates(context.inputs.images)]
    .filter(candidate => String(candidate.path || "").trim());
  const output: StudioImageInput[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const candidate of candidates) {
    const input = await resolveStudioImageInput(context, candidate, `Image generation node "${context.node.id}" received unsupported reference image`);
    if (seen.has(input.asset.hash)) continue;
    if (output.length >= MANAGED_IMAGE_INPUT_MAX_COUNT) { dropped += 1; continue; }
    seen.add(input.asset.hash);
    output.push(input);
  }
  if (dropped > 0) {
    context.log(`${LOG_PREFIX} Received ${output.length + dropped} reference images; using the first ${MANAGED_IMAGE_INPUT_MAX_COUNT}.`);
  }
  return output;
}

function pick(value: StudioJsonValue | undefined, allowed: readonly StudioNodeConfigSelectOption[], fallback?: string): string | undefined {
  const text = getText(value).trim();
  if (!text) return fallback;
  return allowed.some(option => option.value === text) ? text : fallback;
}

export const imageGenerationNode: StudioNodeDefinition = {
  kind: "studio.image_generation",
  version: "1.0.0",
  requiredHostCapabilities: [],
  capabilityClass: "api",
  // A generated image is node state, not a memoized pure function.
  cachePolicy: "never",
  inputPorts: [
    { id: "prompt", type: "text", required: false },
    { id: "images", type: "any", required: false, description: `Optional reference images, up to ${MANAGED_IMAGE_INPUT_MAX_COUNT}.` },
  ],
  outputPorts: [
    { id: "images", type: "json" },
    { id: "generation", type: "json", description: "Model and cost of the last run." },
  ],
  configDefaults: {
    prompt: "",
    model: "",
    quality: DEFAULT_IMAGE_QUALITY,
    aspectRatio: "auto",
    background: "auto",
    count: 1,
  },
  configSchema: {
    fields: [
      {
        key: "prompt", label: "Prompt", type: "textarea", required: false,
        placeholder: "Describe the image, or how to change the connected images.",
      },
      {
        key: "model", label: "Image model", type: "select", required: false,
        selectPresentation: "searchable_dropdown", optionsSource: "image_generation_models",
        description: "Blank uses the SystemSculpt default. Estimates include fees; final cost follows usage.",
      },
      { key: "quality", label: "Quality", type: "select", required: false, selectPresentation: "searchable_dropdown", options: QUALITY_OPTIONS },
      { key: "aspectRatio", label: "Aspect ratio", type: "select", required: false, selectPresentation: "searchable_dropdown", options: ASPECT_RATIO_OPTIONS },
      { key: "background", label: "Background", type: "select", required: false, selectPresentation: "searchable_dropdown", options: BACKGROUND_OPTIONS },
      { key: "count", label: "Images", type: "number", required: true, min: 1, max: MANAGED_IMAGE_OUTPUT_MAX_COUNT, integer: true },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    let lastLoggedStatus = "";
    const result = await context.services.api.generateImage({
      runId: context.runId,
      nodeId: context.node.id,
      projectPath: context.projectPath,
      signal: context.signal,
      storeOutput: context.services.storeAsset,
      onProgress: progress => {
        if (progress.status === lastLoggedStatus) return;
        lastLoggedStatus = progress.status;
        context.log(`${LOG_PREFIX} Job ${progress.status}.`);
      },
      buildPayload: async () => {
        const { prompt, structuredInputImages } = resolveImagePrompt(context);
        if (!prompt) {
          throw new Error(`Image generation node "${context.node.id}" requires a prompt. Type one in the node's Prompt box or connect a text input.`);
        }
        const inputImages = await resolveReferenceImages(context, structuredInputImages);
        const countRaw = Number(context.node.config.count);
        const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(MANAGED_IMAGE_OUTPUT_MAX_COUNT, Math.floor(countRaw)) : 1;
        // Saved projects from the retired card carry a blank model and
        // quality; they run on the server default model at max quality.
        const model = getText(context.node.config.model).trim() || undefined;
        const aspectRatio = pick(context.node.config.aspectRatio, ASPECT_RATIO_OPTIONS);
        const quality = pick(context.node.config.quality, QUALITY_OPTIONS, DEFAULT_IMAGE_QUALITY);
        const background = pick(context.node.config.background, BACKGROUND_OPTIONS);
        return {
          ...(model ? { model } : {}),
          prompt,
          count,
          // "auto" is the server default; omitting it keeps every model happy.
          ...(aspectRatio && aspectRatio !== "auto" ? { aspectRatio } : {}),
          ...(quality ? { quality } : {}),
          ...(background && background !== "auto" ? { background } : {}),
          ...(inputImages.length > 0 ? { inputImages } : {}),
        };
      },
    });
    const usd = Math.round(result.usage.usd * 1_000_000) / 1_000_000;
    context.log(`${LOG_PREFIX} ${result.images.length} image(s) from ${result.model}, $${usd}${result.usage.estimated ? " (estimated)" : ""}.`);
    return {
      outputs: {
        images: result.images,
        generation: { model: result.model, usd, estimated: result.usage.estimated },
      },
      artifacts: result.images,
      managedOperations: [result.operation],
    };
  },
};
