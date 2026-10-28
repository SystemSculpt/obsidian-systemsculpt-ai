import type { App } from "obsidian";
import { getSurfaceOwnerWindow } from "../../core/ui/surface/SurfaceDomContext";
import type { AgentChatSessionOptions } from "../../chat/managed/ChatSession";

/** Owns visibility observation and its rebinding when an Obsidian pane moves windows. */
export function chatRecoveryEnvironment(
  app: App,
  containerEl: HTMLElement,
): NonNullable<AgentChatSessionOptions["recoveryEnvironment"]> {
  return {
    ownerWindow: () => getSurfaceOwnerWindow(containerEl),
    isVisible: () => containerEl.isShown(),
    subscribe: (refresh) => {
      let observer: IntersectionObserver | null = null;
      const observe = () => {
        observer?.disconnect();
        const owner = containerEl.ownerDocument.defaultView;
        observer = typeof owner?.IntersectionObserver === "function"
          ? new owner.IntersectionObserver(refresh) : null;
        observer?.observe(containerEl);
        refresh();
      };
      observe();
      const detachMigration = containerEl.onWindowMigrated?.(observe);
      const leafEvent = app.workspace.on("active-leaf-change", refresh);
      return () => {
        observer?.disconnect();
        detachMigration?.();
        app.workspace.offref(leafEvent);
      };
    },
  };
}
