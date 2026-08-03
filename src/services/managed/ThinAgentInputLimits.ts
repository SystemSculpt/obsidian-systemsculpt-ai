const MEBIBYTE = 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export type ThinAgentInputLimits = Readonly<{
  imageMimeTypes: readonly string[];
  maxContentBlocksPerMessage: number;
  maxImagesPerTurn: number;
  maxImageBytes: number;
  maxTotalImageBytes: number;
  maxTextBytesPerBlock: number;
  maxTotalTextBytes: number;
  maxDocumentBytes: number;
}>;

export const DEFAULT_THIN_AGENT_INPUT_LIMITS: ThinAgentInputLimits = Object.freeze({
  imageMimeTypes: Object.freeze(["image/png", "image/jpeg", "image/webp"]),
  maxContentBlocksPerMessage: 16,
  maxImagesPerTurn: 6,
  maxImageBytes: 6 * MEBIBYTE,
  maxTotalImageBytes: 16 * MEBIBYTE,
  maxTextBytesPerBlock: 1 * MEBIBYTE,
  maxTotalTextBytes: 2 * MEBIBYTE,
  maxDocumentBytes: 25 * MEBIBYTE,
});

const CLIENT_SAFETY_CEILINGS = Object.freeze({
  maxContentBlocksPerMessage: 64,
  maxImagesPerTurn: 24,
  maxImageBytes: 32 * MEBIBYTE,
  maxTotalImageBytes: 64 * MEBIBYTE,
  maxTextBytesPerBlock: 8 * MEBIBYTE,
  maxTotalTextBytes: 16 * MEBIBYTE,
  maxDocumentBytes: 100 * MEBIBYTE,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(
  value: unknown,
  field: keyof typeof CLIENT_SAFETY_CEILINGS,
): number {
  const ceiling = CLIENT_SAFETY_CEILINGS[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > ceiling) {
    throw new Error(`Thin agent input limit ${field} is invalid.`);
  }
  return value as number;
}

export function parseThinAgentInputLimits(value: unknown): ThinAgentInputLimits {
  const required = [
    "image_mime_types",
    "max_content_blocks_per_message",
    "max_images_per_turn",
    "max_image_bytes",
    "max_total_image_bytes",
    "max_text_bytes_per_block",
    "max_total_text_bytes",
    "max_document_bytes",
  ] as const;
  if (!isRecord(value)
    || !required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !(required as readonly string[]).includes(key))
    || !Array.isArray(value.image_mime_types)) {
    throw new Error("Thin agent input limits are malformed.");
  }
  const imageMimeTypes = value.image_mime_types.map((entry) =>
    typeof entry === "string" ? entry.trim().toLowerCase() : "");
  if (imageMimeTypes.length < 1
    || imageMimeTypes.some((entry) => !SUPPORTED_IMAGE_MIME_TYPES.has(entry))
    || new Set(imageMimeTypes).size !== imageMimeTypes.length) {
    throw new Error("Thin agent image MIME limits are invalid.");
  }
  const parsed = {
    imageMimeTypes: Object.freeze(imageMimeTypes),
    maxContentBlocksPerMessage: boundedInteger(
      value.max_content_blocks_per_message,
      "maxContentBlocksPerMessage",
    ),
    maxImagesPerTurn: boundedInteger(value.max_images_per_turn, "maxImagesPerTurn"),
    maxImageBytes: boundedInteger(value.max_image_bytes, "maxImageBytes"),
    maxTotalImageBytes: boundedInteger(value.max_total_image_bytes, "maxTotalImageBytes"),
    maxTextBytesPerBlock: boundedInteger(
      value.max_text_bytes_per_block,
      "maxTextBytesPerBlock",
    ),
    maxTotalTextBytes: boundedInteger(value.max_total_text_bytes, "maxTotalTextBytes"),
    maxDocumentBytes: boundedInteger(value.max_document_bytes, "maxDocumentBytes"),
  };
  if (parsed.maxTotalImageBytes < parsed.maxImageBytes
    || parsed.maxTotalTextBytes < parsed.maxTextBytesPerBlock
    || parsed.maxImagesPerTurn > parsed.maxContentBlocksPerMessage) {
    throw new Error("Thin agent aggregate input limits are inconsistent.");
  }
  return Object.freeze(parsed);
}

export function thinAgentInputLimitsWireValue(
  limits: ThinAgentInputLimits,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    image_mime_types: Object.freeze([...limits.imageMimeTypes]),
    max_content_blocks_per_message: limits.maxContentBlocksPerMessage,
    max_images_per_turn: limits.maxImagesPerTurn,
    max_image_bytes: limits.maxImageBytes,
    max_total_image_bytes: limits.maxTotalImageBytes,
    max_text_bytes_per_block: limits.maxTextBytesPerBlock,
    max_total_text_bytes: limits.maxTotalTextBytes,
    max_document_bytes: limits.maxDocumentBytes,
  });
}
