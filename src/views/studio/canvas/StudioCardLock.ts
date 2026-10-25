/**
 * A card's interaction lock: on while a graph run is in progress, and always
 * on for a pending output placeholder. Controls apply it now and again
 * whenever it changes, so a run starting or ending patches a mounted card in
 * place instead of remounting it. A plain boolean is a lock that never
 * changes (tests and one-off surfaces).
 * @internal Tests type their fixtures with this.
 */
export type StudioCardLock = {
  readonly locked: boolean;
  /** Runs `apply` now and on every change; `owner` leaving the card's DOM ends the watch. */
  watch: (apply: (locked: boolean) => void, owner?: Element) => void;
};

export type StudioCardLockState = boolean | StudioCardLock;

export type StudioCardLockController = StudioCardLock & {
  set: (locked: boolean) => void;
};

export function isStudioCardLocked(state: StudioCardLockState): boolean {
  return typeof state === "boolean" ? state : state.locked;
}

export function watchStudioCardLock(
  state: StudioCardLockState,
  apply: (locked: boolean) => void,
  owner?: Element
): void {
  if (typeof state === "boolean") apply(state);
  else state.watch(apply, owner);
}

/** Keeps a control disabled while the card is locked, and always when `alsoDisabled`. */
export function lockStudioControl(
  state: StudioCardLockState,
  control: Element & { disabled: boolean },
  alsoDisabled = false
): void {
  watchStudioCardLock(state, (locked) => {
    control.disabled = locked || alsoDisabled;
  }, control);
}

/**
 * `root` is the card: a watch whose owner was removed from it (a re-rendered
 * row, say) is dropped on the next change.
 */
export function createStudioCardLock(locked: boolean, root?: Element): StudioCardLockController {
  let current = locked;
  const watchers = new Map<(locked: boolean) => void, Element | undefined>();
  return {
    get locked() {
      return current;
    },
    watch(apply, owner) {
      watchers.set(apply, owner);
      apply(current);
    },
    set(next) {
      if (next === current) return;
      current = next;
      for (const [apply, owner] of watchers) {
        if (owner && root && !root.contains(owner)) {
          watchers.delete(apply);
          continue;
        }
        apply(next);
      }
    },
  };
}
