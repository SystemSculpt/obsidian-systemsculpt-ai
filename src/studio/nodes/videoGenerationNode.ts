import type {
  StudioAssetRef,
  StudioNodeDefinition,
  StudioNodeExecutionContext,
  StudioVideoFrameInput,
} from "../types";
import {
  extractImageInputCandidates,
  getText,
  inferMimeTypeFromPath,
  isLikelyAbsolutePath,
  parseStructuredPromptInput,
  type StudioImageInputCandidate,
} from "./shared";

const VIDEO_PROMPT_MAX_CHARS = 8_000;
const VIDEO_DURATION_MAX_SECONDS = 60;
const RESOLUTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

function normalizeFrameMimeType(mimeType: string): "image/png" | "image/jpeg" | "image/webp" | null {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/webp") return "image/webp";
  return null;
}

function asExistingAssetRef(candidate: StudioImageInputCandidate): StudioAssetRef | null {
  const hash = String(candidate.hash || "").trim().toLowerCase();
  const path = String(candidate.path || "").trim();
  const sizeRaw = Number(candidate.sizeBytes);
  const sizeBytes = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0;
  const mimeType = normalizeFrameMimeType(String(candidate.mimeType || ""));
  if (!hash || !path || !sizeBytes || !mimeType) return null;
  return { hash, mimeType, sizeBytes, path };
}

function validateVideoPromptLength(prompt: string): string {
  const trimmed = String(prompt || "").trim();
  if (trimmed.length > VIDEO_PROMPT_MAX_CHARS) {
    throw new Error(`Video generation accepts prompts up to ${VIDEO_PROMPT_MAX_CHARS.toLocaleString("en-US")} characters. Shorten the prompt before running it.`);
  }
  return trimmed;
}

function resolveVideoPrompt(context: StudioNodeExecutionContext): string {
  const rawPromptInput = context.inputs.prompt;
  const structured = parseStructuredPromptInput(rawPromptInput);
  if (structured.systemPrompt.trim().length > 0) {
    context.log(
      `[studio.video_generation] Ignoring system prompt for node "${context.node.id}". Build prompt strategy upstream in a text-generation node.`
    );
  }
  // A wired prompt input wins; the node's own Prompt box is the fallback so
  // the node runs standalone without an upstream text node.
  const wiredPrompt = structured.prompt.trim() || getText(rawPromptInput).trim();
  const configuredPrompt = getText(context.node.config.prompt).trim();
  return validateVideoPromptLength(wiredPrompt || configuredPrompt);
}

async function resolveFrame(
  context: StudioNodeExecutionContext,
  portId: "first_frame" | "last_frame",
): Promise<StudioVideoFrameInput | null> {
  const candidates = extractImageInputCandidates(context.inputs[portId]);
  const candidate = candidates.find(entry => String(entry.path || "").trim());
  if (!candidate) return null;
  if (candidates.length > 1) {
    context.log(`[studio.video_generation] Port "${portId}" received ${candidates.length} images; using the first one.`);
  }

  const existing = asExistingAssetRef(candidate);
  if (existing) {
    return { role: portId, asset: existing, load: () => context.services.readAsset(existing) };
  }

  const sourcePath = String(candidate.path || "").trim();
  const mimeHint =
    normalizeFrameMimeType(String(candidate.mimeType || "")) ||
    normalizeFrameMimeType(inferMimeTypeFromPath(sourcePath));
  if (!mimeHint) {
    throw new Error(
      `Video generation node "${context.node.id}" received unsupported ${portId.replace("_", " ")} format "${sourcePath}". Use PNG, JPEG, or WEBP.`
    );
  }

  let bytes: ArrayBuffer;
  if (isLikelyAbsolutePath(sourcePath)) {
    context.services.assertFilesystemPath(sourcePath);
    bytes = await context.services.readLocalFileBinary(sourcePath);
  } else {
    bytes = await context.services.readVaultBinary(sourcePath);
  }
  const stored = await context.services.storeAsset(bytes, mimeHint);
  return { role: portId, asset: stored, load: () => context.services.readAsset(stored) };
}

export const videoGenerationNode: StudioNodeDefinition = {
  kind: "studio.video_generation",
  version: "1.0.0",
  requiredHostCapabilities: [],
  capabilityClass: "api",
  // A generated clip is node state, not a memoized pure function.
  cachePolicy: "never",
  inputPorts: [
    { id: "prompt", type: "text", required: false },
    { id: "first_frame", type: "any", required: false, description: "Optional still image the video starts from." },
    { id: "last_frame", type: "any", required: false, description: "Optional still image the video ends on." },
  ],
  outputPorts: [{ id: "videos", type: "json" }],
  configDefaults: {
    prompt: "",
    model: "",
    durationSeconds: "",
    resolution: "",
    aspectRatio: "",
    generateAudio: true,
  },
  configSchema: {
    fields: [
      {
        key: "prompt",
        label: "Prompt",
        type: "textarea",
        required: false,
        placeholder: "Describe the video to generate. A wired prompt input overrides this.",
      },
      {
        key: "model", label: "Video model", type: "select", required: true,
        selectPresentation: "model_picker_modal", optionsSource: "video_generation_models",
        description: "Choose an available model. Estimates include the SystemSculpt service fee; the final charge follows actual usage. Frame images can add cost.",
      },
      {
        // Durations, resolutions and aspect ratios are model-specific, so the
        // options come from the server catalog for the selected model.
        key: "durationSeconds", label: "Duration", type: "select", required: false,
        selectPresentation: "searchable_dropdown", optionsSource: "video_generation_durations",
      },
      {
        key: "resolution", label: "Resolution", type: "select", required: false,
        selectPresentation: "searchable_dropdown", optionsSource: "video_generation_resolutions",
      },
      {
        key: "aspectRatio", label: "Aspect ratio", type: "select", required: false,
        selectPresentation: "searchable_dropdown", optionsSource: "video_generation_aspect_ratios",
      },
      {
        key: "generateAudio", label: "Generate audio", type: "boolean", required: false,
        description: "Generate a soundtrack when the model supports audio.",
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    let lastLoggedStatus = "";
    const result = await context.services.api.generateVideo({
      runId: context.runId,
      nodeId: context.node.id,
      projectPath: context.projectPath,
      signal: context.signal,
      storeOutput: context.services.storeAsset,
      onProgress: progress => {
        if (progress.status === lastLoggedStatus) return;
        lastLoggedStatus = progress.status;
        const typical = progress.typicalDurationMs
          ? ` (typically ~${Math.max(1, Math.round(progress.typicalDurationMs / 1000))}s)`
          : "";
        context.log(`[studio.video_generation] Job ${progress.status}${typical}.`);
      },
      buildPayload: async () => {
        const prompt = resolveVideoPrompt(context);
        if (!prompt) {
          throw new Error(
            `Video generation node "${context.node.id}" requires a prompt. Type one in the node's Prompt box or connect a text input.`
          );
        }
        const model = getText(context.node.config.model).trim();
        if (!model) {
          throw new Error(`Video generation node "${context.node.id}" requires a model. Pick one in the node's Video model picker.`);
        }
        const frames: StudioVideoFrameInput[] = [];
        for (const port of ["first_frame", "last_frame"] as const) {
          const frame = await resolveFrame(context, port);
          if (frame) frames.push(frame);
        }
        // Blank selections are omitted so the server applies the model's own
        // defaults instead of a guess that another model would reject.
        const durationRaw = Number(getText(context.node.config.durationSeconds).trim());
        const durationSeconds = Number.isFinite(durationRaw) && durationRaw > 0
          ? Math.min(VIDEO_DURATION_MAX_SECONDS, Math.floor(durationRaw))
          : undefined;
        const resolutionRaw = getText(context.node.config.resolution).trim();
        const resolution = RESOLUTION_PATTERN.test(resolutionRaw) ? resolutionRaw : undefined;
        const aspectRatio = getText(context.node.config.aspectRatio).trim() || undefined;
        const generateAudioRaw = context.node.config.generateAudio;
        return {
          model,
          prompt,
          ...(durationSeconds === undefined ? {} : { durationSeconds }),
          ...(resolution === undefined ? {} : { resolution }),
          ...(aspectRatio === undefined ? {} : { aspectRatio }),
          ...(typeof generateAudioRaw === "boolean" ? { generateAudio: generateAudioRaw } : {}),
          ...(frames.length > 0 ? { frameImages: frames } : {}),
        };
      },
    });
    return {
      outputs: { videos: result.videos },
      artifacts: result.videos,
      managedOperations: [result.operation],
    };
  },
};
