import type { App } from "obsidian";
import { resolveStudioAssetPreviewSrc } from "./canvas/StudioGraphMediaPreviewModal";

type Preview = { path: string; src: string | null };

/** A file reference can arrive before its bytes. Resolve once after checking
 * local availability, and let vault events wake missing previews. Each view
 * owns its queue and tears it down with the surface. */
export class StudioAssetPreviewController {
  private readonly previews = new Map<string, Preview>();
  private readonly queue: Preview[] = [];
  private active = 0;
  private disposed = false;
  constructor(
    private readonly app: App,
    private readonly changed: () => void,
    private readonly restore?: (path: string) => Promise<boolean>
  ) {}

  resolve(path: string): string | null {
    if (this.disposed || !path || path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.split(/[\\/]/).some(part => part === "..")) return null;
    const existing = this.previews.get(path);
    if (existing) return existing.src;
    const preview: Preview = { path, src: null };
    this.previews.set(path, preview);
    this.queue.push(preview);
    this.drain();
    return null;
  }

  invalidate(path: string): void {
    if (!this.disposed && this.previews.delete(path)) this.changed();
  }

  reject(path: string): void {
    const preview = this.previews.get(path);
    if (preview) preview.src = null;
  }

  dispose(): void { this.disposed = true; this.previews.clear(); this.queue.length = 0; }

  private drain(): void {
    while (!this.disposed && this.active < 4 && this.queue.length > 0) {
      const preview = this.queue.shift()!;
      if (this.previews.get(preview.path) !== preview) continue;
      this.active += 1;
      void this.load(preview).finally(() => { this.active -= 1; this.drain(); });
    }
  }

  private async load(preview: Preview): Promise<void> {
    try {
      const available = await this.app.vault.adapter.exists(preview.path) || await this.restore?.(preview.path);
      if (!available || this.disposed || this.previews.get(preview.path) !== preview) return;
      preview.src = resolveStudioAssetPreviewSrc(this.app, preview.path);
      if (preview.src) this.changed();
    } catch { /* Missing or not yet readable: the next vault event retries. */ }
  }
}
