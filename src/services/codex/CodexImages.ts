import { TFile, type App } from 'obsidian';
import type { AgentToolPart } from '../../chat/ChatConversation';
import { desktopHost } from '../../platform/desktopOnly';
import type { SystemSculptMedia } from '../../tools/systemsculpt/SystemSculptTools';
import { base64ToBytes, isBase64 } from '../../utils/base64';
import { GENERATED_IMAGES_FOLDER, saveGeneratedMedia, sniffImageMimeType } from '../../utils/generatedMedia';
import { isRecord } from '../../utils/jsonRecord';
import { nativeToolPath } from '../../utils/nativeToolPath';
import type { LocalAgentToolUpdate } from './LocalAgentChatSession';

/** Codex items that make or show an image. */
const IMAGE_ITEMS = new Set(['imageGeneration', 'imageView']);
const MARKER = 'systemsculpt_tool';
/** Codex keeps its own copy of every generated image here. */
const GENERATED_DIRECTORY = /[\\/]\.codex[\\/]generated_images[\\/]/u;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** Whether a path is Codex's own copy of an image it generated. */
export function isCodexGeneratedImagePath(path: string): boolean {
  return GENERATED_DIRECTORY.test(path);
}

export function isCodexImageItem(item: unknown): boolean {
  return isRecord(item) && IMAGE_ITEMS.has(String(item.type));
}

/** Codex reports image paths as absolute paths or file:// URLs. */
export function codexImageLocalPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  if (!value.startsWith('file://')) return value;
  try {
    const path = decodeURIComponent(new URL(value).pathname);
    return /^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** The vault copy Chat made of each Codex image, by the path Codex reported. */
const vaultCopies = new Map<string, string>();
/** Saved chats write the home folder as ~, so Codex's own images match by their place under generated_images. */
function comparable(path: string): string {
  const portable = path.replace(/\\/gu, '/');
  const generated = /\/\.codex\/generated_images\/(.+)$/u.exec(portable);
  return generated ? `codex-generated:${generated[1]}` : portable;
}
export function rememberCodexImage(sourcePath: string, vaultPath: string): void {
  vaultCopies.set(comparable(sourcePath), vaultPath);
}
/** The vault copy of a Codex image path, for links in the reply. */
export function codexImageVaultPath(link: string): string | null {
  const path = codexImageLocalPath(link.startsWith('file://') ? link : safeDecode(link));
  return path ? vaultCopies.get(comparable(path)) ?? null : null;
}
function safeDecode(value: string): string {
  try { return decodeURI(value); } catch { return value; }
}

export type CodexImageMedia = Readonly<{ item: 'imageGeneration' | 'imageView'; media: SystemSculptMedia; sourcePath?: string }>;

/** The vault image a finished Codex image item points at, live or from a saved chat. */
export function codexImageMedia(part: AgentToolPart): CodexImageMedia | null {
  if (part.native?.agent !== 'codex' || part.state !== 'succeeded') return null;
  const item = isRecord(part.input) ? String(part.input.type) : '';
  if (item !== 'imageGeneration' && item !== 'imageView') return null;
  // A live part holds the result itself; a saved chat nests it under data.
  const outer = isRecord(part.output?.data) ? part.output.data : {};
  const result = outer[MARKER] === 1 ? outer : isRecord(outer.data) && outer.data[MARKER] === 1 ? outer.data : null;
  const media = Array.isArray(result?.media) && isRecord(result.media[0]) ? result.media[0] : null;
  if (!media || typeof media.path !== 'string' || !media.path.trim()) return null;
  const sourcePath = typeof result?.sourcePath === 'string' ? result.sourcePath : undefined;
  return {
    item, sourcePath,
    media: { kind: 'image', path: media.path, ...(typeof media.mimeType === 'string' ? { mimeType: media.mimeType } : {}) },
  };
}

/**
 * Saves the images Codex makes into the vault so Chat can show and link them.
 * Codex writes generated images outside the vault; viewing one already in the
 * vault copies nothing.
 */
export class CodexImageImporter {
  private readonly pending = new Map<string, Promise<string>>();
  constructor(private readonly app: App, private readonly now: () => Date = () => new Date()) {}

  /** The update with the vault image as its output, or unchanged when there is none. */
  async present(update: LocalAgentToolUpdate, item: Record<string, unknown>, workingDirectory: string): Promise<LocalAgentToolUpdate> {
    if (update.state !== 'succeeded') return update;
    try {
      const found = item.type === 'imageGeneration' ? await this.generated(item) : await this.viewed(item, workingDirectory);
      if (!found) {
        // A generation with no file must still end, or Chat would wait on "Saving image" all turn.
        return item.type === 'imageGeneration' ? { ...update, output: { summary: 'Codex returned no image file.' } } : update;
      }
      const media: SystemSculptMedia = { kind: 'image', path: found.path, mimeType: found.mimeType };
      const message = `Saved to the vault: ${found.path}`;
      return { ...update, output: { summary: message, data: { [MARKER]: 1, ok: true, message, media: [media], ...(found.sourcePath ? { sourcePath: found.sourcePath } : {}) } } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ...update, output: { summary: `The image could not be saved to the vault: ${reason}` } };
    }
  }

  private async generated(item: Record<string, unknown>): Promise<{ path: string; mimeType: string; sourcePath?: string } | null> {
    const sourcePath = codexImageLocalPath(item.savedPath) ?? undefined;
    const inline = typeof item.result === 'string' && isBase64(item.result) ? item.result : null;
    if (!sourcePath && !inline) return null;
    // Codex's saved file is preferred; the inline copy covers a file that can't be read.
    const load = async () => {
      if (!sourcePath) return base64ToBytes(inline!);
      try { return await this.readOutside(sourcePath); } catch (error) { if (inline) return base64ToBytes(inline); throw error; }
    };
    // Codex rewrites the request into a long instruction prompt, so the file name stays plain.
    return this.copy(sourcePath ?? `codex-result:${String(item.id)}`, 'Codex image', load).then(copy => ({ ...copy, ...(sourcePath ? { sourcePath } : {}) }));
  }

  private async viewed(item: Record<string, unknown>, workingDirectory: string): Promise<{ path: string; mimeType: string; sourcePath?: string } | null> {
    const sourcePath = codexImageLocalPath(item.path);
    if (!sourcePath) return null;
    const key = comparable(sourcePath);
    const known = vaultCopies.get(key) ?? await this.pending.get(key)?.catch(() => undefined);
    if (known && this.app.vault.getAbstractFileByPath(known) instanceof TFile) return { path: known, mimeType: mimeOf(known), sourcePath };
    // The person moved or deleted the copy, so it is copied again.
    if (known) { vaultCopies.delete(key); this.pending.delete(key); }
    const basePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
    const inVault = nativeToolPath(sourcePath, workingDirectory, workingDirectory, basePath).vaultPath;
    if (inVault) return this.app.vault.getAbstractFileByPath(inVault) instanceof TFile ? { path: inVault, mimeType: mimeOf(inVault) } : null;
    // Only Codex's own generated images are copied in; other outside files stay where they are.
    if (!isCodexGeneratedImagePath(sourcePath)) return null;
    const real = await (await desktopHost.fs()).realpath(sourcePath).catch(() => null);
    if (!real || !isCodexGeneratedImagePath(real) || /[\\/]\.\.?[\\/]/u.test(real)) return null;
    const copy = await this.copy(sourcePath, 'Codex image', () => this.readOutside(real));
    return { ...copy, sourcePath };
  }

  private copy(key: string, prompt: string, load: () => Promise<Uint8Array>): Promise<{ path: string; mimeType: string }> {
    const id = comparable(key);
    let saving = this.pending.get(id);
    if (!saving) {
      saving = (async () => {
        const bytes = await load();
        const mimeType = sniffImageMimeType(bytes);
        if (!mimeType) throw new Error('the file is not a PNG, JPEG, WebP or GIF image');
        const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer as ArrayBuffer : bytes.slice().buffer;
        const path = await saveGeneratedMedia(this.app, { folder: GENERATED_IMAGES_FOLDER, prompt, bytes: buffer, mimeType, now: this.now() });
        if (!key.startsWith('codex-result:')) rememberCodexImage(key, path);
        return path;
      })();
      this.pending.set(id, saving);
      saving.catch(() => this.pending.delete(id));
    }
    return saving.then(path => ({ path, mimeType: mimeOf(path) }));
  }

  private async readOutside(path: string): Promise<Uint8Array> {
    const fs = await desktopHost.fs();
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('the image is missing or too large');
    return new Uint8Array(await fs.readFile(path));
  }
}

function mimeOf(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/png';
}
