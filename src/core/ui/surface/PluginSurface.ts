export type PluginSurfaceKind = "view" | "modal" | "transient" | "embedded";

const SURFACE_CLASS = "ss-surface";
const SURFACE_ATTRIBUTE = "data-ss-surface";

/**
 * Applies the shared visual contract to a feature-owned root.
 *
 * The feature keeps ownership of the element and its lifecycle. A root's host
 * kind is immutable so CSS adaptation stays predictable across rerenders.
 */
export function applyPluginSurface(
  root: HTMLElement,
  kind: PluginSurfaceKind,
): void {
  if (!root || root.nodeType !== 1) {
    throw new TypeError("Plugin surface root must be an HTMLElement");
  }

  const existingKind = root.getAttribute(SURFACE_ATTRIBUTE);
  if (existingKind && existingKind !== kind) {
    throw new Error(
      `Plugin surface is already mounted as ${existingKind}; it cannot become ${kind}`,
    );
  }

  root.classList.add(SURFACE_CLASS);
  root.setAttribute(SURFACE_ATTRIBUTE, kind);
}

export function isPluginSurface(
  root: Element,
  kind?: PluginSurfaceKind,
): boolean {
  if (!root.classList.contains(SURFACE_CLASS)) {
    return false;
  }

  const mountedKind = root.getAttribute(SURFACE_ATTRIBUTE);
  return kind ? mountedKind === kind : mountedKind !== null;
}
