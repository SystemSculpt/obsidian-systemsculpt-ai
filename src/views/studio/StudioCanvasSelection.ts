export type StudioCanvasItemKind = "node" | "shape" | "arrow" | "group";

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/** One canvas selection. Groups are focused as frames, never mixed with their members. */
export class StudioCanvasSelection {
  private readonly selected = new Map<StudioCanvasItemKind, ReadonlySet<string>>();
  private readonly listeners = new Set<() => void>();

  ids(kind: StudioCanvasItemKind): ReadonlySet<string> {
    return this.selected.get(kind) ?? EMPTY_SELECTION;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replace(kind: StudioCanvasItemKind, ids: Iterable<string>): void {
    const next = new Set([...ids].map(id => id.trim()).filter(Boolean));
    const previous = this.ids(kind);
    let changed = next.size !== previous.size || [...next].some(id => !previous.has(id));
    if (next.size > 0) {
      if (kind === "group") {
        for (const other of ["node", "shape", "arrow"] as const) {
          changed = this.selected.delete(other) || changed;
        }
      } else {
        changed = this.selected.delete("group") || changed;
      }
    }
    if (!changed) return;
    if (next.size) this.selected.set(kind, next);
    else this.selected.delete(kind);
    this.notify();
  }

  selectOnly(kind: StudioCanvasItemKind, id: string): void {
    const normalized = id.trim();
    if (this.selected.size === 1 && this.ids(kind).size === 1 && this.ids(kind).has(normalized)) return;
    this.selected.clear();
    if (normalized) this.selected.set(kind, new Set([normalized]));
    this.notify();
  }

  toggle(kind: StudioCanvasItemKind, id: string): void {
    const next = new Set(this.ids(kind));
    if (!next.delete(id)) next.add(id);
    this.replace(kind, next);
  }

  remove(kind: StudioCanvasItemKind, id: string): void {
    const next = new Set(this.ids(kind));
    if (next.delete(id)) this.replace(kind, next);
  }

  clear(kind?: StudioCanvasItemKind): void {
    if (kind) {
      this.replace(kind, []);
    } else if (this.selected.size) {
      this.selected.clear();
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
