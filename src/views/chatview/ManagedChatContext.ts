import { TFile, type App } from "obsidian";
import { isVaultImageContextFileExtension } from "../../constants/fileTypes";
import { thinAgentDataUrl } from "../../chat/managed/MessageAdapter";
import type { MeasuredThinAgentContext, ThinAgentContextSource } from "../../services/managed/ThinAgentV1Contract";
import type { ThinAgentInputLimits } from "../../services/managed/ThinAgentInputLimits";

function imageMimeType(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  return "image/png";
}

/** Reads and measures pinned sources against the current negotiated limits. */
export async function readPinnedChatContext(
  app: App,
  pinnedEntries: ReadonlySet<string>,
  getLimits: () => ThinAgentInputLimits,
): Promise<MeasuredThinAgentContext> {
  const sources: ThinAgentContextSource[] = [];
  const imageMimeTypes = new Set<string>();
  let largestTextBlockBytes = 0;
  let textBytes = 0;
  let largestImageBytes = 0;
  let imageBytes = 0;
  let imageCount = 0;
  for (const entry of pinnedEntries) {
    if (sources.length >= getLimits().maxContentBlocksPerMessage) {
      throw new Error("Pinned files exceed the per-message source limit.");
    }
    if (entry.startsWith("doc:")) {
      const documentId = entry.slice(4).trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(documentId)) {
        throw new Error("A pinned document reference is invalid.");
      }
      if (entry.length > 1_024 || entry.includes("\0")) {
        throw new Error("A pinned document path is invalid.");
      }
      sources.push({
        kind: "document_ref",
        path: entry,
        document_id: documentId,
      });
      continue;
    }
    const linkPath = entry.replace(/^\[\[(.*?)\]\]$/, "$1").trim();
    const resolved = app.metadataCache.getFirstLinkpathDest(linkPath, "")
      ?? app.vault.getAbstractFileByPath(linkPath)
      ?? (!linkPath.endsWith(".md")
        ? app.vault.getAbstractFileByPath(`${linkPath}.md`)
        : null);
    if (!(resolved instanceof TFile)) {
      throw new Error(`Pinned file not found: ${linkPath}`);
    }
    if (resolved.path.length > 1_024 || resolved.path.includes("\0")) {
      throw new Error(`${resolved.name} has an invalid context path.`);
    }
    if (isVaultImageContextFileExtension(resolved.extension)) {
      imageCount += 1;
      if (imageCount > getLimits().maxImagesPerTurn) {
        throw new Error("Pinned files exceed the per-message image count limit.");
      }
      const mimeType = imageMimeType(resolved.extension);
      if (!getLimits().imageMimeTypes.includes(mimeType)) {
        throw new Error(`${resolved.name} is not a supported pinned image type.`);
      }
      if (resolved.stat.size > getLimits().maxImageBytes) {
        throw new Error(`${resolved.name} exceeds the pinned image limit.`);
      }
      const bytes = new Uint8Array(await app.vault.readBinary(resolved));
      // These sources are sent without being parsed again, so this is the
      // one place their sizes are measured. Check the bytes actually read,
      // not only the possibly stale stat.
      if (bytes.byteLength === 0) {
        throw new Error(`${resolved.name} is an empty image.`);
      }
      if (bytes.byteLength > getLimits().maxImageBytes) {
        throw new Error(`${resolved.name} exceeds the pinned image limit.`);
      }
      imageMimeTypes.add(mimeType);
      largestImageBytes = Math.max(largestImageBytes, bytes.byteLength);
      imageBytes += bytes.byteLength;
      if (imageBytes > getLimits().maxTotalImageBytes) {
        throw new Error("Pinned images exceed the total per-message image limit.");
      }
      sources.push({
        kind: "image",
        path: resolved.path,
        data_url: thinAgentDataUrl(mimeType, bytes),
      });
    } else {
      const content = await app.vault.read(resolved);
      const byteLength = new TextEncoder().encode(content).byteLength;
      if (byteLength > getLimits().maxTextBytesPerBlock) {
        throw new Error(`${resolved.name} exceeds the pinned text file limit.`);
      }
      largestTextBlockBytes = Math.max(largestTextBlockBytes, byteLength);
      textBytes += new TextEncoder().encode(resolved.path).byteLength + byteLength;
      if (textBytes > getLimits().maxTotalTextBytes) {
        throw new Error("Pinned files exceed the total per-message text limit.");
      }
      sources.push({ kind: "text", path: resolved.path, content });
    }
  }
  return {
    sources,
    measurement: {
      largestTextBlockBytes,
      totalTextBytes: textBytes,
      imageCount,
      largestImageBytes,
      totalImageBytes: imageBytes,
      imageMimeTypes: [...imageMimeTypes],
    },
  };
}
