import { App, normalizePath } from "obsidian";
import { deriveStudioAssetBlobDir } from "./paths";
import { sha256HexFromArrayBuffer } from "./hash";
import type { StudioAssetRef } from "./types";

type BinaryAdapter = {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
  readBinary?: (path: string) => Promise<ArrayBuffer>;
};

function mimeToExtension(mimeType: string): string {
  const normalized = String(mimeType || "").toLowerCase();
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

async function ensureDir(adapter: BinaryAdapter, path: string): Promise<void> {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    try {
      const exists = await adapter.exists(current);
      if (!exists) {
        await adapter.mkdir(current);
      }
    } catch {}
  }
}

export class StudioAssetStore {
  private readonly adapter: BinaryAdapter;

  constructor(app: App) {
    this.adapter = app.vault.adapter as unknown as BinaryAdapter;
  }

  async storeArrayBuffer(
    projectPath: string,
    bytes: ArrayBuffer,
    mimeType: string
  ): Promise<StudioAssetRef> {
    const hash = await sha256HexFromArrayBuffer(bytes);
    const blobDir = deriveStudioAssetBlobDir(projectPath);
    const shard = hash.slice(0, 2);
    const extension = mimeToExtension(mimeType);
    const relativePath = normalizePath(`${blobDir}/${shard}/${hash}.${extension}`);

    await ensureDir(this.adapter, normalizePath(`${blobDir}/${shard}`));
    const exists = await this.adapter.exists(relativePath);
    if (!exists) {
      if (typeof this.adapter.writeBinary !== "function") {
        throw new Error("Binary writes are unavailable on this adapter.");
      }
      await this.adapter.writeBinary(relativePath, bytes);
    }

    return {
      hash,
      mimeType: String(mimeType || "application/octet-stream"),
      sizeBytes: bytes.byteLength,
      path: relativePath,
    };
  }

  async readArrayBuffer(asset: StudioAssetRef): Promise<ArrayBuffer> {
    if (typeof this.adapter.readBinary === "function") {
      return this.adapter.readBinary(asset.path);
    }

    throw new Error("Binary reads are unavailable on this adapter.");
  }
}
