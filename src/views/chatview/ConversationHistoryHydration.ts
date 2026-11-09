import { createSurfaceElement } from "../../core/ui/surface";
import type { MessagePart } from "../../types";

type ActivityTarget = Readonly<{
  element: HTMLDetailsElement;
  summary: HTMLElement;
  body: HTMLElement;
}>;

type HydrationStatus = "cold" | "hydrating" | "hydrated" | "disposed";

type DeferredHistory = {
  activity: ActivityTarget;
  parts: readonly MessagePart[];
  status: HydrationStatus;
  staging: HTMLElement | null;
  hydration: Promise<void> | null;
};

type HistoryHydrationOptions = Readonly<{
  renderTimeline: (
    parent: HTMLElement,
    parts: readonly MessagePart[],
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  forgetMarkdown: (target: HTMLElement) => void;
  /** Runs once a fold's rows are in place. */
  activityHydrated?: (element: HTMLDetailsElement) => void;
  beginLayoutMutation?: (
    control?: HTMLElement,
    target?: HTMLElement,
  ) => (() => void) | undefined;
}>;

/**
 * Owns deferred durable activity, not live part rendering. Visibility and
 * removal invalidate detached work without cancelling or adopting an active turn.
 */
export class ConversationHistoryHydration {
  private readonly entries = new Map<HTMLElement, DeferredHistory>();
  private generation = 0;
  private visible = true;
  private pending = 0;

  constructor(private readonly options: HistoryHydrationOptions) {}

  public get pendingCount(): number {
    return this.pending;
  }

  public wasHydrated(element: HTMLElement): boolean {
    return this.entries.get(element)?.status === "hydrated";
  }

  public deferActivity(activity: ActivityTarget, parts: readonly MessagePart[]): void {
    this.defer(activity, parts);
    activity.element.addEventListener("toggle", () => {
      if (activity.element.open) void this.hydrate(activity.element)?.catch(() => undefined);
    });
  }

  public hydrate(element: HTMLElement): Promise<void> | null {
    const state = this.entries.get(element);
    if (!state || state.status === "hydrated" || state.status === "disposed") return null;
    if (state.hydration) return state.hydration;
    if (!this.visible) return null;

    this.setStatus(state, "hydrating");
    const generation = this.generation;
    const staging = createSurfaceElement(element.ownerDocument, "div");
    state.staging = staging;
    const isCurrent = (): boolean =>
      this.visible
      && generation === this.generation
      && state.status !== "disposed"
      && this.entries.get(element) === state;
    const discardStaging = (): void => {
      this.options.forgetMarkdown(staging);
      if (state.status !== "disposed") this.setStatus(state, "cold");
    };
    let hydration!: Promise<void>;
    hydration = (async (): Promise<void> => {
      try {
        const rendered = await this.options.renderTimeline(staging, state.parts, isCurrent);
        if (!rendered || !isCurrent()) {
          discardStaging();
          return;
        }
        const { summary, body } = state.activity;
        const finishLayoutMutation = this.options.beginLayoutMutation?.(
          summary.isConnected ? summary : undefined,
          body,
        );
        try {
          if (!isCurrent()) {
            discardStaging();
            return;
          }
          body.replaceChildren(...Array.from(staging.childNodes));
          state.staging = null;
          this.setStatus(state, "hydrated");
          this.options.activityHydrated?.(state.activity.element);
        } finally {
          finishLayoutMutation?.();
        }
      } catch (error) {
        discardStaging();
        throw error;
      } finally {
        if (state.status === "hydrating") this.setStatus(state, "cold");
        if (state.staging === staging) state.staging = null;
        if (state.hydration === hydration) state.hydration = null;
      }
    })();
    state.hydration = hydration;
    return hydration;
  }

  public setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.generation += 1;
  }

  public forgetWithin(target: HTMLElement): void {
    for (const element of this.entries.keys()) {
      if (element === target || target.contains(element)) this.forget(element);
    }
  }

  public clear(): void {
    this.generation += 1;
    for (const element of this.entries.keys()) this.forget(element);
  }

  private defer(activity: ActivityTarget, parts: readonly MessagePart[]): void {
    this.forget(activity.element);
    this.entries.set(activity.element, { activity, parts, status: "cold", staging: null, hydration: null });
  }

  private forget(element: HTMLElement): void {
    const state = this.entries.get(element);
    if (!state) return;
    this.setStatus(state, "disposed");
    this.entries.delete(element);
    if (state.staging) this.options.forgetMarkdown(state.staging);
    state.staging = null;
  }

  private setStatus(state: DeferredHistory, status: HydrationStatus): void {
    if (state.status === status) return;
    if (state.status === "hydrating") this.pending -= 1;
    state.status = status;
    if (status === "hydrating") this.pending += 1;
  }
}
