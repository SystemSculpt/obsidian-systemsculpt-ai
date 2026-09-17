import type SystemSculptPlugin from "../../../main";
import type { StudioMediaModelKind } from "../../../studio/StudioMediaModelCapabilities";

/**
 * Favorites are stored per media kind so an image model starred in one node
 * never reorders the video picker. Ids are opaque server catalog ids; a
 * retired model simply stops matching and its entry becomes inert.
 */
function settingsKey(kind: StudioMediaModelKind): "favoriteImageModels" | "favoriteVideoModels" {
  return kind === "image" ? "favoriteImageModels" : "favoriteVideoModels";
}

export function readMediaModelFavorites(plugin: SystemSculptPlugin, kind: StudioMediaModelKind): string[] {
  const stored = plugin.settings[settingsKey(kind)];
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
}

/** Toggles one model and resolves to its new favorite state. */
export async function toggleMediaModelFavorite(plugin: SystemSculptPlugin, kind: StudioMediaModelKind, modelId: string): Promise<boolean> {
  const current = readMediaModelFavorites(plugin, kind);
  const nextState = !current.includes(modelId);
  const updated = nextState ? [...current, modelId] : current.filter(id => id !== modelId);
  await plugin.getSettingsManager().updateSettings({ [settingsKey(kind)]: updated });
  return nextState;
}
