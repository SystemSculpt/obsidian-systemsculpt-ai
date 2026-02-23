import { dirname } from "node:path";
import type {
  StudioJsonValue,
  StudioNodeDefinition,
  StudioNodeExecutionContext,
} from "../types";
import { getText, inferMimeTypeFromPath, isLikelyAbsolutePath } from "./shared";

const AUDIO_OUTPUT_FORMATS = ["wav", "mp3", "m4a", "ogg"] as const;
type AudioOutputFormat = (typeof AUDIO_OUTPUT_FORMATS)[number];

function audioCodecArgsForFormat(format: AudioOutputFormat): string[] {
  switch (format) {
    case "wav":
      return ["-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000"];
    case "mp3":
      return ["-acodec", "libmp3lame", "-ac", "1", "-ar", "16000", "-b:a", "64k"];
    case "m4a":
      return ["-acodec", "aac", "-ac", "1", "-ar", "16000", "-b:a", "64k"];
    case "ogg":
      return ["-acodec", "libvorbis", "-ac", "1", "-ar", "16000", "-b:a", "64k"];
    default:
      return ["-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000"];
  }
}

function parseAudioOutputFormat(value: StudioJsonValue | undefined): AudioOutputFormat {
  const normalized = getText(value).trim().toLowerCase();
  return AUDIO_OUTPUT_FORMATS.includes(normalized as AudioOutputFormat)
    ? (normalized as AudioOutputFormat)
    : "m4a";
}

function replacePathExtension(path: string, extension: string): string {
  const trimmed = String(path || "").trim();
  const normalizedExtension = String(extension || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "");
  if (!trimmed || !normalizedExtension) {
    return trimmed;
  }

  const candidate = /[\\/]+$/.test(trimmed) ? `${trimmed}audio` : trimmed;
  const lastSeparator = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("\\"));
  const directory = lastSeparator >= 0 ? candidate.slice(0, lastSeparator + 1) : "";
  const fileName = lastSeparator >= 0 ? candidate.slice(lastSeparator + 1) : candidate;
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName || "audio";
  return `${directory}${baseName}.${normalizedExtension}`;
}

function deriveAudioOutputPath(options: {
  configuredOutputPath: string;
  sourcePathHint: string;
  outputFormat: AudioOutputFormat;
}): string {
  const configuredOutputPath = String(options.configuredOutputPath || "").trim();
  if (configuredOutputPath) {
    return replacePathExtension(configuredOutputPath, options.outputFormat);
  }
  const sourcePathHint = String(options.sourcePathHint || "").trim();
  if (!sourcePathHint) {
    return "";
  }
  return replacePathExtension(sourcePathHint, options.outputFormat);
}

async function extractAudioAsset(
  context: StudioNodeExecutionContext,
  options?: {
    ffmpegCommand?: string;
    sourcePath: string;
    outputFormat?: AudioOutputFormat;
    outputPath?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  }
): Promise<{ outputPath: string }> {
  const configuredFfmpegCommand = String(options?.ffmpegCommand || "ffmpeg").trim() || "ffmpeg";
  const ffmpegCommand = /^ffmpeg$/i.test(configuredFfmpegCommand)
    ? "ffmpeg"
    : configuredFfmpegCommand;
  const sourcePath = String(options?.sourcePath || "").trim();
  if (!sourcePath || !isLikelyAbsolutePath(sourcePath)) {
    throw new Error("Audio extraction requires an absolute source path.");
  }
  const outputFormat = options?.outputFormat || "m4a";
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? Math.max(100, Number(options?.timeoutMs)) : 120_000;
  const maxOutputBytes = Number.isFinite(options?.maxOutputBytes)
    ? Math.max(1024, Number(options?.maxOutputBytes))
    : 512 * 1024;
  const preferredOutputPath = String(options?.outputPath || "").trim() || replacePathExtension(sourcePath, outputFormat);
  if (!preferredOutputPath || !isLikelyAbsolutePath(preferredOutputPath)) {
    throw new Error("Audio extraction requires an absolute output path.");
  }
  const sourceMimeType = inferMimeTypeFromPath(sourcePath);

  if (!sourceMimeType.startsWith("video/") && !sourceMimeType.startsWith("audio/")) {
    throw new Error(
      `Audio extraction requires audio/* or video/* input. Received "${sourceMimeType || "unknown"}".`
    );
  }

  const args = [
    "-y",
    "-i",
    sourcePath,
    "-vn",
    ...audioCodecArgsForFormat(outputFormat),
    preferredOutputPath,
  ];

  let result: Awaited<ReturnType<typeof context.services.runCli>>;
  try {
    result = await context.services.runCli({
      command: ffmpegCommand,
      args,
      cwd: dirname(sourcePath),
      timeoutMs,
      maxOutputBytes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/i.test(message)) {
      throw new Error(
        `FFmpeg command "${ffmpegCommand}" was not found. Install ffmpeg and/or set Audio Extract -> FFmpeg Command to an installed binary (for example "ffmpeg" or "/opt/homebrew/bin/ffmpeg").`
      );
    }
    throw error;
  }

  if (result.timedOut) {
    throw new Error("Audio extraction timed out while running ffmpeg.");
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Audio extraction failed (exit ${result.exitCode}). ${result.stderr || result.stdout || "No process output."}`
    );
  }

  return {
    outputPath: preferredOutputPath,
  };
}

export const audioExtractNode: StudioNodeDefinition = {
  kind: "studio.audio_extract",
  version: "1.0.0",
  capabilityClass: "local_io",
  cachePolicy: "by_inputs",
  inputPorts: [{ id: "path", type: "text", required: true }],
  outputPorts: [{ id: "path", type: "text" }],
  configDefaults: {
    ffmpegCommand: "ffmpeg",
    outputFormat: "m4a",
    outputPath: "",
    timeoutMs: 120_000,
    maxOutputBytes: 512 * 1024,
  },
  configSchema: {
    fields: [
      {
        key: "ffmpegCommand",
        label: "FFmpeg Command",
        type: "text",
        required: true,
        placeholder: "ffmpeg",
      },
      {
        key: "outputFormat",
        label: "Output Format",
        type: "select",
        required: true,
        options: [
          { value: "m4a", label: "M4A" },
          { value: "mp3", label: "MP3" },
          { value: "wav", label: "WAV" },
          { value: "ogg", label: "OGG" },
        ],
      },
      {
        key: "outputPath",
        label: "Output Path",
        type: "text",
        required: false,
        placeholder: "Optional. Defaults to source path + selected output extension.",
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "number",
        required: true,
        min: 100,
        integer: true,
      },
      {
        key: "maxOutputBytes",
        label: "Max Process Output Bytes",
        type: "number",
        required: true,
        min: 1024,
        integer: true,
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const sourcePathInput = getText(context.inputs.path).trim();
    if (!sourcePathInput) {
      throw new Error(`Audio extract node "${context.node.id}" requires a path input.`);
    }
    const sourcePath = context.services.resolveAbsolutePath(sourcePathInput);
    const outputFormat = parseAudioOutputFormat(context.node.config.outputFormat as StudioJsonValue);
    const configuredOutputPathRaw = getText(context.node.config.outputPath as StudioJsonValue).trim();
    const configuredOutputPath = configuredOutputPathRaw
      ? context.services.resolveAbsolutePath(configuredOutputPathRaw)
      : "";
    const preferredOutputPath = deriveAudioOutputPath({
      configuredOutputPath,
      sourcePathHint: sourcePath,
      outputFormat,
    });
    const outputPath = context.services.resolveAbsolutePath(preferredOutputPath);

    const extraction = await extractAudioAsset(context, {
      ffmpegCommand: getText(context.node.config.ffmpegCommand as StudioJsonValue).trim() || "ffmpeg",
      sourcePath,
      outputFormat,
      outputPath,
      timeoutMs: Number(context.node.config.timeoutMs as StudioJsonValue),
      maxOutputBytes: Number(context.node.config.maxOutputBytes as StudioJsonValue),
    });

    return {
      outputs: {
        path: extraction.outputPath,
      },
    };
  },
};
