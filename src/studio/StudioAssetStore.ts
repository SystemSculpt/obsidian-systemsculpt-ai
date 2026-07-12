import { normalizePath } from "obsidian";
import { deriveStudioAssetBlobDir } from "./paths";
import { sha256HexFromArrayBuffer } from "./hash";
import type { StudioAssetRef } from "./types";
import { StudioProjectStore } from "./StudioProjectStore";

function mimeToExtension(mimeType: string): string {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("svg")) return "svg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("ogg")) return "ogg";
  return "bin";
}

export class StudioAssetStore {
  constructor(private readonly projectStore: StudioProjectStore) {}

  async storeArrayBuffer(projectPath: string, bytes: ArrayBuffer, mimeType: string): Promise<StudioAssetRef> {
    const project = await this.projectStore.loadProject(projectPath);
    const hash = await sha256HexFromArrayBuffer(bytes);
    const blobDir = deriveStudioAssetBlobDir(projectPath);
    const relativePath = normalizePath(`${blobDir}/${hash.slice(0, 2)}/${hash}.${mimeToExtension(mimeType)}`);
    const generationPath = this.projectStore.supportRelativePath(projectPath, relativePath);
    await this.projectStore.commitSupportFiles(projectPath, project.projectId, "asset", (files) => {
      if (!files.has(generationPath)) files.set(generationPath, new Uint8Array(bytes.slice(0)));
    });
    return { hash, mimeType: String(mimeType || "application/octet-stream"), sizeBytes: bytes.byteLength, path: relativePath };
  }

  async readArrayBuffer(asset: StudioAssetRef, projectPath?: string): Promise<ArrayBuffer> {
    const bytes = projectPath
      ? await this.projectStore.readSupportFile(projectPath, asset.path)
      : await this.projectStore.readSupportFileByAbsolutePath(asset.path);
    if (!bytes) throw new Error(`Studio asset not found: ${asset.path}`);
    return bytes.slice().buffer;
  }
}
