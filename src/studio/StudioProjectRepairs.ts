import { sanitizeGraphGroups } from "./StudioGraphGroupModel";
import {
  cleanupStaleManagedOutputPlaceholders,
  removeManagedTextOutputNodes,
} from "./StudioManagedOutputNodes";
import type { StudioProjectV1 } from "./types";

export function normalizeLegacyMediaNodeTitles(project: StudioProjectV1): boolean {
  let changed = false;
  for (const node of project.graph.nodes) {
    if (node.kind !== "studio.media_ingest") {
      continue;
    }
    const currentTitle = String(node.title || "").trim();
    if (!currentTitle || currentTitle === "Media Ingest") {
      node.title = "Media";
      changed = true;
    }
  }
  return changed;
}

export function repairStudioProjectForLoad(project: StudioProjectV1): boolean {
  let changed = false;
  changed = sanitizeGraphGroups(project) || changed;
  changed = normalizeLegacyMediaNodeTitles(project) || changed;
  changed = cleanupStaleManagedOutputPlaceholders(project).changed || changed;
  changed = removeManagedTextOutputNodes({ project }).changed || changed;
  return changed;
}
