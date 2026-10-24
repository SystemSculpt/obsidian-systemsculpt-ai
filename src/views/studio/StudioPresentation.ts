/**
 * Owns a leaf's presentation-only subscriptions and clocks. Hidden cards keep
 * their DOM and local controls, but release their observers. Showing reads the
 * current source once instead of replaying every update received while hidden.
 * Execution and persistence must never be registered here.
 */
export class StudioPresentation {
  private visible = true;
  private readonly bindings = new Set<{ start: () => void; stop: () => void }>();

  isVisible(): boolean { return this.visible; }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    for (const binding of this.bindings) {
      if (visible) binding.start();
      else binding.stop();
    }
  }

  watch(paint: () => void, subscribe: (refresh: () => void) => () => void): { refresh: () => void; dispose: () => void } {
    let disposed = false;
    let detach: (() => void) | null = null;
    // Async load completions use this same gate, including after card removal.
    const refresh = (): void => { if (!disposed && this.visible) paint(); };
    const binding = {
      start: (): void => { detach = subscribe(refresh); refresh(); },
      stop: (): void => { detach?.(); detach = null; },
    };
    this.bindings.add(binding);
    if (this.visible) binding.start();
    return {
      refresh,
      dispose: () => { disposed = true; binding.stop(); this.bindings.delete(binding); },
    };
  }
}
