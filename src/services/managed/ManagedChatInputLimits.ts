import type {
  ManagedCapabilityCatalogContract,
  ManagedCapabilityDescriptor,
} from "./ManagedTypes";

const MEBIBYTE = 1024 * 1024;

/**
 * Limits needed before a turn is admitted. The bootstrap values are the
 * conservative floor of the pinned managed-chat contract; a fetched catalog
 * replaces them as soon as the Chat view opens.
 */
export type ManagedChatInputLimits = Readonly<{
  imageMimeTypes: readonly string[];
  maxContentBlocksPerMessage: number;
  maxImagesPerTurn: number;
  maxImageBytes: number;
  maxTotalImageBytes: number;
  maxTextBytesPerBlock: number;
  maxTotalTextBytes: number;
  maxCreateRequestBytes: number;
  maxDeltaRequestBytes: number;
  maxToolsJsonBytes: number;
  maxDocumentBytes: number;
}>;

export const DEFAULT_MANAGED_CHAT_INPUT_LIMITS: ManagedChatInputLimits = Object.freeze({
  imageMimeTypes: Object.freeze(["image/png", "image/jpeg", "image/webp"]),
  maxContentBlocksPerMessage: 16,
  maxImagesPerTurn: 6,
  maxImageBytes: 6 * MEBIBYTE,
  maxTotalImageBytes: 16 * MEBIBYTE,
  maxTextBytesPerBlock: 1 * MEBIBYTE,
  maxTotalTextBytes: 2 * MEBIBYTE,
  maxCreateRequestBytes: 24 * MEBIBYTE,
  maxDeltaRequestBytes: 24 * MEBIBYTE,
  maxToolsJsonBytes: 512 * 1024,
  maxDocumentBytes: 25 * MEBIBYTE,
});

function requiredPositiveInteger(
  descriptor: ManagedCapabilityDescriptor,
  key: string,
): number {
  const value = descriptor.limits[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Managed capability ${descriptor.alias} has an invalid ${key} limit.`);
  }
  return value as number;
}

function optionalPositiveInteger(
  descriptor: ManagedCapabilityDescriptor,
  key: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(descriptor.limits, key)) return undefined;
  return requiredPositiveInteger(descriptor, key);
}

function descriptorFor(
  catalog: ManagedCapabilityCatalogContract,
  alias: ManagedCapabilityDescriptor["alias"],
): ManagedCapabilityDescriptor {
  const descriptor = catalog.capabilities.find((entry) => entry.alias === alias);
  if (!descriptor || descriptor.availability !== "available") {
    throw new Error(`Managed capability ${alias} is unavailable.`);
  }
  return descriptor;
}

/** Maps the server-advertised catalog into the one UI/wire limit model. */
export function managedChatInputLimitsFromCatalog(
  catalog: ManagedCapabilityCatalogContract,
): ManagedChatInputLimits {
  const chat = descriptorFor(catalog, "systemsculpt/chat");
  const documents = descriptorFor(catalog, "systemsculpt/documents");
  const imageMimeTypes = String(chat.limits.image_mime_types ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (imageMimeTypes.length === 0 || new Set(imageMimeTypes).size !== imageMimeTypes.length) {
    throw new Error("Managed chat has invalid image MIME limits.");
  }
  const maxCreateRequestBytes = requiredPositiveInteger(chat, "max_request_bytes");
  const maxDeltaRequestBytes = optionalPositiveInteger(chat, "max_delta_request_bytes")
    ?? maxCreateRequestBytes;
  const maxDocumentBytes = optionalPositiveInteger(documents, "max_input_bytes")
    ?? DEFAULT_MANAGED_CHAT_INPUT_LIMITS.maxDocumentBytes;
  return Object.freeze({
    imageMimeTypes: Object.freeze(imageMimeTypes),
    maxContentBlocksPerMessage: requiredPositiveInteger(chat, "max_content_blocks_per_message"),
    maxImagesPerTurn: requiredPositiveInteger(chat, "max_images_per_turn"),
    maxImageBytes: requiredPositiveInteger(chat, "max_image_bytes"),
    maxTotalImageBytes: requiredPositiveInteger(chat, "max_total_image_bytes"),
    maxTextBytesPerBlock: requiredPositiveInteger(chat, "max_text_bytes_per_block"),
    maxTotalTextBytes: requiredPositiveInteger(chat, "max_total_text_bytes"),
    maxCreateRequestBytes,
    maxDeltaRequestBytes,
    maxToolsJsonBytes: requiredPositiveInteger(chat, "max_tools_json_bytes"),
    maxDocumentBytes,
  });
}
