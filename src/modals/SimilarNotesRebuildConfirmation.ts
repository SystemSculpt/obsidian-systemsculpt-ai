import type { App } from "obsidian";
import { showConfirm } from "../core/ui/notifications";

/** The one confirmation before either rebuild entry point replaces the Similar notes index. */
export async function confirmSimilarNotesRebuild(app: App): Promise<boolean> {
  const { confirmed } = await showConfirm(
    app,
    "Replace the current Similar notes index and process eligible vault notes again?",
    {
      title: "Rebuild Similar notes index",
      primaryButton: "Rebuild",
      secondaryButton: "Cancel",
      icon: "alert-triangle",
    },
  );
  return confirmed;
}
