/** Pause decorative motion, not execution, when its owning surface cannot be seen. */
export function bindSurfaceActivity(root: HTMLElement): () => void {
  let detachOwner = () => {};

  const bindOwner = () => {
    detachOwner();
    const document = root.ownerDocument;
    const ownerWindow = document.defaultView;
    if (!ownerWindow) return;

    let focused = document.hasFocus();
    let intersecting = true;
    const refresh = () => {
      root.classList.toggle("ss-motion-paused", !focused
        || document.visibilityState === "hidden"
        || !intersecting
        || !root.isShown());
    };
    const focus = () => { focused = true; refresh(); };
    const blur = () => { focused = false; refresh(); };
    const observer = typeof ownerWindow.IntersectionObserver === "function"
      ? new ownerWindow.IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.target === root) intersecting = entry.isIntersecting;
        }
        refresh();
      })
      : null;
    observer?.observe(root);
    ownerWindow.addEventListener("focus", focus);
    ownerWindow.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", refresh);
    refresh();

    detachOwner = () => {
      observer?.disconnect();
      ownerWindow.removeEventListener("focus", focus);
      ownerWindow.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", refresh);
    };
  };

  bindOwner();
  const detachMigration = root.onWindowMigrated?.(bindOwner);
  return () => {
    detachMigration?.();
    detachOwner();
    root.classList.remove("ss-motion-paused");
  };
}
