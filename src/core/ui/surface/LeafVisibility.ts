import type { Workspace } from "obsidian";

/** Observe the leaf, not the active tab or focused window: split panes can both be shown. */
export function observeLeafVisibility(
  root: HTMLElement,
  workspace: Workspace,
  onChange: (visible: boolean) => void,
): () => void {
  let visible: boolean | undefined;
  let zeroSize = false;
  let disposed = false;
  let detachOwner = () => {};
  const refresh = () => {
    if (disposed) return;
    const next = root.isShown() && !zeroSize && root.ownerDocument.visibilityState !== "hidden";
    if (next === visible) return;
    visible = next;
    onChange(next);
  };
  const bindOwner = () => {
    detachOwner();
    zeroSize = false;
    const document = root.ownerDocument;
    const ownerWindow = document.defaultView;
    const observer = typeof ownerWindow?.ResizeObserver === "function"
      ? new ownerWindow.ResizeObserver(entries => {
        for (const entry of entries) {
          if (entry.target === root) zeroSize = entry.contentRect.width === 0 || entry.contentRect.height === 0;
        }
        refresh();
      })
      : null;
    observer?.observe(root);
    document.addEventListener("visibilitychange", refresh);
    ownerWindow?.addEventListener("focus", refresh);
    ownerWindow?.addEventListener("blur", refresh);
    detachOwner = () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", refresh);
      ownerWindow?.removeEventListener("focus", refresh);
      ownerWindow?.removeEventListener("blur", refresh);
    };
    refresh();
  };
  const activeLeaf = workspace.on("active-leaf-change", refresh);
  const layout = workspace.on("layout-change", refresh);
  const detachMigration = root.onWindowMigrated?.(bindOwner);
  bindOwner();
  return () => {
    disposed = true;
    workspace.offref(activeLeaf);
    workspace.offref(layout);
    detachMigration?.();
    detachOwner();
  };
}
